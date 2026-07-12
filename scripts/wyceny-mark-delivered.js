// Jednorazowe wymuszenie porządku w Sprzedażach: wszystkie historyczne
// zamówienia (typ ZAMÓWIENIE) oznaczamy jako DOSTARCZONE, bo dawno doszły.
// Dzięki temu panel Sprzedaże (Do wysłania / Wysłane / Zamknięte) startuje z
// czystą listą "Do wysłania". Docelowo dostarczenie ma sprawdzać worker z
// trackingu — to tylko jednorazowy backfill.
//
// Bezpieczeństwo: DOMYŚLNIE dry-run (nic nie zapisuje, tylko wypisuje co by
// zrobił). Prawdziwy zapis dopiero z flagą --apply.
//   node scripts/wyceny-mark-delivered.js           # podgląd
//   node scripts/wyceny-mark-delivered.js --apply    # zapis do prod
//
// Nie rusza rekordów już DELIVERED/INVOICED (nie cofa dalszych etapów) ani
// statusu Open/Fulfilled/Closed. Zamknięte (status Closed) i tak trafiają do
// sekcji "Zamknięte" niezależnie od etapu.
const path = require('path');
const FORM_SERVER = path.join(__dirname, '..', 'apps', 'formularz', 'server');
require(path.join(__dirname, '..', 'node_modules', 'dotenv')).config({ path: path.join(FORM_SERVER, '.env') });
const { createClient } = require(path.join(__dirname, '..', 'node_modules', '@supabase/supabase-js'));

const APPLY = process.argv.includes('--apply');
const SKIP_STAGES = ['DELIVERED', 'INVOICED'];
// --exclude 1875,1876 — ID pominięte (np. zamówienia testowe do skasowania).
const excludeArg = process.argv[process.argv.indexOf('--exclude') + 1];
const EXCLUDE_IDS = new Set(
  (process.argv.includes('--exclude') ? String(excludeArg || '') : '')
    .split(',').map((x) => Number(x.trim())).filter(Number.isFinite)
);

async function main() {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: zamowienia, error } = await db
    .from('wyceny')
    .select('id, process_stage, status, created_at')
    .eq('typ', 'ZAMÓWIENIE');
  if (error) throw error;

  const doZmiany = (zamowienia || [])
    .filter((w) => !SKIP_STAGES.includes(w.process_stage))
    .filter((w) => !EXCLUDE_IDS.has(w.id));
  const ids = doZmiany.map((w) => w.id);

  console.log(`Zamówień łącznie: ${(zamowienia || []).length}`);
  if (EXCLUDE_IDS.size) console.log(`Pominięte ID: ${[...EXCLUDE_IDS].join(', ')}`);
  console.log(`Do oznaczenia jako DOSTARCZONE (etap ≠ DELIVERED/INVOICED): ${ids.length}`);
  if (ids.length) console.log(`  ID: ${ids.slice(0, 60).join(', ')}${ids.length > 60 ? ' …' : ''}`);

  // Przesyłki tych zamówień, które nie są jeszcze delivered.
  let shipments = [];
  if (ids.length) {
    const { data, error: sErr } = await db
      .from('wyceny_shipments')
      .select('id, wycena_id, status, delivered_at, nadana_at, created_at')
      .in('wycena_id', ids);
    if (sErr) throw sErr;
    shipments = (data || []).filter((s) => s.status !== 'delivered' || !s.delivered_at);
  }
  console.log(`Przesyłek do oznaczenia jako doręczone: ${shipments.length}`);

  if (!APPLY) {
    console.log('\n[dry-run] Nic nie zapisano. Uruchom z --apply, żeby zapisać do prod.');
    return;
  }

  // 1) Etap wycen -> DELIVERED (partiami, żeby nie przekroczyć limitu URL).
  let stageUpdated = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { error: uErr } = await db.from('wyceny')
      .update({ process_stage: 'DELIVERED', updated_at: new Date().toISOString() })
      .in('id', chunk);
    if (uErr) throw uErr;
    stageUpdated += chunk.length;
  }

  // 2) Przesyłki -> delivered z datą (coalesce delivered_at | nadana_at | created_at).
  let shipUpdated = 0;
  for (const s of shipments) {
    const deliveredAt = s.delivered_at || s.nadana_at || s.created_at || new Date().toISOString();
    const { error: sErr } = await db.from('wyceny_shipments')
      .update({ status: 'delivered', delivered_at: deliveredAt, updated_at: new Date().toISOString() })
      .eq('id', s.id);
    if (sErr) throw sErr;
    shipUpdated += 1;
  }

  console.log(`\n[apply] Wyceny oznaczone DELIVERED: ${stageUpdated}`);
  console.log(`[apply] Przesyłki oznaczone delivered: ${shipUpdated}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
