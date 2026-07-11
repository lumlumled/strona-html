// ── Ingestia komentarzy TikTok (scraper publicznych danych, read-only) ──────
// TikTok nie daje firmom z EOG żadnego API do DM-ów ani komentarzy (blokada
// platformy, nie narzędzi — stan 2026-07). Komentarze pod filmikami są jednak
// publiczne, więc zbieramy je scraperem Apify i wpuszczamy do Komunikatora
// jako wątki read-only: sugestia AI się generuje, Antoni odpowiada ręcznie
// w aplikacji TikToka i klika "Wysłane ręcznie".
//
// Przebieg (cron /api/cron/tiktok-comments co 30 min):
//   1. Jeśli wisi niedokończony run Apify → sprawdź status; SUCCEEDED →
//      pobierz dataset i zapisz komentarze; w trakcie → nic nie rób.
//   2. Bez wiszącego runa → kandydaci z Zernio (natywne posty TikToka,
//      GET /v1/posts?source=external): filmiki z ostatnich 30 dni, w których
//      licznik komentarzy > liczba komentarzy już zapisanych u nas →
//      start nowego runa Apify (stan w kom_inbox_raw, source='tiktok_apify').
// Komentarze lądują więc z opóźnieniem max ~1 cyklu crona (≤1 h) — dla
// komentarzy pod postami w zupełności wystarcza, a scraping kosztuje tylko
// wtedy, gdy realnie coś przybyło.
//
// Komentarze WŁASNE (autor = podpięte konto lumlum.led) zapisują się jako
// direction 'out' — odpowiedzi udzielone w aplikacji domykają wątek same.
const identity = require('../identity');

const APIFY_API = 'https://api.apify.com';
// Aktor "TikTok Comments Scraper" od Clockworks (oficjalny w Apify Store,
// rozliczany per wynik). Podmiana aktora = env var, zero zmian w kodzie.
const DEFAULT_ACTOR = 'clockworks~tiktok-comments-scraper';
const MAX_VIDEOS_PER_RUN = 8;
const VIDEO_MAX_AGE_DAYS = 30;
const COMMENTS_PER_POST = 100;

function apifyToken() {
  return process.env.APIFY_TOKEN || '';
}

async function apifyRequest(method, pathname, body) {
  const url = `${APIFY_API}${pathname}${pathname.includes('?') ? '&' : '?'}token=${encodeURIComponent(apifyToken())}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Apify ${method} ${pathname} → ${res.status}: ${raw.slice(0, 300)}`);
  return raw ? JSON.parse(raw) : {};
}

async function zernioGet(pathname) {
  const res = await fetch(`https://zernio.com/api${pathname}`, {
    headers: { Authorization: `Bearer ${process.env.ZERNIO_API_KEY}` },
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Zernio GET ${pathname} → ${res.status}: ${raw.slice(0, 300)}`);
  return raw ? JSON.parse(raw) : {};
}

function pick(obj, ...keys) {
  for (const key of keys) {
    const v = obj?.[key];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

// ── Stan runa Apify w kom_inbox_raw (source='tiktok_apify') ─────────────────

async function getPendingRun(db) {
  const { data, error } = await db
    .from('kom_inbox_raw').select('*').eq('source', 'tiktok_apify').eq('processed', false)
    .order('created_at', { ascending: false }).limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

// ── Kandydaci: filmiki, w których przybyło komentarzy ───────────────────────

async function tiktokAccount() {
  const { accounts = [] } = await zernioGet('/v1/accounts');
  return accounts.find((a) => a.platform === 'tiktok' && a.isActive) || null;
}

async function ingestedCount(db, videoId) {
  const { count, error } = await db
    .from('kom_messages').select('id', { count: 'exact', head: true })
    .filter('meta->tiktok->>videoId', 'eq', String(videoId));
  if (error) throw error;
  return count || 0;
}

// Licznik komentarzy z ostatniego scrapu per filmik (payload.videos w rekordach
// runów). Filmik wraca do scrapowania TYLKO gdy licznik TikToka urośnie ponad
// stan z ostatniego runa — licznik bywa trwale wyższy niż realnie dostępne
// komentarze (skasowane/filtrowane), bez tego scrapowalibyśmy go co cykl.
async function lastScrapedCounts(db) {
  const { data, error } = await db
    .from('kom_inbox_raw').select('payload').eq('source', 'tiktok_apify')
    .order('created_at', { ascending: false }).limit(20);
  if (error) throw error;
  const map = new Map();
  for (const row of data || []) {
    for (const v of row.payload?.videos || []) {
      const key = String(v.videoId);
      if (!map.has(key)) map.set(key, v.reported || 0);
    }
  }
  return map;
}

// Liczniki komentarzy daje endpoint analytics (GET /v1/posts?source=external
// zwraca posty BEZ analytics — sprawdzone na żywo 2026-07-11, wbrew ich
// dokumentacji ExternalPostSummary).
async function candidateVideos(db, accountId) {
  const { posts = [] } = await zernioGet(`/v1/analytics?source=external&accountId=${encodeURIComponent(accountId)}&limit=30`);
  const cutoff = Date.now() - VIDEO_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const scraped = await lastScrapedCounts(db);

  const candidates = [];
  for (const post of posts) {
    if (post.platform && post.platform !== 'tiktok') continue;
    const comments = post.analytics?.comments || 0;
    if (!comments) continue;
    if (post.publishedAt && new Date(post.publishedAt).getTime() < cutoff) continue;
    const plat = (post.platforms || []).find((p) => p.platform === 'tiktok') || {};
    const url = post.platformPostUrl || plat.platformPostUrl;
    const videoId = plat.platformPostId || (String(url || '').match(/video\/(\d+)/) || [])[1];
    if (!url || !videoId) continue;
    if (scraped.has(String(videoId)) && comments <= scraped.get(String(videoId))) continue;

    const have = await ingestedCount(db, videoId);
    if (have < comments) {
      candidates.push({ videoId, url, reported: comments, have });
      if (candidates.length >= MAX_VIDEOS_PER_RUN) break;
    }
  }
  return candidates;
}

// ── Zapis komentarzy do wspólnego modelu ────────────────────────────────────
// Mapowanie pól defensywne: aktory Apify różnią się nazwami (cid/id,
// uniqueId/user.uniqueId itd.), a podmiana aktora nie może wymagać zmian tu.

function mapItem(item) {
  const user = item.user || {};
  const videoUrl = pick(item, 'videoWebUrl', 'postUrl', 'awemeUrl', 'videoUrl');
  return {
    commentId: pick(item, 'cid', 'id', 'commentId'),
    text: pick(item, 'text', 'comment', 'content'),
    authorId: pick(item, 'uid', 'userId') || pick(user, 'id', 'uid'),
    authorHandle: pick(item, 'uniqueId') || pick(user, 'uniqueId', 'username'),
    authorName: pick(user, 'nickname', 'nickName') || pick(item, 'nickname'),
    videoId: pick(item, 'awemeId', 'videoId') || (videoUrl.match(/video\/(\d+)/) || [])[1] || '',
    videoUrl,
    isReply: Boolean(pick(item, 'repliesToId', 'replyToId', 'parentCommentId')),
    parentCommentId: pick(item, 'repliesToId', 'replyToId', 'parentCommentId') || null,
    createdAt: (() => {
      const t = Number(pick(item, 'createTime', 'createTimeISO', 'timestamp'));
      if (Number.isFinite(t) && t > 0) return new Date(t < 1e12 ? t * 1000 : t).toISOString();
      const iso = pick(item, 'createTimeISO');
      return iso ? new Date(iso).toISOString() : new Date().toISOString();
    })(),
  };
}

async function ingestComments(db, items, { ownUsername }) {
  const mapped = items.map(mapItem)
    .filter((c) => c.commentId && c.text && (c.authorId || c.authorHandle))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  let added = 0;
  let duplicates = 0;
  const threadTouch = new Map(); // thread.id → { lastAt, status }

  for (const c of mapped) {
    const own = ownUsername && c.authorHandle && c.authorHandle.toLowerCase() === ownUsername.toLowerCase();

    // Własna odpowiedź (autor = nasze konto) należy do wątku klienta, pod
    // którego komentarzem odpowiedzieliśmy — nigdy do własnego wątku.
    // Własny komentarz bez rodzica (top-level pod swoim filmem) pomijamy.
    let threadId;
    if (own) {
      if (!c.parentCommentId) continue;
      const { data: parents, error: parentErr } = await db
        .from('kom_messages').select('thread_id')
        .eq('external_message_id', `tt:${c.parentCommentId}`).limit(1);
      if (parentErr) throw parentErr;
      if (!parents || !parents[0]) continue; // rodzic spoza naszej bazy
      threadId = parents[0].thread_id;
    } else {
      const identityValue = c.authorId || `@${c.authorHandle}`;
      const displayName = c.authorName || (c.authorHandle ? `@${c.authorHandle}` : null);
      const { customer } = await identity.resolveCustomer(db, {
        type: 'tt', value: identityValue, displayName, source: 'webhook',
      });
      const { thread } = await identity.attachThread(db, customer, 'tiktok', `comments:tt:${identityValue}`);
      if (!thread.meta?.tiktok) {
        const meta = { ...(thread.meta || {}), tiktok: { kind: 'comments', username: c.authorHandle || null } };
        await db.from('kom_threads').update({ meta }).eq('id', thread.id);
        thread.meta = meta;
      }
      threadId = thread.id;
    }

    const { error: msgErr } = await db.from('kom_messages').insert({
      thread_id: threadId,
      direction: own ? 'out' : 'in',
      body: c.text,
      sent_by: own ? 'antoni' : 'customer',
      external_message_id: `tt:${c.commentId}`,
      created_at: c.createdAt,
      meta: {
        kind: 'comment',
        tiktok: {
          commentId: c.commentId,
          videoId: c.videoId || null,
          videoUrl: c.videoUrl || null,
          username: c.authorHandle || null,
          isReply: c.isReply,
          parentCommentId: c.parentCommentId,
        },
      },
    });
    if (msgErr) {
      if (/duplicate|unique/i.test(msgErr.message)) { duplicates += 1; continue; }
      throw msgErr;
    }
    added += 1;

    const touch = threadTouch.get(threadId) || {};
    if (!touch.lastAt || c.createdAt > touch.lastAt) {
      // Nowy komentarz klienta = do ogarnięcia; własna odpowiedź z aplikacji
      // domyka na 'waiting' (jak wysyłka z panelu na innych kanałach).
      threadTouch.set(threadId, { lastAt: c.createdAt, status: own ? 'waiting' : 'attention' });
    }
  }

  for (const [threadId, touch] of threadTouch) {
    await db.from('kom_threads')
      .update({ status: touch.status, last_message_at: touch.lastAt })
      .eq('id', threadId);
  }
  return { added, duplicates, threads: threadTouch.size };
}

// ── Główne wejście crona ─────────────────────────────────────────────────────

async function syncTikTokComments(db) {
  if (!apifyToken()) return { ok: true, skipped: 'brak APIFY_TOKEN — komentarze TikTok czekają na konto Apify' };
  if (!process.env.ZERNIO_API_KEY) return { ok: false, error: 'brak ZERNIO_API_KEY' };

  const actor = process.env.APIFY_TIKTOK_ACTOR || DEFAULT_ACTOR;
  const result = { ok: true };

  // Faza 1: dokończ wiszący run.
  const pending = await getPendingRun(db);
  if (pending) {
    const runId = pending.payload?.runId;
    const { data: run } = await apifyRequest('GET', `/v2/actor-runs/${runId}`);
    if (run.status === 'SUCCEEDED') {
      const items = await apifyRequest('GET', `/v2/datasets/${run.defaultDatasetId}/items?clean=true&limit=5000`);
      const account = await tiktokAccount();
      const ingest = await ingestComments(db, Array.isArray(items) ? items : [], {
        ownUsername: account?.username || pending.payload?.ownUsername || '',
      });
      await db.from('kom_inbox_raw').update({ processed: true }).eq('id', pending.id);
      Object.assign(result, ingest, { finishedRun: runId });
    } else if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(run.status)) {
      await db.from('kom_inbox_raw').update({ processed: true, error: `run ${run.status}` }).eq('id', pending.id);
      result.failedRun = `${runId}: ${run.status}`;
    } else {
      // RUNNING/READY — poczekaj do następnego cyklu, nie odpalaj drugiego.
      return { ok: true, waitingForRun: runId };
    }
  }

  // Faza 2: nowy run, jeśli gdzieś przybyło komentarzy.
  const account = await tiktokAccount();
  if (!account) return { ...result, started: false, error: 'brak aktywnego konta TikTok w Zernio' };
  const videos = await candidateVideos(db, account._id);
  if (!videos.length) return { ...result, started: false, candidates: 0 };

  const { data: run } = await apifyRequest('POST', `/v2/acts/${actor}/runs`, {
    postURLs: videos.map((v) => v.url),
    commentsPerPost: COMMENTS_PER_POST,
  });
  await db.from('kom_inbox_raw').insert({
    source: 'tiktok_apify',
    payload: { runId: run.id, actor, videos, ownUsername: account.username || '' },
  });
  return { ...result, started: run.id, candidates: videos.length };
}

module.exports = { syncTikTokComments, ingestComments, mapItem };
