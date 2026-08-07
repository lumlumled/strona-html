#!/usr/bin/env node
// CLI do wciągania ręcznych eksportów dziennych Facebooka do marketing_organic_daily.
// CAŁA logika (parsowanie UTF-16LE, rozpoznanie metryki po nagłówku, pomijanie IG,
// MERGE po dacie) żyje w apps/shared/server/fb-csv-ingest.js — współdzielona z
// uploadem w panelu /kreacje. Pamięć: project_faza3_meta_api.
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
const { analyzeFiles, ingest } = require(path.join(__dirname, '..', 'apps', 'shared', 'server', 'fb-csv-ingest.js'));

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const names = args.filter((a) => !a.startsWith('--'));

function resolve(f) {
  if (fs.existsSync(f)) return f;
  const inDl = path.join(os.homedir(), 'Downloads', f);
  if (fs.existsSync(inDl)) return inDl;
  throw new Error(`nie znaleziono pliku: ${f} (ani w ~/Downloads)`);
}

function printRaporty(raporty) {
  for (const r of raporty) {
    if (r.status === 'ok') console.log(`✓ ${r.metryka.padEnd(13)} ← "${r.title}" (${r.dni} dni, ${r.od}..${r.do}) [${r.plik}]`);
    else if (r.status === 'instagram') console.log(`↷ pomijam (Instagram): ${r.plik} — "${r.title}"`);
    else console.log(`⚠ nierozpoznany nagłówek, pomijam: ${r.plik} — "${r.title}"`);
  }
}

(async () => {
  if (!names.length) { console.error('Podaj pliki CSV (patrz nagłówek skryptu).'); process.exit(1); }
  const files = names.map((f) => { const p = resolve(f); return { name: path.basename(f), buffer: fs.readFileSync(p) }; });

  if (DRY) {
    const { raporty } = analyzeFiles(files);
    printRaporty(raporty);
    if (!raporty.some((r) => r.status === 'ok')) process.exit(1);
    console.log('\n[dry-run] nic nie zapisano.');
    return;
  }

  const db = getClient();
  const wynik = await ingest(db, files);
  printRaporty(wynik.raporty);
  if (!wynik.metryki.length) { console.error('Żaden plik nie rozpoznany jako metryka FB.'); process.exit(1); }
  console.log(`\n✅ zapisano ${wynik.dni} dni FB (${wynik.metryki.join(', ')}; ${wynik.zakres.od}..${wynik.zakres.do}) — merge, reszta metryk nietknięta.`);
  const { data: chk } = await db.from('marketing_organic_daily').select('date,metrics').eq('platform', 'facebook').in('date', [wynik.zakres.od, wynik.zakres.do]);
  for (const r of (chk || []).sort((a, b) => a.date.localeCompare(b.date))) console.log(`  ${r.date}: ${JSON.stringify(r.metrics)}`);
})().catch((e) => { console.error('BŁĄD:', e.message); process.exit(1); });
