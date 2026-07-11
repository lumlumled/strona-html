// Komunikator — panel "Wiadomości" (lumlum.dev/wiadomosci): zunifikowana
// komunikacja przychodząca (Messenger/IG/WhatsApp przez Zernio, telefon
// przez Zadarmę — Etap 3, notatki głosowe) z jedną kartą klienta LL-XXXXX.
// Pełna architektura: docs/plan-komunikator.md (sekcja ⚡ = pivot na Zernio).
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config();
const fs = require('fs');
const express = require('express');
const { getClient } = require('./supabase');
const { createAuth, clientPayload, panelLinks, PANELS, CRM_SHEETS } = require('../../shared/server/auth');
const { servePushWorker, registerPushEndpoints } = require('../../shared/server/push');
const identity = require('./identity');
const zernio = require('./ingest/zernio');
const tiktok = require('./ingest/tiktok');
const gmail = require('./ingest/gmail');
const triage = require('./triage');
const suggest = require('./suggest');

const app = express();
// rawBody potrzebny do weryfikacji X-Zernio-Signature (HMAC surowego body).
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: false }));

// Patrz apps/backlog-b2c/server/server.js — bez no-store Vercel CDN
// cache'owałby odpowiedzi po zalogowaniu i serwował je każdemu.
app.use((req, res, next) => {
  if (!req.path.startsWith('/assets/')) res.set('Cache-Control', 'no-store');
  next();
});

// Statyki przed bramką auth (strona logowania potrzebuje logo/styli).
app.get('/assets/:file', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'assets', req.params.file));
});
app.get('/shared/:file', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'shared', req.params.file));
});

// ── Webhooki: podpis HMAC zamiast sesji użytkownika ─────────────────────────
// publicPrefixes w createAuth wyłącza bramkę logowania dla /api/webhooks/.
// Zernio podpisuje każdy request sekretem webhooka (X-Zernio-Signature =
// hex HMAC-SHA256 surowego body) — patrz scripts/register-zernio-webhook.js.

app.post('/api/webhooks/zernio', async (req, res) => {
  const secret = process.env.ZERNIO_WEBHOOK_SECRET;
  if (!secret) return res.status(500).json({ error: 'Brak ZERNIO_WEBHOOK_SECRET w konfiguracji serwera' });
  if (!zernio.verifySignature(req.rawBody, req.get('X-Zernio-Signature'), secret)) {
    return res.status(401).json({ error: 'Nieprawidłowy podpis webhooka' });
  }
  try {
    const result = await zernio.handleWebhook(getClient(), req.body || {});
    res.json(result);
  } catch (err) {
    console.error('Webhook Zernio:', err.message);
    // 200 zamiast 4xx/5xx dla błędów treści payloadu — Zernio nie będzie
    // retry'ował w kółko (7 prób/~51 h) czegoś, co i tak jest niepoprawne;
    // payload leży w kom_inbox_raw z opisem błędu do ręcznego obejrzenia.
    res.json({ ok: false, error: err.message });
  }
});

// ── Cron: komentarze TikTok przez scraper (patrz ingest/tiktok.js) ──────────
// Ten sam wzorzec autoryzacji co crony Backlogu: Vercel wysyła
// Authorization: Bearer CRON_SECRET; ręczne odpalenie przez ?secret=.

function isCronAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.authorization === `Bearer ${secret}` || req.query.secret === secret;
}

// Worker: synchronizacja komentarzy TikTok + sweep triage (dokańcza
// klasyfikację wiadomości, których LLM nie zdążył ocenić w webhooku).
// /api/cron/tiktok-comments zostaje jako alias — wskazuje na niego
// dzienny fallback w vercel.json i historyczne wpisy pg_cron.
async function runWorker(req, res) {
  if (!isCronAuthorized(req)) return res.status(401).json({ error: 'Brak autoryzacji' });
  const db = getClient();
  const result = {};
  try {
    result.tiktok = await tiktok.syncTikTokComments(db);
  } catch (err) {
    console.error('Worker (tiktok):', err.message);
    result.tiktok = { ok: false, error: err.message };
  }
  try {
    result.gmail = await gmail.syncGmail(db);
  } catch (err) {
    console.error('Worker (gmail):', err.message);
    result.gmail = { ok: false, error: err.message };
  }
  try {
    result.gmailWatch = await gmail.ensureWatch(db);
  } catch (err) {
    console.error('Worker (gmail watch):', err.message);
    result.gmailWatch = { error: err.message };
  }
  try {
    result.triage = await triage.sweep(db);
  } catch (err) {
    console.error('Worker (triage):', err.message);
    result.triage = { error: err.message };
  }
  console.log('Cron worker:', JSON.stringify(result));
  res.json(result);
}

app.all('/api/cron/worker', runWorker);
app.all('/api/cron/tiktok-comments', runWorker);

// Push z Gmaila (Pub/Sub push subscription). Powiadomienie to tylko dzwonek —
// treść i tak bierzemy z Gmail API (syncGmail, idempotentny). Token w query
// stringu weryfikuje, że to nasza subskrypcja. 200 zawsze szybko, żeby
// Pub/Sub nie retry'ował w nieskończoność.
app.post('/api/webhooks/gmail', async (req, res) => {
  const expected = process.env.GMAIL_PUSH_TOKEN;
  if (!expected || req.query.token !== expected) {
    return res.status(401).json({ error: 'Nieprawidłowy token' });
  }
  try {
    const result = await gmail.syncGmail(getClient());
    res.json({ ok: true, added: result.added || 0 });
  } catch (err) {
    console.error('Webhook Gmail push:', err.message);
    res.json({ ok: false, error: err.message });
  }
});

// Lekki cron TYLKO dla Gmaila (pg_cron co 1 min w godzinach pracy) — mail
// pojawia się w panelu w ≤60 s nawet zanim push przez Pub/Sub jest skonfigurowany
// (a po konfiguracji zostaje jako siatka bezpieczeństwa, gdyby push przepadł).
app.all('/api/cron/gmail', async (req, res) => {
  if (!isCronAuthorized(req)) return res.status(401).json({ error: 'Brak autoryzacji' });
  try {
    res.json(await gmail.syncGmail(getClient()));
  } catch (err) {
    console.error('Cron gmail:', err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ── Auth: to samo indywidualne logowanie co hub/CRM, panel 'wiadomosci' ─────

const auth = createAuth({
  getClient,
  panelKey: 'wiadomosci',
  publicPrefixes: ['/api/webhooks/', '/api/cron/'],
  loginTitle: 'Wiadomości',
});
// /sw.js przed bramką auth (publiczny statyk — patrz apps/shared/server/push.js),
// endpointy /api/push/* za bramką (user z sesji).
servePushWorker(app);
auth.register(app);
registerPushEndpoints(app, { getClient });

const APP_HTML = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');

app.get('/', (req, res) => {
  const payload = {
    API_BASE: req.baseUrl,
    LUMLUM_USER: clientPayload(req.user),
    LUMLUM_LINKS: panelLinks(),
    LUMLUM_PANELS: PANELS,
    LUMLUM_CRM_SHEETS: CRM_SHEETS,
  };
  const script = Object.entries(payload)
    .map(([key, value]) => `window.${key} = ${JSON.stringify(value)};`)
    .join('\n');
  res.type('html').send(APP_HTML.replace('<head>', `<head>\n<script>\n${script}\n</script>`));
});

function handleError(res, err, fallbackStatus = 400) {
  console.error(err);
  const message = err.message || 'Wewnętrzny błąd serwera';
  const status = /brak/i.test(message) ? 500 : fallbackStatus;
  res.status(status).json({ error: message });
}

// ── Okna wysyłki Meta ────────────────────────────────────────────────────────
// Standardową wiadomość na Messengerze/IG/WhatsAppie wolno wysłać do 24 h od
// ostatniej wiadomości klienta (polityka Meta). Na FB/IG tag HUMAN_AGENT
// (odpowiedź człowieka) rozciąga to do 7 dni — Zernio przyjmuje go w polu
// messageTag. WhatsApp poza oknem wymaga szablonów (wejdzie z WhatsAppem).
// UWAGA: komentarz pod postem (meta.kind='comment') NIE otwiera okna DM;
// zamiast tego działa private reply: 1 wiadomość na komentarz, do 7 dni.
const WINDOWED_CHANNELS = new Set(['messenger', 'instagram', 'whatsapp']);
const HUMAN_AGENT_CHANNELS = new Set(['messenger', 'instagram']);
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function opensWindow(message) {
  return message.direction === 'in' && message.meta?.kind !== 'comment';
}

function windowExpiresAt(thread, lastInboundAt) {
  if (!WINDOWED_CHANNELS.has(thread.channel) || !lastInboundAt) return null;
  return new Date(new Date(lastInboundAt).getTime() + 24 * 60 * 60 * 1000).toISOString();
}

function humanAgentExpiresAt(thread, lastInboundAt) {
  if (!HUMAN_AGENT_CHANNELS.has(thread.channel) || !lastInboundAt) return null;
  return new Date(new Date(lastInboundAt).getTime() + SEVEN_DAYS_MS).toISOString();
}

function isCommentsThread(thread) {
  return thread.meta?.zernio?.kind === 'comments';
}

// Jedno źródło prawdy o tym, czy i jak da się wysłać — używane przez widok
// wątku (UI dobiera komunikat i przyciski) oraz endpoint wysyłki (twarda
// walidacja). messagesAsc = wszystkie wiadomości wątku rosnąco po czasie.
function computeSendState(thread, messagesAsc) {
  const now = new Date();

  // Tryb manual_only: sugestia AI się generuje, ale wysyłka jest ręczna
  // (Kopiuj treść → odpowiedz u źródła → "Wysłane ręcznie"). reply_url/label
  // prowadzą prosto do miejsca odpowiedzi.
  if (thread.channel === 'tiktok') {
    const lastComment = [...messagesAsc].reverse()
      .find((m) => m.direction === 'in' && m.meta?.kind === 'comment');
    return {
      mode: 'manual_only',
      reply_url: lastComment?.meta?.tiktok?.videoUrl || null,
      reply_label: 'Otwórz film w TikTok ↗',
      note: 'Komentarz na TikToku (tylko odczyt — brak API). Skopiuj treść, odpowiedz pod filmem i kliknij „Wysłane ręcznie”.',
    };
  }
  if (thread.channel === 'email') {
    // Wysyłka przez Gmail API (scope gmail.modify obejmuje send): adresata,
    // temat i nagłówki wątkowania bierzemy z ostatniego maila klienta.
    const lastIn = [...messagesAsc].reverse()
      .find((m) => m.direction === 'in' && m.meta?.gmail?.from);
    const gmailThreadId = thread.meta?.gmail?.threadId || lastIn?.meta?.gmail?.threadId;
    if (lastIn && gmailThreadId) {
      return {
        mode: 'gmail',
        reply_url: `https://mail.google.com/mail/u/0/#all/${gmailThreadId}`,
        reply_label: 'Otwórz w Gmailu ↗',
        email: {
          to: lastIn.meta.gmail.from,
          subject: lastIn.meta.gmail.subject || '',
          threadId: gmailThreadId,
          lastMessageId: lastIn.meta.gmail.id || null,
          // skrzynka wątku (multi-user): odpowiedź wychodzi z tej skrzynki,
          // do której klient napisał; null = jedyna podłączona (fallback).
          mailbox: thread.meta?.gmail?.mailbox || lastIn.meta.gmail.mailbox || null,
        },
      };
    }
    // Wątek bez metadanych Gmaila (np. założony ręcznie): zostaje tryb ręczny.
    return {
      mode: 'manual_only',
      reply_url: gmailThreadId ? `https://mail.google.com/mail/u/0/#all/${gmailThreadId}` : 'https://mail.google.com/',
      reply_label: 'Otwórz w Gmailu ↗',
      note: 'E-mail bez danych wątku Gmaila: skopiuj odpowiedź, wyślij z Gmaila i kliknij „Wysłane ręcznie”.',
    };
  }

  if (isCommentsThread(thread)) {
    const lastComment = [...messagesAsc].reverse()
      .find((m) => m.direction === 'in' && m.meta?.kind === 'comment');
    const commentId = lastComment?.meta?.zernio?.commentId;
    if (!lastComment || !commentId) return { mode: 'closed', reason: 'no_comment' };
    const replied = messagesAsc.some((m) => m.direction === 'out' && m.meta?.private_reply_to === commentId);
    const expiresAt = new Date(new Date(lastComment.created_at).getTime() + SEVEN_DAYS_MS).toISOString();
    if (replied) return { mode: 'closed', reason: 'already_replied', comment_reply_expires_at: expiresAt };
    if (new Date(expiresAt) < now) return { mode: 'closed', reason: 'expired', comment_reply_expires_at: expiresAt };
    return {
      mode: 'private_reply',
      comment_reply_expires_at: expiresAt,
      comment: { commentId, postId: lastComment.meta.zernio.postId },
    };
  }

  if (!WINDOWED_CHANNELS.has(thread.channel)) return { mode: 'none' };
  const lastIn = [...messagesAsc].reverse().find(opensWindow);
  if (!lastIn) return { mode: 'closed', reason: 'no_inbound' };
  const window24 = windowExpiresAt(thread, lastIn.created_at);
  const window7d = humanAgentExpiresAt(thread, lastIn.created_at);
  const base = { window_expires_at: window24, human_agent_expires_at: window7d };
  if (new Date(window24) > now) return { mode: 'open', ...base };
  if (window7d && new Date(window7d) > now) return { mode: 'human_agent', ...base };
  return { mode: 'closed', reason: 'expired', ...base };
}

// ── API wątków ───────────────────────────────────────────────────────────────

// Widoki listy: main = otwarte przefiltrowane (triage inbox) — selekcja
// Antoniego; notifications = automaty do ogarnięcia; closed; all = wszystko
// łącznie z odfiltrowanym syfem (celowo "bardziej ukryty" dostęp do całości).
app.get('/api/threads', async (req, res) => {
  try {
    const db = getClient();
    const view = String(req.query.view || req.query.status || 'main');
    let query = db.from('kom_threads').select('*').order('last_message_at', { ascending: false, nullsFirst: false });
    if (view === 'main' || view === 'open') query = query.in('status', ['attention', 'waiting']).eq('triage', 'inbox');
    else if (view === 'notifications') query = query.in('status', ['attention', 'waiting']).eq('triage', 'notification');
    else if (view !== 'all') query = query.eq('status', view);
    const { data: threads, error } = await query.limit(200);
    if (error) throw error;

    const customerIds = [...new Set((threads || []).map((t) => t.customer_id))];
    const threadIds = (threads || []).map((t) => t.id);

    const [customersRes, messagesRes, proposalsRes] = await Promise.all([
      customerIds.length
        ? db.from('kom_customers').select('*').in('id', customerIds)
        : { data: [] },
      threadIds.length
        ? db.from('kom_messages').select('thread_id,direction,body,created_at,meta')
            .in('thread_id', threadIds).order('created_at', { ascending: false }).limit(600)
        : { data: [] },
      threadIds.length
        ? db.from('kom_merge_proposals').select('thread_id').in('thread_id', threadIds).eq('status', 'pending')
        : { data: [] },
    ]);
    if (customersRes.error) throw customersRes.error;
    if (messagesRes.error) throw messagesRes.error;

    const customers = new Map((customersRes.data || []).map((c) => [c.id, c]));
    const lastMsg = new Map();
    const lastInbound = new Map();
    (messagesRes.data || []).forEach((m) => {
      if (!lastMsg.has(m.thread_id)) lastMsg.set(m.thread_id, m);
      if (opensWindow(m) && !lastInbound.has(m.thread_id)) lastInbound.set(m.thread_id, m.created_at);
    });
    const pendingMerge = new Set((proposalsRes.data || []).map((p) => p.thread_id));

    res.json({
      data: (threads || []).map((t) => {
        const customer = customers.get(t.customer_id) || {};
        const last = lastMsg.get(t.id);
        return {
          id: t.id,
          channel: t.channel,
          status: t.status,
          triage: t.triage,
          triage_reason: t.triage_reason,
          last_message_at: t.last_message_at,
          customer: {
            id: customer.id,
            public_id: customer.public_id,
            display_name: customer.display_name,
          },
          last_message: last ? { direction: last.direction, body: String(last.body).slice(0, 140) } : null,
          window_expires_at: windowExpiresAt(t, lastInbound.get(t.id)),
          has_pending_merge: pendingMerge.has(t.id),
        };
      }),
    });
  } catch (err) {
    handleError(res, err, 502);
  }
});

app.get('/api/threads/:id', async (req, res) => {
  try {
    const db = getClient();
    const { data: threads, error } = await db.from('kom_threads').select('*').eq('id', req.params.id).limit(1);
    if (error) throw error;
    const thread = threads && threads[0];
    if (!thread) return res.status(404).json({ error: 'Nie znaleziono wątku' });

    const customer = await identity.loadCustomer(db, thread.customer_id);
    const [messagesRes, identitiesRes, proposalsRes, threadsRes] = await Promise.all([
      db.from('kom_messages').select('*').eq('thread_id', thread.id).order('created_at', { ascending: true }).limit(500),
      db.from('kom_customer_identities').select('*').eq('customer_id', customer.id),
      db.from('kom_merge_proposals').select('*').eq('thread_id', thread.id).eq('status', 'pending'),
      db.from('kom_threads').select('*').eq('customer_id', customer.id),
    ]);
    for (const r of [messagesRes, identitiesRes, proposalsRes, threadsRes]) if (r.error) throw r.error;

    // Kandydaci propozycji scalenia — z nazwą, żeby UI miał co pokazać.
    const proposals = proposalsRes.data || [];
    const candidateIds = [...new Set(proposals.map((p) => p.candidate_id))];
    let candidates = new Map();
    if (candidateIds.length) {
      const { data: cands, error: candErr } = await db.from('kom_customers').select('*').in('id', candidateIds);
      if (candErr) throw candErr;
      candidates = new Map((cands || []).map((c) => [c.id, c]));
    }

    const sendState = computeSendState(thread, messagesRes.data || []);

    res.json({
      thread,
      customer: {
        id: customer.id,
        public_id: customer.public_id,
        display_name: customer.display_name,
        notes: customer.notes,
        identities: (identitiesRes.data || []).map((i) => ({ type: i.type, value: i.value, confirmed: i.confirmed })),
        threads: (threadsRes.data || []).map((t) => ({ id: t.id, channel: t.channel, status: t.status })),
      },
      messages: messagesRes.data || [],
      send: sendState,
      window_expires_at: sendState.window_expires_at || null,
      merge_proposals: proposals.map((p) => ({
        id: p.id,
        reason: p.reason,
        evidence: p.evidence,
        confidence: p.confidence,
        candidate: (() => {
          const c = candidates.get(p.candidate_id);
          return c ? { public_id: c.public_id, display_name: c.display_name } : null;
        })(),
      })),
    });
  } catch (err) {
    handleError(res, err, 502);
  }
});

app.post('/api/threads/:id/status', async (req, res) => {
  try {
    const status = String(req.body?.status || '');
    if (!['attention', 'waiting', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'Nieprawidłowy status' });
    }
    const db = getClient();
    const { error } = await db.from('kom_threads').update({ status }).eq('id', req.params.id);
    if (error) throw error;
    // Odłożony/zamknięty wątek = wisząca sugestia była zignorowana.
    if (status !== 'attention') await suggest.ignorePendingSuggestions(db, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err, 502);
  }
});

// ── Sugestia AI (lazy — generowana na otwarcie wątku w panelu) ──────────────

app.post('/api/threads/:id/suggestion', async (req, res) => {
  try {
    const db = getClient();
    const { data: threads, error } = await db.from('kom_threads').select('*').eq('id', req.params.id).limit(1);
    if (error) throw error;
    const thread = threads && threads[0];
    if (!thread) return res.status(404).json({ error: 'Nie znaleziono wątku' });

    const customer = await identity.loadCustomer(db, thread.customer_id);
    const [messagesRes, identitiesRes] = await Promise.all([
      db.from('kom_messages').select('*').eq('thread_id', thread.id).order('created_at', { ascending: true }).limit(100),
      db.from('kom_customer_identities').select('type').eq('customer_id', customer.id),
    ]);
    if (messagesRes.error) throw messagesRes.error;
    if (identitiesRes.error) throw identitiesRes.error;
    customer.identities = identitiesRes.data || [];

    const result = await suggest.generateSuggestion(db, thread, customer, messagesRes.data || []);
    res.json(result);
  } catch (err) {
    handleError(res, err, 502);
  }
});

// ── Wysyłanie odpowiedzi przez Zernio Inbox API ─────────────────────────────

const ZERNIO_API = 'https://zernio.com/api';

async function zernioRequest(pathname, body) {
  const key = process.env.ZERNIO_API_KEY;
  if (!key) throw new Error('Brak ZERNIO_API_KEY w konfiguracji serwera');
  const response = await fetch(`${ZERNIO_API}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  if (!response.ok) {
    // Meta odrzuciła wysyłkę poza oknem — czytelny błąd zamiast surowego JSON-a.
    if (/window|24.?h|outside|human.?agent|message.?tag/i.test(raw)) {
      const err = new Error('Meta odrzuciła wysyłkę (okno zamknięte) — wyślij ręcznie przez inbox Zernio albo zadzwoń');
      err.windowClosed = true;
      throw err;
    }
    throw new Error(`Zernio ${response.status}: ${raw.slice(0, 300)}`);
  }
  return raw ? JSON.parse(raw) : {};
}

// Zwykły DM; humanAgent=true dokleja tag HUMAN_AGENT (FB/IG, do 7 dni od
// ostatniej wiadomości klienta — odpowiedź człowieka, nie automat).
async function sendViaZernio(thread, text, { humanAgent = false } = {}) {
  const z = thread.meta?.zernio || {};
  if (!z.conversationId || !z.accountId) {
    throw new Error('Wątek bez danych Zernio (conversationId/accountId) — poczekaj na pierwszą wiadomość przez webhook');
  }
  return zernioRequest(`/v1/inbox/conversations/${encodeURIComponent(z.conversationId)}/messages`, {
    accountId: z.accountId,
    message: text,
    ...(humanAgent ? { messagingType: 'MESSAGE_TAG', messageTag: 'HUMAN_AGENT' } : {}),
  });
}

// Private reply na komentarz: DM do autora, 1 na komentarz, do 7 dni (Meta).
async function sendPrivateReply(thread, comment, text) {
  const z = thread.meta?.zernio || {};
  if (!z.accountId) throw new Error('Wątek bez danych Zernio (accountId)');
  return zernioRequest(
    `/v1/inbox/comments/${encodeURIComponent(comment.postId)}/${encodeURIComponent(comment.commentId)}/private-reply`,
    { accountId: z.accountId, message: text }
  );
}

const SEND_CLOSED_MESSAGES = {
  no_inbound: 'Klient nie napisał jeszcze DM — nie można wysłać wiadomości. Poczekaj na jego wiadomość albo zadzwoń.',
  no_comment: 'Brak komentarza, na który dałoby się odpowiedzieć.',
  already_replied: 'Private reply do tego komentarza już poszedł (Meta pozwala na 1 na komentarz). Poczekaj, aż klient odpisze w DM.',
  expired: 'Okno Meta zamknięte (minęło 7 dni) — otwórz rozmowę w inboxie Zernio i odpowiedz ręcznie albo zadzwoń, potem kliknij „Wysłane ręcznie”.',
};

app.post('/api/threads/:id/messages', async (req, res) => {
  try {
    const text = String(req.body?.body || '').trim();
    if (!text) return res.status(400).json({ error: 'Pusta wiadomość' });
    const db = getClient();

    const { data: threads, error } = await db.from('kom_threads').select('*').eq('id', req.params.id).limit(1);
    if (error) throw error;
    const thread = threads && threads[0];
    if (!thread) return res.status(404).json({ error: 'Nie znaleziono wątku' });

    const { data: messages, error: msgsErr } = await db
      .from('kom_messages').select('id,direction,body,created_at,meta')
      .eq('thread_id', thread.id).order('created_at', { ascending: true }).limit(500);
    if (msgsErr) throw msgsErr;

    const sendState = computeSendState(thread, messages || []);
    if (sendState.mode === 'none') {
      return res.status(400).json({ error: 'Ten kanał nie obsługuje wysyłania z panelu' });
    }
    if (sendState.mode === 'manual_only') {
      return res.status(409).json({
        error: sendState.note || 'Ten kanał wymaga ręcznej odpowiedzi — skopiuj treść i kliknij „Wysłane ręcznie”.',
        window_closed: true,
      });
    }
    if (sendState.mode === 'closed') {
      return res.status(409).json({ error: SEND_CLOSED_MESSAGES[sendState.reason], window_closed: true });
    }

    const outMeta = {};
    let externalMessageId = null;
    try {
      if (sendState.mode === 'gmail') {
        const sent = await gmail.sendReply(db, {
          mailbox: sendState.email.mailbox,
          to: sendState.email.to,
          subject: sendState.email.subject,
          text,
          gmailThreadId: sendState.email.threadId,
          lastGmailMessageId: sendState.email.lastMessageId,
        });
        outMeta.gmail = { id: sent.id, threadId: sent.threadId, from: sent.from };
        externalMessageId = `gmail:${sent.id}`;
      } else if (sendState.mode === 'private_reply') {
        await sendPrivateReply(thread, sendState.comment, text);
        outMeta.private_reply_to = sendState.comment.commentId;
      } else {
        await sendViaZernio(thread, text, { humanAgent: sendState.mode === 'human_agent' });
        if (sendState.mode === 'human_agent') outMeta.human_agent = true;
      }
    } catch (sendErr) {
      if (sendErr.windowClosed) return res.status(409).json({ error: sendErr.message, window_closed: true });
      throw sendErr;
    }

    // external_message_id dla Zernio celowo NULL — webhook message.sent dopina
    // ID Zernio do tego wiersza (dedup po treści w ingest/zernio.js) zamiast
    // dublować. Gmail webhooka nie ma, więc ID wpisujemy od razu.
    const { error: msgErr } = await db.from('kom_messages').insert({
      thread_id: thread.id,
      direction: 'out',
      body: text,
      sent_by: req.user?.email || 'antoni',
      suggestion_id: req.body?.suggestion_id || null,
      ...(externalMessageId ? { external_message_id: externalMessageId } : {}),
      ...(Object.keys(outMeta).length ? { meta: outMeta } : {}),
    });
    if (msgErr) throw msgErr;
    await db.from('kom_threads').update({ status: 'waiting', last_message_at: new Date().toISOString() }).eq('id', thread.id);

    // Rozlicz sugestię: bez zmian → sent_as_is, poprawiona → edited + wpis
    // do korpusu uczącego (kom_examples). Błąd tutaj nie może cofnąć wysyłki.
    if (req.body?.suggestion_id) {
      try {
        const { data: history } = await db
          .from('kom_messages').select('direction,body').eq('thread_id', thread.id)
          .order('created_at', { ascending: true }).limit(100);
        await suggest.resolveSuggestionAfterSend(db, req.body.suggestion_id, text, history || []);
      } catch (suggErr) {
        console.error('Rozliczenie sugestii:', suggErr.message);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err, 502);
  }
});

// Odpowiedź wysłana ręcznie (Gmail, TikTok, inbox Zernio po zamknięciu
// okna) — panel dopisuje ją do historii wątku, kontekst zostaje pełny.
app.post('/api/threads/:id/manual-sent', async (req, res) => {
  try {
    const text = String(req.body?.body || '').trim();
    if (!text) return res.status(400).json({ error: 'Pusta wiadomość' });
    const db = getClient();
    const { error: msgErr } = await db.from('kom_messages').insert({
      thread_id: req.params.id,
      direction: 'out',
      body: text,
      sent_by: req.user?.email || 'antoni',
      suggestion_id: req.body?.suggestion_id || null,
      meta: { manual_business_suite: true },
    });
    if (msgErr) throw msgErr;
    await db.from('kom_threads').update({ status: 'waiting', last_message_at: new Date().toISOString() }).eq('id', req.params.id);

    // Ręczna wysyłka też uczy: jeśli treść różni się od sugestii AI, para
    // (sugestia → wersja Antoniego) trafia do kom_examples jak przy wysyłce
    // z panelu. Błąd rozliczenia nie może cofnąć dopisania do historii.
    if (req.body?.suggestion_id) {
      try {
        const { data: history } = await db
          .from('kom_messages').select('direction,body').eq('thread_id', req.params.id)
          .order('created_at', { ascending: true }).limit(100);
        await suggest.resolveSuggestionAfterSend(db, req.body.suggestion_id, text, history || []);
      } catch (suggErr) {
        console.error('Rozliczenie sugestii (manual-sent):', suggErr.message);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err, 502);
  }
});

// ── Notatka (Wispr Flow): tekst + numer telefonu klienta ────────────────────

app.post('/api/notes', async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    const phone = String(req.body?.phone || '').trim();
    if (!text) return res.status(400).json({ error: 'Pusta notatka' });
    if (!phone) return res.status(400).json({ error: 'Podaj numer telefonu klienta' });

    const db = getClient();
    const { customer, created } = await identity.resolveCustomer(db, {
      type: 'phone', value: phone, source: 'manual',
    });

    // Notatka dokleja się do wątku telefonicznego klienta, jeśli istnieje —
    // rozmowa i notatka o niej to jeden kontekst; inaczej osobny wątek 'note'.
    const { data: phoneThreads, error: ptErr } = await db
      .from('kom_threads').select('*').eq('customer_id', customer.id).eq('channel', 'phone').limit(1);
    if (ptErr) throw ptErr;
    const thread = phoneThreads && phoneThreads[0]
      ? phoneThreads[0]
      : (await identity.attachThread(db, customer, 'note', identity.normalize('phone', phone))).thread;

    const { error: msgErr } = await db.from('kom_messages').insert({
      thread_id: thread.id,
      direction: 'internal',
      body: text,
      sent_by: req.user?.email || 'antoni',
      meta: { note: true },
    });
    if (msgErr) throw msgErr;
    await db.from('kom_threads').update({ last_message_at: new Date().toISOString() }).eq('id', thread.id);
    res.json({ ok: true, customer: customer.public_id, customerCreated: created, threadId: thread.id });
  } catch (err) {
    handleError(res, err, 502);
  }
});

// ── Gmail OAuth ──────────────────────────────────────────────────────────────
// Za bramką logowania (klika tylko zalogowany Antoni; Google wraca na
// callback w tej samej przeglądarce, więc ciasteczko sesji jest obecne).

app.get('/api/gmail/auth', (req, res) => {
  try {
    res.redirect(gmail.authUrl());
  } catch (err) {
    handleError(res, err, 500);
  }
});

app.get('/api/gmail/callback', async (req, res) => {
  try {
    if (req.query.error) throw new Error(`Google odmówił: ${req.query.error}`);
    if (!req.query.code) throw new Error('Brak kodu autoryzacji w odpowiedzi Google');
    // connectedByUserId: nowa skrzynka bez pasującego app_usera przypisuje
    // się do zalogowanego, który kliknął autoryzację (domyślnie właściciel).
    const { email } = await gmail.exchangeCode(getClient(), String(req.query.code), {
      connectedByUserId: req.user?.id ?? null,
    });
    res.type('html').send(`<meta charset="utf-8"><body style="font-family:sans-serif;padding:2rem">
      <h2>✅ Gmail połączony: ${email}</h2>
      <p>E-maile zaczną wpadać do panelu przy najbliższym cyklu (max 30 min).</p>
      <p><a href="${req.baseUrl || ''}/">← Wróć do Wiadomości</a></p></body>`);
  } catch (err) {
    handleError(res, err, 502);
  }
});

app.get('/api/gmail/status', async (req, res) => {
  try {
    res.json(await gmail.status(getClient()));
  } catch (err) {
    handleError(res, err, 502);
  }
});

// ── Triage: wyciszanie i ręczne przywracanie ────────────────────────────────

// "Nie chcę widzieć podobnych": twarde wyciszenie nadawcy + ostatnia
// przychodząca jako przykład dla klasyfikatora ("podobne → archive").
app.post('/api/threads/:id/mute', async (req, res) => {
  try {
    const db = getClient();
    const { data: threads, error } = await db.from('kom_threads').select('*').eq('id', req.params.id).limit(1);
    if (error) throw error;
    const thread = threads && threads[0];
    if (!thread) return res.status(404).json({ error: 'Nie znaleziono wątku' });

    const { data: lastIn } = await db
      .from('kom_messages').select('body').eq('thread_id', thread.id).eq('direction', 'in')
      .order('created_at', { ascending: false }).limit(1);
    const result = await triage.muteFromThread(db, thread, lastIn?.[0]?.body || null);

    // Wyciszony wątek e-mail znika też ze skrzynki: istniejące wiadomości
    // dostają "przeczytane" w Gmailu (przyszłe załatwia reguła przy ingeście).
    if (thread.channel === 'email') {
      const { data: gmailMsgs } = await db
        .from('kom_messages').select('meta').eq('thread_id', thread.id).eq('direction', 'in');
      const ids = (gmailMsgs || []).map((m) => m.meta?.gmail?.id).filter(Boolean);
      if (ids.length) {
        result.markedRead = await gmail.markMessagesRead(db, ids, {
          mailbox: thread.meta?.gmail?.mailbox || null,
        });
      }
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    handleError(res, err, 502);
  }
});

// Ręczna zmiana kategorii (np. przywrócenie odfiltrowanego do głównego) —
// blokuje dalsze automatyczne przełączanie tego wątku (triage_locked).
app.post('/api/threads/:id/triage', async (req, res) => {
  try {
    const value = String(req.body?.triage || '');
    if (!['inbox', 'notification', 'archive'].includes(value)) {
      return res.status(400).json({ error: 'Nieprawidłowa kategoria' });
    }
    const db = getClient();
    const { data: threads, error } = await db.from('kom_threads').select('meta').eq('id', req.params.id).limit(1);
    if (error) throw error;
    if (!threads || !threads[0]) return res.status(404).json({ error: 'Nie znaleziono wątku' });
    const meta = { ...(threads[0].meta || {}), triage_locked: true };
    const { error: upErr } = await db.from('kom_threads')
      .update({ triage: value, triage_reason: 'ustawione ręcznie', meta })
      .eq('id', req.params.id);
    if (upErr) throw upErr;
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err, 502);
  }
});

// ── Propozycje scaleń ────────────────────────────────────────────────────────

app.post('/api/merge-proposals/:id/confirm', async (req, res) => {
  try {
    const winner = await identity.confirmMerge(getClient(), req.params.id);
    res.json({ ok: true, customer: winner.public_id });
  } catch (err) {
    handleError(res, err, 502);
  }
});

app.post('/api/merge-proposals/:id/reject', async (req, res) => {
  try {
    await identity.rejectMerge(getClient(), req.params.id);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err, 502);
  }
});

const PORT = process.env.PORT || 3004;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Komunikator działa na http://localhost:${PORT}`);
  });
}

module.exports = app;
