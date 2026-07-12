// Kasowanie testowych wycen/sprzedaży Antoniego ("moje testy", decyzja
// 2026-07-13). Rekordy zidentyfikowane po sygnaturze: mail antoni.chodurski@
// gmail.com / antek229@gmail.com, telefon testowy 666484872 (= telefon z
// case'a #1818, na który wskazał Antoni), albo nazwa "TEST … (do usuniecia)".
// Kasuje też powiązane wiersze (wyceny_shipments / wyceny_invoices /
// wyceny_events) — FK pod PK integer, więc dzieci lecą PRZED rodzicem.
//
// UWAGA: nie rusza zewnętrznych zasobów — proformy #1875/#1876 w inFakt i
// przesyłki ShipX trzeba (jeśli trzeba) skasować osobno w tamtych systemach.
//
// Bezpieczeństwo: DOMYŚLNIE dry-run. Zapis dopiero z flagą --apply.
//   node scripts/wyceny-delete-tests.js           # podgląd
//   node scripts/wyceny-delete-tests.js --apply    # kasuje z prod
const path = require('path');
const FORM_SERVER = path.join(__dirname, '..', 'apps', 'formularz', 'server');
require(path.join(__dirname, '..', 'node_modules', 'dotenv')).config({ path: path.join(FORM_SERVER, '.env') });
const { createClient } = require(path.join(__dirname, '..', 'node_modules', '@supabase/supabase-js'));

const APPLY = process.argv.includes('--apply');

// Jednoznaczne testy do skasowania. #1595 (3800 zł, brak nazwy/maila) i #1566
// (nazwa Antoni Chodurski, ale realny kontakt Patryk) CELOWO poza listą —
// czekają na potwierdzenie Antoniego.
const DELETE_IDS = [1817, 1818, 1875, 1876, 1897, 1898, 1900, 1911, 1912, 1913, 1930];

async function main() {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: rows, error } = await db
    .from('wyceny')
    .select('id, typ, owner, imie_nazwisko, email, telefon_digits, kwota_proponowana_brutto, kwota_sprzedazy_brutto, source')
    .in('id', DELETE_IDS);
  if (error) throw error;
  const found = (rows || []).sort((a, b) => a.id - b.id);
  const foundIds = found.map((r) => r.id);
  const missing = DELETE_IDS.filter((id) => !foundIds.includes(id));

  const child = async (tbl) => {
    const { data: d } = await db.from(tbl).select('id, wycena_id').in('wycena_id', foundIds);
    return d || [];
  };
  const ships = await child('wyceny_shipments');
  const invs = await child('wyceny_invoices');
  const evs = await child('wyceny_events');

  console.log(`Do skasowania: ${found.length} / ${DELETE_IDS.length}`);
  if (missing.length) console.log(`Nie znaleziono (już usunięte?): ${missing.join(', ')}`);
  found.forEach((r) => {
    const k = r.kwota_sprzedazy_brutto ?? r.kwota_proponowana_brutto ?? '';
    console.log(`  #${r.id} ${String(r.typ).padEnd(10)} own=${String(r.owner || '-').padEnd(8)} ${String(r.imie_nazwisko || '-').slice(0, 30).padEnd(30)} ${String(r.email || '-').padEnd(28)} ${k} zł`);
  });
  console.log(`Powiązane: shipments=${ships.length}, invoices=${invs.length}, events=${evs.length}`);

  if (!APPLY) {
    console.log('\n[dry-run] Nic nie skasowano. Uruchom z --apply, żeby usunąć z prod.');
    return;
  }

  // Dzieci przed rodzicem.
  for (const tbl of ['wyceny_events', 'wyceny_shipments', 'wyceny_invoices']) {
    const { error: e } = await db.from(tbl).delete().in('wycena_id', foundIds);
    if (e) throw e;
  }
  const { data: del, error: e2 } = await db.from('wyceny').delete().in('id', foundIds).select('id');
  if (e2) throw e2;

  console.log(`\n[apply] Skasowano wycen/sprzedaży: ${del.length} (+ powiązane shipments/invoices/events).`);
}

main().catch((err) => { console.error(err); process.exit(1); });
