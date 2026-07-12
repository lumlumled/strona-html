// Jednorazowe wyrównanie etapu wycen: wszystkie WYCENY (typ WYCENA) dostają
// etap FORM_SENT = "Link wysłany". Historyczne wyceny miały etap NEW/pusty
// (import z Make), przez co panel Wyceny pokazywał je jako "Nowa" — a link do
// formularza realnie poszedł do klienta dawno temu. Ustawiamy więc bazową
// prawdę: dla wycen "Link wysłany".
//
// Bezpieczeństwo: DOMYŚLNIE dry-run (nic nie zapisuje, tylko wypisuje co by
// zrobił). Prawdziwy zapis dopiero z flagą --apply.
//   node scripts/wyceny-mark-form-sent.js           # podgląd
//   node scripts/wyceny-mark-form-sent.js --apply    # zapis do prod
//
// Dotyczy WYŁĄCZNIE typu WYCENA (nie ZAMÓWIENIE = sprzedaże, nie NOTATKA).
// Nie cofa wycen, które są DALEJ w pipeline (SUBMITTED, PROFORMA_SENT, PAID,
// SHIPPED, DELIVERED, INVOICED) — te pomijamy, bo cofnięcie ich do "link
// wysłany" byłoby regresją. Aktualizujemy tylko puste / NEW / ERROR.
const path = require('path');
const FORM_SERVER = path.join(__dirname, '..', 'apps', 'formularz', 'server');
require(path.join(__dirname, '..', 'node_modules', 'dotenv')).config({ path: path.join(FORM_SERVER, '.env') });
const { createClient } = require(path.join(__dirname, '..', 'node_modules', '@supabase/supabase-js'));

const APPLY = process.argv.includes('--apply');
// Etapy, których NIE ruszamy (są dalej niż "link wysłany").
const KEEP_STAGES = ['SUBMITTED', 'PROFORMA_SENT', 'PAID', 'SHIPPED', 'DELIVERED', 'INVOICED'];

async function main() {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: wyceny, error } = await db
    .from('wyceny')
    .select('id, process_stage, status')
    .eq('typ', 'WYCENA');
  if (error) throw error;

  const doZmiany = (wyceny || []).filter((w) => !KEEP_STAGES.includes(w.process_stage) && w.process_stage !== 'FORM_SENT');
  const juzWyslane = (wyceny || []).filter((w) => w.process_stage === 'FORM_SENT');
  const dalej = (wyceny || []).filter((w) => KEEP_STAGES.includes(w.process_stage));
  const ids = doZmiany.map((w) => w.id);

  console.log(`Wycen (typ WYCENA) łącznie: ${(wyceny || []).length}`);
  console.log(`  już FORM_SENT: ${juzWyslane.length}`);
  console.log(`  dalej w pipeline (pomijane): ${dalej.length}`);
  console.log(`Do oznaczenia jako FORM_SENT ("Link wysłany"): ${ids.length}`);
  if (ids.length) console.log(`  ID: ${ids.slice(0, 60).join(', ')}${ids.length > 60 ? ' …' : ''}`);

  if (!APPLY) {
    console.log('\n[dry-run] Nic nie zapisano. Uruchom z --apply, żeby zapisać do prod.');
    return;
  }

  let updated = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { error: uErr } = await db.from('wyceny')
      .update({ process_stage: 'FORM_SENT', updated_at: new Date().toISOString() })
      .in('id', chunk);
    if (uErr) throw uErr;
    updated += chunk.length;
  }

  console.log(`\n[apply] Wyceny oznaczone FORM_SENT: ${updated}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
