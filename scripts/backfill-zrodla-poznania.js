// Backfill "skąd klient nas zna" po starych transkrypcjach z "Log zmian"
// (zadarma_webhook + rozmowa_reczna). Odchudzona ekstrakcja (extractZrodlo,
// nie pełny analyzeCall) → detekcje do lead_zrodla_poznania + dopasowanie
// opisanego filmu do bazy rolek; kolumna "Skąd nas zna" wypełniana TYLKO gdy
// pusta (żywa ścieżka ma pierwszeństwo), a idziemy od najnowszych rozmów,
// więc kolumnę dostaje najświeższa deklaracja.
// Idempotentny: unikalny log_zmian_id (migr. 023) + prefetch już zrobionych.
//
// Użycie:  node scripts/backfill-zrodla-poznania.js [--limit 50] [--dry]
//   --dry   tylko ekstrakcja i wydruk detekcji, zero zapisów i dopasowań
// Zależności i .env pożyczamy z serwera Backlogu (wzorzec shared/migrations/run.js).
const path = require('path');
const B2C = path.join(__dirname, '..', 'apps', 'backlog-b2c', 'server');
require(path.join(B2C, 'node_modules', 'dotenv')).config({ path: path.join(B2C, '.env') });
const { createClient } = require(path.join(B2C, 'node_modules', '@supabase/supabase-js'));
// Po dotenv — moduł czyta OPENAI_API_KEY przy require.
const { extractZrodlo, zapiszZrodloPoznania } = require('../apps/shared/server/zrodlo-poznania');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) || 0 : 0;
const CONCURRENCY = 4;
// Krótsze transkrypcje to szum (poczta głosowa, urwane połączenia) — deklaracja
// źródła i tak pada w realnej rozmowie, nie w 3 zdaniach.
const MIN_TRANSCRIPT_LEN = 80;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Warianty numeru jak w findLeadByPhone (9 cyfr vs 48+9) — "Phone number"
// w Leady B2C jest numeryczne i bywa w obu postaciach.
function phoneVariants(digits) {
  const d = String(digits || '').replace(/\D/g, '');
  if (!d) return [];
  const out = new Set([d]);
  if (d.length === 11 && d.startsWith('48')) out.add(d.slice(2));
  if (d.length === 9) out.add(`48${d}`);
  return [...out].map(Number).filter((n) => !Number.isNaN(n));
}

async function findLead(digits) {
  const variants = phoneVariants(digits);
  if (!variants.length) return null;
  const { data } = await supabase.from('Leady B2C')
    .select('"Phone number","Skąd nas zna"')
    .in('Phone number', variants)
    .limit(1);
  return data?.[0] || null;
}

async function fetchAllRows() {
  // Supabase tnie po 1000 wierszy — stronicujemy po id malejąco (najnowsze
  // najpierw, patrz komentarz o kolumnie).
  const rows = [];
  let before = null;
  for (;;) {
    let q = supabase.from('Log zmian')
      .select('id, telefon, transkrypcja, dopasowano_tabela, dopasowano_id')
      .in('zrodlo', ['zadarma_webhook', 'rozmowa_reczna'])
      .not('transkrypcja', 'is', null)
      .eq('disposition', 'answered')
      .order('id', { ascending: false })
      .limit(1000);
    if (before) q = q.lt('id', before);
    const { data, error } = await q;
    if (error) throw new Error(`Log zmian: ${error.message}`);
    if (!data?.length) break;
    rows.push(...data);
    before = data[data.length - 1].id;
    if (LIMIT && rows.length >= LIMIT * 3) break; // zapas na odsiew krótkich/zrobionych
  }
  return rows;
}

async function main() {
  const { data: doneRows, error: doneErr } = await supabase
    .from('lead_zrodla_poznania').select('log_zmian_id').not('log_zmian_id', 'is', null);
  if (doneErr) throw new Error(`lead_zrodla_poznania: ${doneErr.message}`);
  const done = new Set((doneRows || []).map((r) => r.log_zmian_id));

  let rows = (await fetchAllRows())
    .filter((r) => !done.has(r.id))
    .filter((r) => r.telefon && String(r.transkrypcja || '').trim().length >= MIN_TRANSCRIPT_LEN);
  if (LIMIT) rows = rows.slice(0, LIMIT);
  console.log(`Do przejrzenia: ${rows.length} rozmów (już zrobione: ${done.size})${DRY ? ' [DRY RUN]' : ''}`);

  const stats = { wykryte: 0, filmy: 0, dopasowane: 0, perKod: {} };
  let processed = 0;

  async function handle(row) {
    const det = await extractZrodlo(row.transkrypcja);
    processed += 1;
    if (processed % 25 === 0) console.log(`… ${processed}/${rows.length} (wykryte: ${stats.wykryte})`);
    if (!det.zrodlo_poznania) return;
    stats.wykryte += 1;
    stats.perKod[det.zrodlo_poznania] = (stats.perKod[det.zrodlo_poznania] || 0) + 1;
    if (det.film_opis) stats.filmy += 1;
    if (DRY) {
      console.log(`  [dry] #${row.id} ${row.telefon}: ${det.zrodlo_poznania}${det.zrodlo_obserwuje ? ' (obserwuje)' : ''} — "${det.zrodlo_cytat || ''}"${det.film_opis ? ` | film: "${det.film_opis}"` : ''}`);
      return;
    }
    const lead = row.dopasowano_tabela === 'kontakty_organic' ? null : await findLead(row.telefon);
    const result = await zapiszZrodloPoznania(supabase, {
      telefon: row.telefon,
      det,
      via: 'backfill',
      logZmianId: row.id,
      leadPhone: lead ? lead['Phone number'] : null,
      kontaktOrganicId: row.dopasowano_tabela === 'kontakty_organic' ? Number(row.dopasowano_id) : null,
      onlyFillEmpty: true,
    });
    if (result.match?.kandydaci?.length) stats.dopasowane += 1;
    if (result.saved) console.log(`  #${row.id} ${row.telefon}: ${result.skad || det.zrodlo_poznania}`);
  }

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    await Promise.all(rows.slice(i, i + CONCURRENCY).map(handle));
  }

  console.log('\n── Podsumowanie ──');
  console.log(`Rozmów przejrzanych: ${processed}`);
  console.log(`Deklaracji źródła:   ${stats.wykryte}`);
  console.log(`Z opisem filmu:      ${stats.filmy} (dopasowane do rolek: ${stats.dopasowane})`);
  for (const [kod, n] of Object.entries(stats.perKod).sort((a, b) => b[1] - a[1])) console.log(`  ${kod}: ${n}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
