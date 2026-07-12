// Cofnięcie demotowania dla rekordów Z IMIENIEM I NAZWISKIEM. Decyzja
// Antoniego 2026-07-13: spośród 32 zamówień zdemotowanych do wycen
// (wyceny-demote-nieopl.js) te, które mają wypełnione imię/nazwisko, to REALNE
// sprzedaże -> wracają na typ=ZAMÓWIENIE (i process_stage=DELIVERED, czyli stan
// sprzed demotowania). Te bez nazwy (sam telefon) zostają wycenami.
//
// Bezpieczeństwo: DOMYŚLNIE dry-run. Zapis dopiero z flagą --apply.
const path = require('path');
const FORM_SERVER = path.join(__dirname, '..', 'apps', 'formularz', 'server');
require(path.join(__dirname, '..', 'node_modules', 'dotenv')).config({ path: path.join(FORM_SERVER, '.env') });
const { createClient } = require(path.join(__dirname, '..', 'node_modules', '@supabase/supabase-js'));

const APPLY = process.argv.includes('--apply');
const has = (v) => v !== null && v !== undefined && String(v).trim() !== '';

// 32 ID zdemotowane w wyceny-demote-nieopl.js (#1550 już cofnięte ręcznie).
const DEMOTED_IDS = [
  1529, 1539, 1550, 1555, 1556, 1559, 1560, 1561, 1562, 1566, 1567, 1597,
  1606, 1623, 1626, 1629, 1644, 1645, 1670, 1675, 1734, 1743, 1748, 1750,
  1751, 1756, 1776, 1779, 1780, 1820, 1834, 1838,
];

async function main() {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: rows, error } = await db.from('wyceny')
    .select('id,typ,status,imie_nazwisko,first_name,last_name,kwota_proponowana_brutto,kwota_sprzedazy_brutto')
    .in('id', DEMOTED_IDS);
  if (error) throw error;

  const hasName = (r) => has(r.imie_nazwisko) || (has(r.first_name) && has(r.last_name));
  const toRevert = rows.filter((r) => r.typ === 'WYCENA' && hasName(r));
  const stayWycena = rows.filter((r) => r.typ === 'WYCENA' && !hasName(r));
  const kw = (r) => Number(r.kwota_sprzedazy_brutto ?? r.kwota_proponowana_brutto ?? 0);

  console.log(`Z 32 zdemotowanych — wracają na ZAMÓWIENIE (mają nazwę): ${toRevert.length}`);
  toRevert.sort((a, b) => a.id - b.id).forEach((r) =>
    console.log(`  #${r.id} ${String(r.status || '-').padEnd(12)} ${String(r.imie_nazwisko || [r.first_name, r.last_name].filter(Boolean).join(' ')).slice(0, 28).padEnd(28)} ${kw(r)} zł`));
  console.log(`\nZostają WYCENAMI (bez nazwy, sam telefon): ${stayWycena.length}`);
  console.log('  id: ' + stayWycena.map((r) => r.id).sort((a, b) => a - b).join(', '));

  if (!APPLY) {
    console.log('\n[dry-run] Nic nie zapisano. Uruchom z --apply.');
    return;
  }

  const ids = toRevert.map((r) => r.id);
  const { error: uErr } = await db.from('wyceny')
    .update({ typ: 'ZAMÓWIENIE', process_stage: 'DELIVERED', updated_at: new Date().toISOString() })
    .in('id', ids);
  if (uErr) throw uErr;
  console.log(`\n[apply] Cofnięto na ZAMÓWIENIE: ${ids.length}.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
