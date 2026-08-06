#!/usr/bin/env node
// CLI Fazy 3: pull metryk z Meta Graph API (FB Page + IG Business) → tabele
// marketing_organic_posts / marketing_organic_daily. Rdzeń: apps/shared/server/
// meta-insights.js (współdzielony z cotygodniowym cronem). Klient DB + env
// pożyczamy z serwera Komunikatora (wspólna baza), jak inne skrypty w scripts/.
// Pamięć: project_faza3_meta_api.
//
// Token: META_GRAPH_TOKEN w env ALBO plik ~/.config/lumlum-meta-token.txt
//        (wklej tam token z Business Managera / Graph API Explorera).
//
// Użycie:
//   node scripts/meta-insights-pull.js --check              # test tokena/kontekstu, BEZ zapisu
//   node scripts/meta-insights-pull.js --backfill           # pełna historia (IG per-post + FB/IG daily)
//   node scripts/meta-insights-pull.js --backfill --platform ig
//   node scripts/meta-insights-pull.js --weekly             # przyrost (ostatnie ~14 dni)
//   node scripts/meta-insights-pull.js --backfill --since 2025-08-01

const path = require('path');
const KOM = path.join(__dirname, '..', 'apps', 'komunikator', 'server');
require(path.join(KOM, 'node_modules', 'dotenv')).config({ path: path.join(KOM, '.env') });
const { getClient } = require(path.join(KOM, 'supabase.js'));
const meta = require(path.join(__dirname, '..', 'apps', 'shared', 'server', 'meta-insights.js'));

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

(async () => {
  const db = getClient();
  const platArg = opt('--platform', 'all');
  const platforms = platArg === 'ig' ? ['instagram'] : platArg === 'fb' ? ['facebook'] : ['instagram', 'facebook'];

  if (flag('--check')) {
    console.log('[check] sonduję token + kontekst (bez zapisu do DB)…');
    const r = await meta.probe(db);
    console.log(JSON.stringify(r, null, 2));
    console.log(r.ctx.igId ? '\n✅ Kontekst OK — token widzi stronę i konto IG. Można odpalać --backfill.' : '\n⚠️ Token widzi stronę, ale BEZ konta IG (sprawdź powiązanie IG↔strona lub uprawnienia instagram_*).');
    return;
  }

  const kind = flag('--weekly') ? 'weekly' : 'backfill';
  console.log(`[${kind}] start (platformy: ${platforms.join(', ')})…`);
  const t0 = Date.now();
  const res = kind === 'weekly'
    ? await meta.runWeekly(db, { days: Number(opt('--days', '14')) })
    : await meta.runBackfill(db, { platforms, dailySince: opt('--since', undefined) });
  console.log(`\n[${kind}] GOTOWE w ${((Date.now() - t0) / 1000).toFixed(1)}s:`);
  console.log(JSON.stringify(res, null, 2));
})().catch((e) => { console.error('BŁĄD:', e.message); process.exit(1); });
