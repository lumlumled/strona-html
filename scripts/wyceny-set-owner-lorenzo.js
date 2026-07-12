// Przypisanie historycznych wycen Lorenzo do ownera 'Lorenzo'. Lista ID
// pochodzi z arkusza "CRM B2B LumLum - CRM_CASES" (wyceny Lorenzo) przesłanego
// przez Antoniego 2026-07-13. Sprzedaż to TEN SAM rekord co wycena (typ
// flipuje WYCENA→ZAMÓWIENIE, id zostaje), więc ustawienie ownera na tych ID
// automatycznie obejmuje też te wyceny Lorenzo, które stały się sprzedażą
// ("jeśli case z wyceny Lorenzo został sprzedany, to jego sprzedaż").
//
// Bezpieczeństwo: DOMYŚLNIE dry-run. Zapis dopiero z flagą --apply.
//   node scripts/wyceny-set-owner-lorenzo.js           # podgląd
//   node scripts/wyceny-set-owner-lorenzo.js --apply    # zapis do prod
const path = require('path');
const FORM_SERVER = path.join(__dirname, '..', 'apps', 'formularz', 'server');
require(path.join(__dirname, '..', 'node_modules', 'dotenv')).config({ path: path.join(FORM_SERVER, '.env') });
const { createClient } = require(path.join(__dirname, '..', 'node_modules', '@supabase/supabase-js'));

const APPLY = process.argv.includes('--apply');
const OWNER = 'Lorenzo';

// ID wycen Lorenzo z arkusza (kolumna id, bez '#').
const LORENZO_IDS = [
  1686, 1706, 1755, 1764, 1765, 1771, 1772, 1775, 1778, 1785,
  1806, 1816, 1817, 1818, 1832, 1835, 1836, 1839, 1842, 1847,
  1850, 1851, 1852, 1859, 1862, 1863, 1867, 1868,
];

async function main() {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: rows, error } = await db
    .from('wyceny')
    .select('id, typ, owner, kwota_proponowana_brutto, kwota_sprzedazy_brutto, process_stage')
    .in('id', LORENZO_IDS);
  if (error) throw error;

  const found = rows || [];
  const foundIds = new Set(found.map((r) => r.id));
  const missing = LORENZO_IDS.filter((id) => !foundIds.has(id));
  const sales = found.filter((r) => r.typ === 'ZAMÓWIENIE');
  const juzLorenzo = found.filter((r) => String(r.owner || '').trim().toLowerCase() === OWNER.toLowerCase());

  console.log(`ID z arkusza Lorenzo: ${LORENZO_IDS.length}`);
  console.log(`Znaleziono w bazie: ${found.length}`);
  if (missing.length) console.log(`⚠️  NIE znaleziono (id): ${missing.join(', ')}`);
  console.log(`Już owner=Lorenzo: ${juzLorenzo.length}`);
  console.log(`Z tego SPRZEDAŻE (typ ZAMÓWIENIE): ${sales.length}${sales.length ? ' -> id: ' + sales.map((s) => s.id).join(', ') : ''}`);
  console.log('\nStan rekordów:');
  found
    .sort((a, b) => a.id - b.id)
    .forEach((r) => {
      const kwota = r.kwota_sprzedazy_brutto ?? r.kwota_proponowana_brutto ?? '';
      console.log(`  #${r.id}  ${String(r.typ).padEnd(10)} owner=${String(r.owner || '—').padEnd(9)} ${String(r.process_stage || '').padEnd(10)} ${kwota} zł`);
    });

  if (!APPLY) {
    console.log('\n[dry-run] Nic nie zapisano. Uruchom z --apply, żeby zapisać do prod.');
    return;
  }

  const { data: updated, error: uErr } = await db
    .from('wyceny')
    .update({ owner: OWNER, updated_at: new Date().toISOString() })
    .in('id', [...foundIds])
    .select('id');
  if (uErr) throw uErr;

  console.log(`\n[apply] Ustawiono owner='${OWNER}' dla ${updated.length} rekordów.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
