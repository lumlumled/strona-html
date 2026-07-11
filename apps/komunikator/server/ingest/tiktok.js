// ── Ingestia komentarzy TikTok (scraper publicznych danych, read-only) ──────
// TikTok nie daje firmom z EOG żadnego API do DM-ów ani komentarzy (blokada
// platformy, nie narzędzi — stan 2026-07). Komentarze pod filmikami są jednak
// publiczne, więc zbieramy je scraperami Apify i wpuszczamy do Komunikatora
// jako wątki read-only: sugestia AI się generuje, Antoni odpowiada ręcznie
// w aplikacji TikToka i klika "Wysłane ręcznie".
//
// Po odłączeniu konta TikTok od Zernio (decyzja Antoniego 2026-07-11, ~$6/mies
// oszczędności) także LISTA filmików idzie ze scrapera — łańcuch dwustopniowy,
// stan między cyklami crona w kom_inbox_raw (source='tiktok_apify'):
//   stage 'profile'  → aktor listuje filmiki profilu (id, commentCount, url);
//                      po sukcesie liczymy kandydatów (licznik > zapisane
//                      i > stan z ostatniego scrapu) i startujemy stage 2
//   stage 'comments' → aktor zbiera komentarze wskazanych filmików;
//                      po sukcesie ingest do kom_* + triage
// Lista profilu odświeża się co APIFY_TIKTOK_LIST_MINUTES (domyślnie 180) —
// częstsze listowanie to realny koszt Apify, a komentarzowy ruch na TikToku
// LumLum jest niewielki. Nowy komentarz pojawia się więc w panelu do ~3,5 h.
//
// Komentarze WŁASNE (autor = TIKTOK_PROFILE) zapisują się jako direction 'out'
// w wątku klienta-rodzica — odpowiedzi z aplikacji domykają wątek same.
const identity = require('../identity');
const triage = require('../triage');

const APIFY_API = 'https://api.apify.com';
// Aktory Clockworks (oficjalne w Apify Store, rozliczane per wynik).
// Podmiana = env var, zero zmian w kodzie.
const DEFAULT_COMMENTS_ACTOR = 'clockworks~tiktok-comments-scraper';
const DEFAULT_LIST_ACTOR = 'clockworks~tiktok-scraper';
const DEFAULT_PROFILE = 'lumlum.led';
const MAX_VIDEOS_PER_RUN = 8;
const VIDEO_MAX_AGE_DAYS = 30;
const COMMENTS_PER_POST = 100;
const LIST_VIDEOS_COUNT = 25;

function apifyToken() {
  return process.env.APIFY_TOKEN || '';
}

function profileHandle() {
  return (process.env.TIKTOK_PROFILE || DEFAULT_PROFILE).replace(/^@/, '');
}

function listIntervalMs() {
  return Number(process.env.APIFY_TIKTOK_LIST_MINUTES || 180) * 60 * 1000;
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

function pick(obj, ...keys) {
  for (const key of keys) {
    const v = obj?.[key];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

// ── Stan łańcucha w kom_inbox_raw (source='tiktok_apify') ───────────────────

async function getPendingRun(db) {
  const { data, error } = await db
    .from('kom_inbox_raw').select('*').eq('source', 'tiktok_apify').eq('processed', false)
    .order('created_at', { ascending: false }).limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

async function lastProfileRunAt(db) {
  const { data, error } = await db
    .from('kom_inbox_raw').select('created_at,payload').eq('source', 'tiktok_apify')
    .order('created_at', { ascending: false }).limit(10);
  if (error) throw error;
  const row = (data || []).find((r) => r.payload?.stage === 'profile');
  return row ? new Date(row.created_at).getTime() : 0;
}

// Licznik komentarzy z ostatniego scrapu per filmik (payload.videos w rekordach
// runów komentarzy). Filmik wraca do scrapowania TYLKO gdy licznik TikToka
// urośnie ponad stan z ostatniego runa — licznik bywa trwale wyższy niż realnie
// dostępne komentarze (skasowane/filtrowane), bez tego scrapowalibyśmy go w kółko.
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

async function ingestedCount(db, videoId) {
  const { count, error } = await db
    .from('kom_messages').select('id', { count: 'exact', head: true })
    .filter('meta->tiktok->>videoId', 'eq', String(videoId));
  if (error) throw error;
  return count || 0;
}

// ── Kandydaci z listy profilu (dataset aktora clockworks~tiktok-scraper) ────

async function candidatesFromItems(db, items) {
  const cutoff = Date.now() - VIDEO_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const scraped = await lastScrapedCounts(db);

  const candidates = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const videoId = pick(item, 'id', 'videoId');
    const url = pick(item, 'webVideoUrl', 'videoUrl');
    const comments = Number(item.commentCount ?? item.stats?.commentCount ?? 0);
    const publishedAt = pick(item, 'createTimeISO');
    if (!videoId || !url || !comments) continue;
    if (publishedAt && new Date(publishedAt).getTime() < cutoff) continue;
    if (scraped.has(videoId) && comments <= scraped.get(videoId)) continue;

    const have = await ingestedCount(db, videoId);
    if (have < comments) {
      candidates.push({ videoId, url, reported: comments, have });
      if (candidates.length >= MAX_VIDEOS_PER_RUN) break;
    }
  }
  return candidates;
}

async function startProfileRun(db) {
  const actor = process.env.APIFY_TIKTOK_LIST_ACTOR || DEFAULT_LIST_ACTOR;
  const { data: run } = await apifyRequest('POST', `/v2/acts/${actor}/runs`, {
    profiles: [profileHandle()],
    resultsPerPage: LIST_VIDEOS_COUNT,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    shouldDownloadSubtitles: false,
    shouldDownloadSlideshowImages: false,
  });
  await db.from('kom_inbox_raw').insert({
    source: 'tiktok_apify',
    payload: { stage: 'profile', runId: run.id, actor, profile: profileHandle() },
  });
  return run.id;
}

async function startCommentsRun(db, videos) {
  const actor = process.env.APIFY_TIKTOK_ACTOR || DEFAULT_COMMENTS_ACTOR;
  const { data: run } = await apifyRequest('POST', `/v2/acts/${actor}/runs`, {
    postURLs: videos.map((v) => v.url),
    commentsPerPost: COMMENTS_PER_POST,
  });
  await db.from('kom_inbox_raw').insert({
    source: 'tiktok_apify',
    payload: { stage: 'comments', runId: run.id, actor, videos, ownUsername: profileHandle() },
  });
  return run.id;
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
  const toClassify = []; // klasyfikacja po pętli — na końcu znamy całe wątki

  for (const c of mapped) {
    const own = ownUsername && c.authorHandle && c.authorHandle.toLowerCase() === ownUsername.toLowerCase();

    // Własna odpowiedź (autor = nasze konto) należy do wątku klienta, pod
    // którego komentarzem odpowiedzieliśmy — nigdy do własnego wątku.
    // Własny komentarz bez rodzica (top-level pod swoim filmem) pomijamy.
    let threadId;
    let threadObj = null;
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
      threadObj = thread;
    }

    const { data: inserted, error: msgErr } = await db.from('kom_messages').insert({
      thread_id: threadId,
      direction: own ? 'out' : 'in',
      body: c.text,
      sent_by: own ? 'antoni' : 'customer',
      external_message_id: `tt:${c.commentId}`,
      created_at: c.createdAt,
      ...(own ? { triage: 'inbox' } : {}),
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
    }).select('id');
    if (msgErr) {
      if (/duplicate|unique/i.test(msgErr.message)) { duplicates += 1; continue; }
      throw msgErr;
    }
    added += 1;
    if (!own && threadObj) toClassify.push({ thread: threadObj, messageId: inserted[0].id, comment: c });

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

  // Triage: komentarz przechodzi selektywny filtr zakupowy (kontekst crona —
  // spokojny budżet czasu; porażka = triage NULL, sweep dokończy).
  for (const job of toClassify) {
    await triage.classifyInWebhook(db, job.thread, job.messageId, {
      kind: 'comment',
      channel: 'tiktok',
      text: job.comment.text,
      senderName: job.comment.authorName || (job.comment.authorHandle ? `@${job.comment.authorHandle}` : null),
      senderType: 'tt',
      senderValue: job.comment.authorId || `@${job.comment.authorHandle}`,
      history: [],
    }, 20000);
  }
  return { added, duplicates, threads: threadTouch.size, classified: toClassify.length };
}

// ── Główne wejście crona ─────────────────────────────────────────────────────

async function syncTikTokComments(db) {
  if (!apifyToken()) return { ok: true, skipped: 'brak APIFY_TOKEN — komentarze TikTok czekają na konto Apify' };
  const result = { ok: true };

  // Faza 1: dokończ wiszący run (profil albo komentarze).
  const pending = await getPendingRun(db);
  if (pending) {
    const stage = pending.payload?.stage || 'comments';
    const runId = pending.payload?.runId;
    const { data: run } = await apifyRequest('GET', `/v2/actor-runs/${runId}`);
    if (run.status === 'SUCCEEDED') {
      const items = await apifyRequest('GET', `/v2/datasets/${run.defaultDatasetId}/items?clean=true&limit=5000`);
      if (stage === 'profile') {
        const candidates = await candidatesFromItems(db, Array.isArray(items) ? items : []);
        await db.from('kom_inbox_raw').update({ processed: true }).eq('id', pending.id);
        if (candidates.length) {
          result.commentsRun = await startCommentsRun(db, candidates);
          result.candidates = candidates.length;
        } else {
          result.candidates = 0;
        }
      } else {
        const ingest = await ingestComments(db, Array.isArray(items) ? items : [], {
          ownUsername: pending.payload?.ownUsername || profileHandle(),
        });
        await db.from('kom_inbox_raw').update({ processed: true }).eq('id', pending.id);
        Object.assign(result, ingest, { finishedRun: runId });
      }
    } else if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(run.status)) {
      await db.from('kom_inbox_raw').update({ processed: true, error: `run ${stage} ${run.status}` }).eq('id', pending.id);
      result.failedRun = `${runId}: ${run.status}`;
    } else {
      // RUNNING/READY — poczekaj do następnego cyklu, nie odpalaj drugiego.
      return { ok: true, waitingForRun: `${stage}:${runId}` };
    }
  }

  // Faza 2: świeża lista filmików, jeśli poprzednia jest starsza niż interwał.
  const { data: stillPending } = await db
    .from('kom_inbox_raw').select('id').eq('source', 'tiktok_apify').eq('processed', false).limit(1);
  if (!stillPending || !stillPending.length) {
    const lastList = await lastProfileRunAt(db);
    if (Date.now() - lastList >= listIntervalMs()) {
      result.profileRun = await startProfileRun(db);
    }
  }
  return result;
}

module.exports = { syncTikTokComments, ingestComments, mapItem };
