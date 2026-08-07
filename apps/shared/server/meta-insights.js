// Faza 3 atrybucji — jedna integracja Meta Graph API (FB Page + IG Business).
// Żywe metryki per-post (IG) + dzienne serie zasięgu (FB Page + IG account),
// zamiast starzejących się ręcznych eksportów CSV. Rdzeń współdzielony przez:
//   • cotygodniowy cron (apps/statystyki/server/server.js → /api/cron/meta-insights)
//   • CLI backfillu (scripts/meta-insights-pull.js)
// `db` (klient supabase-js) jest WSTRZYKIWANY — jak funkcje queries.js.
// Pamięć: project_faza3_meta_api / project_atrybucja_organic_tresc.
//
// ⚠️ FB per-rolka POMIJAMY (crossposty — Meta nie oddaje organicznego zasięgu
//    per-post; potwierdzone w eksportach). FB wchodzi TYLKO dzienny (page-level).
//    Granularne per-post bierzemy z IG (ma zasięg/plays/saved/retencję per media).
//
// Dobór metryk jest ADAPTACYJNY: żądamy szerokiego zestawu, a metryki wskazane
// przez API jako niewspierane wywalamy i ponawiamy (API Meta zmienia dostępność
// metryk między wersjami — to chroni przed twardym zaszyciem listy).

const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = process.env.META_GRAPH_VERSION || 'v21.0';
const PAGE_ID = process.env.META_PAGE_ID || '379092038630635'; // strona LumLum (z zernio OWN_AUTHOR_IDS)
const G = `https://graph.facebook.com/${VERSION}`;
const DAY = 86400 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Token ────────────────────────────────────────────────────────────────────
// Priorytet: META_GRAPH_TOKEN (Vercel/env) → plik lokalny (dev/backfill) →
// META_CAPI_TOKEN (ostatnia deska; zwykle BEZ scope insightów — patrz pamięć).
function getToken() {
  if (process.env.META_GRAPH_TOKEN && process.env.META_GRAPH_TOKEN.trim()) return process.env.META_GRAPH_TOKEN.trim();
  try {
    const p = process.env.META_TOKEN_FILE || path.join(os.homedir(), '.config', 'lumlum-meta-token.txt');
    const v = fs.readFileSync(p, 'utf8').trim();
    if (v) return v;
  } catch (_) { /* brak pliku = ok */ }
  if (process.env.META_CAPI_TOKEN && process.env.META_CAPI_TOKEN.trim()) return process.env.META_CAPI_TOKEN.trim();
  return null;
}

// ── HTTP z retry na limity/przejściowe błędy ─────────────────────────────────
async function api(url, tries = 4) {
  let lastErr = '';
  for (let i = 0; i < tries; i++) {
    let res;
    try { res = await fetch(url); } catch (e) { lastErr = e.message; await sleep(800 * (i + 1)); continue; }
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
    if (res.ok) return { ok: true, status: res.status, body };
    const err = body && body.error;
    const code = err && (err.code || err.error_subcode);
    // limity szybkości / przejściowe (#4 app-limit, #17 user-limit, #32 page-limit, #613)
    if ([4, 17, 32, 613, 1, 2].includes(Number(code)) || res.status >= 500 || res.status === 429) {
      lastErr = err ? err.message : `HTTP ${res.status}`;
      await sleep(1500 * (i + 1));
      continue;
    }
    return { ok: false, status: res.status, body, error: err };
  }
  return { ok: false, status: 0, body: null, error: { message: lastErr || 'retry exhausted' } };
}
const qs = (o) => Object.entries(o).filter(([, v]) => v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

// ── Kontekst: strona → page token + powiązane konto IG Business ───────────────
async function resolveContext(token) {
  if (!token) throw new Error('Brak tokena Meta (META_GRAPH_TOKEN / plik / META_CAPI_TOKEN).');
  const r = await api(`${G}/${PAGE_ID}?${qs({ fields: 'name,access_token,instagram_business_account{id,username,followers_count,media_count}', access_token: token })}`);
  if (!r.ok) throw new Error(`resolveContext: ${r.error && r.error.message || r.status}. Token prawdopodobnie bez pages_read_engagement/read_insights.`);
  const pageToken = r.body.access_token || token; // page token > user token; system-user zwykle bez access_token → używamy podanego
  const ig = r.body.instagram_business_account || null;
  const igId = process.env.META_IG_BUSINESS_ID || (ig && ig.id) || null;
  return { pageToken, pageName: r.body.name, igId, igUsername: ig && ig.username, igMediaCount: ig && ig.media_count };
}

// ── IG: media + insights ──────────────────────────────────────────────────────
const IG_MEDIA_FIELDS = 'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url,media_url';

function metricsForMedia(m) {
  // insighty IG (NIE zawierają likes/comments — te bierzemy z pól media)
  const base = ['reach', 'saved', 'shares', 'total_interactions'];
  if (m.media_product_type === 'REELS') return [...base, 'views', 'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time'];
  if (m.media_type === 'VIDEO') return [...base, 'views'];
  return base; // IMAGE / CAROUSEL_ALBUM
}

async function fetchMediaInsights(mediaId, metrics, token) {
  let set = [...metrics];
  for (let attempt = 0; attempt < 4 && set.length; attempt++) {
    const r = await api(`${G}/${mediaId}/insights?${qs({ metric: set.join(','), access_token: token })}`);
    if (r.ok) {
      const out = {};
      for (const d of (r.body.data || [])) out[d.name] = d.values && d.values[0] ? d.values[0].value : undefined;
      return out;
    }
    const msg = (r.error && r.error.message) || '';
    const bad = set.filter((mt) => msg.includes(mt));
    if (bad.length) { set = set.filter((mt) => !bad.includes(mt)); continue; }
    if (/not support|Invalid metric|nonexisting|#100/i.test(msg) && set.length > 1) { set = ['reach']; continue; }
    return { __error: msg };
  }
  return {};
}

// media (Graph) + insighty → wiersz marketing_organic_posts (upsert po platform,post_id).
// Wysyłamy TYLKO pola, które mamy (merge-duplicates zachowa duration_s/twin z CSV).
function mapPostRow(m, ins, account) {
  const num = (v) => (v == null ? null : Number(v));
  const views = num(ins.views) ?? num(ins.plays);
  const metrics = {
    reach: num(ins.reach), views, saved: num(ins.saved), shares: num(ins.shares),
    total_interactions: num(ins.total_interactions),
    avg_watch_time_ms: num(ins.ig_reels_avg_watch_time),
    video_view_total_time_ms: num(ins.ig_reels_video_view_total_time),
    like_count: num(m.like_count), comments_count: num(m.comments_count),
  };
  Object.keys(metrics).forEach((k) => metrics[k] == null && delete metrics[k]);
  const row = {
    platform: 'instagram', post_id: String(m.id), account: account || null,
    url: m.permalink || null, title: m.caption || null,
    published_at: m.timestamp || null,
    views: views ?? null, reach: num(ins.reach),
    likes: num(m.like_count), comments: num(m.comments_count),
    shares: num(ins.shares), saves: num(ins.saved),
    media_type: m.media_type || null, media_product_type: m.media_product_type || null,
    thumbnail_url: m.thumbnail_url || m.media_url || null,
    metrics, source: 'meta_api', fetched_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  if (ins.__error) row.metrics.insights_error = ins.__error;
  return row;
}

// Iteruje media IG (paginacja). stopBefore = ISO/Date: przerwij, gdy trafimy
// starsze (dla trybu weekly). onBatch(rows) wywoływane porcjami.
async function fetchIgMedia(igId, token, { stopBeforeMs = null, log = () => {} } = {}) {
  const media = [];
  let url = `${G}/${igId}/media?${qs({ fields: IG_MEDIA_FIELDS, limit: 100, access_token: token })}`;
  let page = 0;
  while (url) {
    const r = await api(url);
    if (!r.ok) throw new Error(`fetchIgMedia: ${(r.error && r.error.message) || r.status}`);
    const items = r.body.data || [];
    for (const m of items) {
      if (stopBeforeMs && m.timestamp && new Date(m.timestamp).getTime() < stopBeforeMs) return media;
      media.push(m);
    }
    page += 1; log(`[ig] media strona ${page}: +${items.length} (razem ${media.length})`);
    url = r.body.paging && r.body.paging.next ? r.body.paging.next : null;
    if (url) await sleep(120);
  }
  return media;
}

// ── Dzienne serie (period=day, chunki 30-dniowe, adaptacyjny dobór metryk) ─────
function epoch(d) { return Math.floor((d instanceof Date ? d.getTime() : new Date(d).getTime()) / 1000); }

async function fetchDailyRange(objId, metrics, token, sinceMs, untilMs, log = () => {}) {
  const byDate = {}; // 'YYYY-MM-DD' -> {metric: value}
  let dropped = new Set();
  for (let s = sinceMs; s < untilMs; s += 30 * DAY) {
    const u = Math.min(s + 30 * DAY, untilMs);
    let set = metrics.filter((m) => !dropped.has(m));
    for (let attempt = 0; attempt < 4 && set.length; attempt++) {
      const r = await api(`${G}/${objId}/insights?${qs({ metric: set.join(','), period: 'day', since: epoch(new Date(s)), until: epoch(new Date(u)), access_token: token })}`);
      if (r.ok) {
        for (const d of (r.body.data || [])) {
          for (const v of (d.values || [])) {
            const date = (v.end_time || '').slice(0, 10);
            if (!date) continue;
            (byDate[date] = byDate[date] || {})[d.name] = v.value;
          }
        }
        break;
      }
      const msg = (r.error && r.error.message) || '';
      const bad = set.filter((mt) => msg.includes(mt));
      if (bad.length) { bad.forEach((b) => dropped.add(b)); set = set.filter((mt) => !bad.includes(mt)); continue; }
      log(`[daily ${objId}] chunk ${new Date(s).toISOString().slice(0, 10)} błąd: ${msg.slice(0, 120)}`);
      break;
    }
    await sleep(150);
  }
  return { byDate, dropped: [...dropped] };
}

// Mapowania dziennych → klucze zgodne z istniejącym CSV (panel czyta metrics.views/reach).
// ⚠️ v21: Meta CAŁKOWICIE wycofała page_impressions/page_impressions_unique (dzienny
//    zasięg/wyświetlenia FB). Metryki TREŚCIOWE FB — views (Wyświetlenia), reach (Widzowie),
//    interactions (Interakcje), link_clicks — pochodzą z ręcznego eksportu CSV
//    (scripts/fb-daily-from-csv.js). API zwraca TYLKO to, czego CSV nie ma: nowe obserwacje
//    i wejścia na stronę. Świadomie NIE zwracamy tu views/reach/interactions/link_clicks —
//    dzięki temu cotygodniowy MERGE nie nadpisze autorytatywnych danych z CSV.
//    Zweryfikowane sondą na żywym tokenie (FB_VALID: page_views_total/page_daily_follows_unique).
function mapFbDaily(raw) {
  return {
    new_followers: raw.page_daily_follows_unique,
    visits: raw.page_views_total,
  };
}
// IG: reach + follower_count działają jako SERIA DZIENNA (period=day). views/profile_views
// w v21 zwracane tylko jako total_value (agregat całego zakresu, nie per-dzień) → do dziennej
// bierzemy reach (to jest „zasięg" na timeline); views IG mamy per-post.
function mapIgDaily(raw) {
  return {
    reach: raw.reach,
    new_followers: raw.follower_count,
  };
}
const FB_DAILY_METRICS = ['page_views_total', 'page_daily_follows_unique'];
const IG_DAILY_METRICS = ['reach', 'follower_count'];

function cleanMetrics(o) { const r = {}; for (const [k, v] of Object.entries(o)) if (v != null) r[k] = v; return r; }

// ── Zapisy do DB (chunkowany upsert) ──────────────────────────────────────────
async function upsertPosts(db, rows) {
  let n = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const { error } = await db.from('marketing_organic_posts').upsert(chunk, { onConflict: 'platform,post_id' });
    if (error) throw new Error(`upsert posts: ${error.message}`);
    n += chunk.length;
  }
  return n;
}
async function upsertDaily(db, platform, byDate, mapFn) {
  const now = new Date().toISOString();
  const dates = Object.keys(byDate);
  if (!dates.length) return 0;
  // MERGE, nie replace: wczytaj istniejące metrics i dołóż świeże klucze. Inaczej
  // nadpisalibyśmy dane spoza API — krytycznie FB views/reach z historycznego CSV
  // (v21 ich nie oddaje). Bez tego cotygodniowy pull kasowałby zasięg FB.
  const existing = new Map();
  for (let i = 0; i < dates.length; i += 400) {
    const chunk = dates.slice(i, i + 400);
    const { data, error } = await db.from('marketing_organic_daily').select('date,metrics').eq('platform', platform).in('date', chunk);
    if (error) throw new Error(`read daily ${platform}: ${error.message}`);
    for (const r of (data || [])) existing.set(r.date, r.metrics || {});
  }
  const rows = [];
  for (const [date, raw] of Object.entries(byDate)) {
    const fresh = cleanMetrics(mapFn(raw));
    if (!Object.keys(fresh).length) continue;
    rows.push({ platform, date, metrics: { ...(existing.get(date) || {}), ...fresh }, source: 'meta_api', fetched_at: now, updated_at: now });
  }
  let n = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const { error } = await db.from('marketing_organic_daily').upsert(chunk, { onConflict: 'platform,date' });
    if (error) throw new Error(`upsert daily ${platform}: ${error.message}`);
    n += chunk.length;
  }
  return n;
}

// Po backfillu: usuń zdublowane wiersze IG z CSV (ten sam permalink co świeży
// wiersz meta_api, ale inny post_id). Zabezpieczenie: robi to tylko, gdy API
// dostarczyło zdrowy wolumen (żeby błąd API nie wyczyścił danych).
async function dedupeIgByPermalink(db, log = () => {}) {
  const { data, error } = await db.from('marketing_organic_posts')
    .select('post_id,url,source').eq('platform', 'instagram');
  if (error) throw new Error(`dedupe select: ${error.message}`);
  const byUrl = new Map();
  for (const r of data) {
    const key = (r.url || '').split('?')[0].replace(/\/$/, '');
    if (!key) continue;
    if (!byUrl.has(key)) byUrl.set(key, []);
    byUrl.get(key).push(r);
  }
  const toDelete = [];
  for (const rows of byUrl.values()) {
    if (rows.length < 2) continue;
    const hasApi = rows.some((r) => r.source === 'meta_api');
    if (!hasApi) continue;
    for (const r of rows) if (r.source !== 'meta_api') toDelete.push(r.post_id);
  }
  if (!toDelete.length) return 0;
  for (let i = 0; i < toDelete.length; i += 100) {
    const chunk = toDelete.slice(i, i + 100);
    const { error: e2 } = await db.from('marketing_organic_posts').delete().eq('platform', 'instagram').in('post_id', chunk);
    if (e2) throw new Error(`dedupe delete: ${e2.message}`);
  }
  log(`[ig] dedupe: usunięto ${toDelete.length} starych wierszy CSV (zastąpione przez meta_api).`);
  return toDelete.length;
}

// ── Log pobrań ────────────────────────────────────────────────────────────────
async function logStart(db, platform, kind) {
  const { data } = await db.from('marketing_meta_pull_log').insert({ platform, kind }).select('id').single();
  return data && data.id;
}
async function logFinish(db, id, patch) {
  if (!id) return;
  await db.from('marketing_meta_pull_log').update({ ...patch, finished_at: new Date().toISOString() }).eq('id', id);
}

// ── IG: pełny przebieg (media + insighty per post) ────────────────────────────
async function pullIgPosts(db, ctx, { stopBeforeMs = null, log = () => {} } = {}) {
  const id = await logStart(db, 'instagram', stopBeforeMs ? 'weekly' : 'backfill');
  try {
    if (!ctx.igId) throw new Error('Brak IG Business ID (konto IG nie powiązane ze stroną lub token bez uprawnień).');
    const media = await fetchIgMedia(ctx.igId, ctx.pageToken, { stopBeforeMs, log });
    const rows = [];
    let i = 0;
    for (const m of media) {
      const ins = await fetchMediaInsights(m.id, metricsForMedia(m), ctx.pageToken);
      rows.push(mapPostRow(m, ins, ctx.igUsername));
      i += 1; if (i % 25 === 0) log(`[ig] insighty ${i}/${media.length}`);
      await sleep(120);
    }
    const n = await upsertPosts(db, rows);
    let dedup = 0;
    if (!stopBeforeMs && rows.length >= 100) dedup = await dedupeIgByPermalink(db, log);
    await logFinish(db, id, { ok: true, posts_seen: media.length, posts_upsert: n });
    return { platform: 'instagram', mediaSeen: media.length, upserted: n, deduped: dedup };
  } catch (e) {
    await logFinish(db, id, { ok: false, error: e.message });
    throw e;
  }
}

// ── Dzienne: FB Page + IG account ─────────────────────────────────────────────
async function pullDaily(db, ctx, platform, { sinceMs, untilMs, log = () => {} }) {
  const id = await logStart(db, platform, 'daily');
  try {
    const objId = platform === 'facebook' ? PAGE_ID : ctx.igId;
    if (!objId) throw new Error(`Brak ID obiektu dla ${platform}`);
    const metrics = platform === 'facebook' ? FB_DAILY_METRICS : IG_DAILY_METRICS;
    const mapFn = platform === 'facebook' ? mapFbDaily : mapIgDaily;
    const { byDate, dropped } = await fetchDailyRange(objId, metrics, ctx.pageToken, sinceMs, untilMs, log);
    const n = await upsertDaily(db, platform, byDate, mapFn);
    if (dropped.length) log(`[daily ${platform}] metryki niewspierane (pominięte): ${dropped.join(', ')}`);
    await logFinish(db, id, { ok: true, daily_upsert: n });
    return { platform, dailyUpsert: n, days: Object.keys(byDate).length, droppedMetrics: dropped };
  } catch (e) {
    await logFinish(db, id, { ok: false, error: e.message });
    throw e;
  }
}

// ── Publiczne wejścia ─────────────────────────────────────────────────────────
async function runBackfill(db, { platforms = ['instagram', 'facebook'], dailySince = process.env.META_DAILY_SINCE || '2025-01-01', log = console.log } = {}) {
  const token = getToken();
  const ctx = await resolveContext(token);
  log(`[ctx] strona="${ctx.pageName}" ig=@${ctx.igUsername || '-'} (${ctx.igId || 'brak'}) pageToken=${ctx.pageToken ? 'tak' : 'nie'}`);
  const untilMs = Date.now();
  const sinceMs = new Date(dailySince).getTime();
  const result = { ctx: { pageName: ctx.pageName, igUsername: ctx.igUsername, igId: ctx.igId } };
  if (platforms.includes('instagram')) {
    result.igPosts = await pullIgPosts(db, ctx, { log });
    result.igDaily = await pullDaily(db, ctx, 'instagram', { sinceMs, untilMs, log });
  }
  if (platforms.includes('facebook')) {
    result.fbDaily = await pullDaily(db, ctx, 'facebook', { sinceMs, untilMs, log });
  }
  return result;
}

// Cotygodniowy przyrost: świeże media IG (ostatnie `days` dni) + dzienne od ~`days`+3 dni.
async function runWeekly(db, { days = 14, log = console.log } = {}) {
  const token = getToken();
  if (!token) return { skipped: true, reason: 'brak tokena Meta' };
  const ctx = await resolveContext(token);
  const untilMs = Date.now();
  const stopBeforeMs = untilMs - days * DAY;
  const sinceMs = untilMs - (days + 5) * DAY;
  const out = {};
  out.igPosts = await pullIgPosts(db, ctx, { stopBeforeMs, log });
  out.igDaily = await pullDaily(db, ctx, 'instagram', { sinceMs, untilMs, log });
  out.fbDaily = await pullDaily(db, ctx, 'facebook', { sinceMs, untilMs, log });
  return out;
}

// Szybki test tokena/kontekstu (dla trybu --check) — bez zapisu do DB.
async function probe(db) {
  const token = getToken();
  const ctx = await resolveContext(token);
  const sample = ctx.igId ? await fetchIgMedia(ctx.igId, ctx.pageToken, { stopBeforeMs: Date.now() - 400 * DAY, log: () => {} }) : [];
  let firstInsights = null;
  if (sample[0]) firstInsights = await fetchMediaInsights(sample[0].id, metricsForMedia(sample[0]), ctx.pageToken);
  return { ctx: { pageName: ctx.pageName, igUsername: ctx.igUsername, igId: ctx.igId }, igMediaSampled: sample.length, firstMedia: sample[0] && { id: sample[0].id, type: sample[0].media_product_type, ts: sample[0].timestamp }, firstInsights };
}

module.exports = {
  runBackfill, runWeekly, probe, resolveContext, getToken,
  // czyste helpery do testów jednostkowych:
  metricsForMedia, mapPostRow, mapFbDaily, mapIgDaily, cleanMetrics, epoch,
  PAGE_ID, VERSION, FB_DAILY_METRICS, IG_DAILY_METRICS,
};
