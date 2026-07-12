// Dwie ręczne poprawki danych (decyzja Antoniego 2026-07-13), już URUCHOMIONE
// na prod — ten plik to ślad operacji (idempotentny, można puścić ponownie):
//   #1595 — test bez nazwy/maila, tylko telefon testowy 666484872 -> KASACJA
//           (wraz z powiązanymi shipments/invoices/events).
//   #1566 — realne zamówienie z zaśmieconym polem imienia ("Antoni Chodurski"
//           przy realnym kontakcie patrykjoskowiak@onet.pl) -> imię/nazwisko
//           odtworzone z maila: "Patryk Joskowiak"; rekord ZOSTAJE.
//
// Bezpieczeństwo: DOMYŚLNIE dry-run. Zapis dopiero z flagą --apply.
const path = require('path');
const FORM_SERVER = path.join(__dirname, '..', 'apps', 'formularz', 'server');
require(path.join(__dirname, '..', 'node_modules', 'dotenv')).config({ path: path.join(FORM_SERVER, '.env') });
const { createClient } = require(path.join(__dirname, '..', 'node_modules', '@supabase/supabase-js'));

const APPLY = process.argv.includes('--apply');

async function main() {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: r1566 } = await db.from('wyceny').select('id,imie_nazwisko,first_name,last_name,email').eq('id', 1566).limit(1);
  const { data: r1595 } = await db.from('wyceny').select('id,typ,kwota_proponowana_brutto,telefon_digits').eq('id', 1595).limit(1);
  console.log('#1566:', r1566 && r1566[0] ? JSON.stringify(r1566[0]) : '(brak)');
  console.log('#1595:', r1595 && r1595[0] ? JSON.stringify(r1595[0]) : '(brak / już skasowane)');

  if (!APPLY) {
    console.log('\n[dry-run] Nic nie zapisano. Uruchom z --apply.');
    return;
  }

  const { error: uErr } = await db.from('wyceny').update({
    imie_nazwisko: 'Patryk Joskowiak', first_name: 'Patryk', last_name: 'Joskowiak',
    updated_at: new Date().toISOString(),
  }).eq('id', 1566);
  if (uErr) throw uErr;

  for (const tbl of ['wyceny_events', 'wyceny_shipments', 'wyceny_invoices']) {
    const { error } = await db.from(tbl).delete().eq('wycena_id', 1595);
    if (error) throw error;
  }
  const { data: del, error: dErr } = await db.from('wyceny').delete().eq('id', 1595).select('id');
  if (dErr) throw dErr;

  console.log(`\n[apply] #1566 -> Patryk Joskowiak; #1595 skasowane (${del.length}).`);
}

main().catch((err) => { console.error(err); process.exit(1); });
