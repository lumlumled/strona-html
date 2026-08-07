#!/usr/bin/env node
// Wciąga ręczne eksporty dzienne Facebooka (Meta Business Suite → Statystyki →
// eksport CSV) do marketing_organic_daily (platform='facebook'), MERGE-ując po dacie.
// Potrzebne, bo Graph API v21 NIE oddaje treściowych metryk FB (Meta je wycofała):
//   • Wyświetlenia                    → views      (to czyta panel jako zasięg FB)
//   • Widzowie                        → reach      (unikalni odbiorcy — realny zasięg)
//   • Interakcje z zawartością        → interactions
//   • Kliknięcia linku na Facebooku   → link_clicks
// Metryka rozpoznawana po NAGŁÓWKU pliku (nie po nazwie) — podaj pliki FB w dowolnej
// kolejności; pliki IG (np. „…na Instagramie") są pomijane z ostrzeżeniem.
// Obserwacje/wejścia zostają z API (cotygodniowy/3× automat) — ich tu nie ruszamy.
// Pamięć: project_faza3_meta_api.
//
// Użycie (ścieżki absolutne albo względem ~/Downloads):
//   node scripts/fb-daily-from-csv.js "Wyświetlenia (2).csv" "Widzowie.csv" \
//        "Interakcje (2).csv" "Kliknięcia linku (2).csv"
//   node scripts/fb-daily-from-csv.js --dry-run <pliki...>   # bez zapisu, sam raport

const fs = require('fs');
const os = require('os');
const path = require('path');
const KOM = path.join(__dirname, '..', 'apps', 'komunikator', 'server');
require(path.join(KOM, 'node_modules', 'dotenv')).config({ path: path.join(KOM, '.env') });
const { getClient } = require(path.join(KOM, 'supabase.js'));
const db = getClient();

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const files = args.filter((a) => !a.startsWith('--'));

// nagłówek (2. linia CSV) → klucz metryki w metrics jsonb
const CLASSIFY = [
  { re: /Wy[śs]wietlenia/i, key: 'views' },
  { re: /Widzowie/i, key: 'reach' },
  { re: /Interakcje/i, key: 'interactions' },
  { re: /Klikni.*Facebook/i, key: 'link_clicks' },
];
const IG_SKIP = /Klikni.*Instagram|na Instagramie/i;

function resolve(f) {
  if (fs.existsSync(f)) return f;
  const inDl = path.join(os.homedir(), 'Downloads', f);
  if (fs.existsSync(inDl)) return inDl;
  throw new Error(`nie znaleziono pliku: ${f} (ani w ~/Downloads)`);
}
function readCsv(p) {
  const b = fs.readFileSync(p);
  const t = (b[0] === 0xff && b[1] === 0xfe) ? b.toString('utf16le') : b.toString('utf8');
  const lines = t.split(/\r?\n/).filter(Boolean);
  const title = (lines[1] || '').replace(/"/g, '').trim();
  const data = new Map();
  for (const l of lines) { const m = l.match(/^"?(\d{4}-\d{2}-\d{2})T[^"]*"?\s*,\s*"?(-?\d+)"?/); if (m) data.set(m[1], Number(m[2])); }
  return { title, data };
}

(async () => {
  if (!files.length) { console.error('Podaj pliki CSV (patrz nagłówek skryptu).'); process.exit(1); }
  const perMetric = {}; // key -> Map(date->value)
  for (const f of files) {
    const p = resolve(f);
    const { title, data } = readCsv(p);
    if (IG_SKIP.test(title)) { console.log(`↷ pomijam (Instagram): ${path.basename(f)} — "${title}"`); continue; }
    const hit = CLASSIFY.find((c) => c.re.test(title));
    if (!hit) { console.log(`⚠ nierozpoznany nagłówek, pomijam: ${path.basename(f)} — "${title}"`); continue; }
    perMetric[hit.key] = data;
    const dates = [...data.keys()].sort();
    console.log(`✓ ${hit.key.padEnd(13)} ← "${title}" (${data.size} dni, ${dates[0]}..${dates[dates.length - 1]})`);
  }
  const metricKeys = Object.keys(perMetric);
  if (!metricKeys.length) { console.error('Żaden plik nie rozpoznany jako metryka FB.'); process.exit(1); }

  // wszystkie daty z dowolnego pliku
  const allDates = new Set();
  for (const m of Object.values(perMetric)) for (const d of m.keys()) allDates.add(d);

  const { data: rows, error } = await db.from('marketing_organic_daily').select('date,metrics').eq('platform', 'facebook');
  if (error) throw error;
  const existing = new Map((rows || []).map((r) => [r.date, r.metrics || {}]));

  const now = new Date().toISOString();
  const upserts = [];
  for (const date of allDates) {
    const merged = { ...(existing.get(date) || {}) };
    for (const key of metricKeys) if (perMetric[key].has(date)) merged[key] = perMetric[key].get(date);
    upserts.push({ platform: 'facebook', date, metrics: merged, source: 'meta_api+csv', fetched_at: now, updated_at: now });
  }
  upserts.sort((a, b) => a.date.localeCompare(b.date));

  if (DRY) {
    console.log(`\n[dry-run] ${upserts.length} dni do zapisania. Próbki:`);
    for (const d of ['2025-11-16', '2026-07-01', '2026-08-06']) { const r = upserts.find((x) => x.date === d); if (r) console.log(`  ${d}: ${JSON.stringify(r.metrics)}`); }
    return;
  }
  for (let i = 0; i < upserts.length; i += 200) {
    const { error: e2 } = await db.from('marketing_organic_daily').upsert(upserts.slice(i, i + 200), { onConflict: 'platform,date' });
    if (e2) throw e2;
  }
  console.log(`\n✅ zapisano ${upserts.length} dni FB (${metricKeys.join(', ')}) — merge, reszta metryk nietknięta.`);
  const { data: chk } = await db.from('marketing_organic_daily').select('date,metrics').eq('platform', 'facebook').in('date', ['2025-11-16', '2026-08-06']);
  for (const r of (chk || []).sort((a, b) => a.date.localeCompare(b.date))) console.log(`  ${r.date}: ${JSON.stringify(r.metrics)}`);
})().catch((e) => { console.error('BŁĄD:', e.message); process.exit(1); });
