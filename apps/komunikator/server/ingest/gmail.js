// ── Ingestia Gmail (OAuth, Gmail API) ───────────────────────────────────────
// E-maile z INBOX wpadają do Komunikatora przez warstwę triage:
//   klient → główny widok; automat wymagający uwagi → Powiadomienia;
//   syf → archive ORAZ oznaczenie jako przeczytane w Gmailu (wymóg Antoniego:
//   skrzynka Gmail ma nie być zasypana).
// OAuth: aplikacja "Internal" w Google Workspace lumlum.co (zero weryfikacji,
// refresh token nie wygasa). Tokeny w kom_settings (klucz 'gmail_oauth') —
// env trzyma tylko GOOGLE_CLIENT_ID/SECRET.
// Sync odpala worker (pg_cron co 30 min): lista wiadomości z INBOX z ostatnich
// dni, dedup po external_message_id 'gmail:<id>'.
const identity = require('../identity');
const triage = require('../triage');

const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const SETTINGS_KEY = 'gmail_oauth';
const MAX_MESSAGES_PER_SYNC = 25;

function clientConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function redirectUri() {
  return process.env.GMAIL_REDIRECT_URI || 'https://lumlum.dev/wiadomosci/api/gmail/callback';
}

// ── Tokeny w kom_settings ────────────────────────────────────────────────────

async function loadTokens(db) {
  const { data, error } = await db.from('kom_settings').select('value').eq('key', SETTINGS_KEY).limit(1);
  if (error) throw error;
  return data?.[0]?.value || null;
}

async function saveTokens(db, value) {
  const { error } = await db.from('kom_settings')
    .upsert({ key: SETTINGS_KEY, value, updated_at: new Date().toISOString() });
  if (error) throw error;
}

// ── OAuth ────────────────────────────────────────────────────────────────────

function authUrl() {
  const cfg = clientConfig();
  if (!cfg) throw new Error('Brak GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET w konfiguracji serwera');
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent', // wymusza refresh_token także przy ponownej autoryzacji
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(body) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Google OAuth ${res.status}: ${raw.slice(0, 300)}`);
  return JSON.parse(raw);
}

async function exchangeCode(db, code) {
  const cfg = clientConfig();
  if (!cfg) throw new Error('Brak GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET w konfiguracji serwera');
  const tokens = await tokenRequest({
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
  });
  if (!tokens.refresh_token) throw new Error('Google nie zwrócił refresh_token — odłącz aplikację na myaccount.google.com/permissions i spróbuj ponownie');

  // Czyj to inbox — do pokazania w panelu i logach.
  const profile = await gmailFetch(tokens.access_token, '/profile');
  await saveTokens(db, {
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expires_at: new Date(Date.now() + (tokens.expires_in - 60) * 1000).toISOString(),
    email: profile.emailAddress,
    connected_at: new Date().toISOString(),
  });
  return { email: profile.emailAddress };
}

async function ensureAccessToken(db) {
  const stored = await loadTokens(db);
  if (!stored?.refresh_token) return null;
  if (stored.access_token && stored.expires_at && new Date(stored.expires_at) > new Date()) {
    return { token: stored.access_token, email: stored.email };
  }
  const cfg = clientConfig();
  if (!cfg) throw new Error('Brak GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET w konfiguracji serwera');
  const refreshed = await tokenRequest({
    refresh_token: stored.refresh_token,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: 'refresh_token',
  });
  await saveTokens(db, {
    ...stored,
    access_token: refreshed.access_token,
    expires_at: new Date(Date.now() + (refreshed.expires_in - 60) * 1000).toISOString(),
  });
  return { token: refreshed.access_token, email: stored.email };
}

// ── Gmail API ────────────────────────────────────────────────────────────────

async function gmailFetch(accessToken, pathname, options = {}) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Gmail ${pathname} → ${res.status}: ${raw.slice(0, 300)}`);
  return raw ? JSON.parse(raw) : {};
}

function header(payload, name) {
  const h = (payload?.headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

// From: "Jan Kowalski <jan@x.pl>" → { name, email }
function parseFrom(value) {
  const match = String(value).match(/^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$/);
  if (match) return { name: (match[1] || '').trim() || null, email: match[2].trim().toLowerCase() };
  return { name: null, email: String(value).trim().toLowerCase() };
}

function decodeBody(data) {
  return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// Preferuj text/plain; HTML tylko jako fallback (zdarty z tagów); na końcu snippet.
function extractText(payload) {
  const stack = [payload];
  let html = null;
  while (stack.length) {
    const part = stack.shift();
    if (!part) continue;
    if (part.mimeType === 'text/plain' && part.body?.data) return decodeBody(part.body.data);
    if (part.mimeType === 'text/html' && part.body?.data && !html) html = decodeBody(part.body.data);
    if (part.parts) stack.push(...part.parts);
  }
  if (html) {
    return html
      .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ').trim();
  }
  return '';
}

// ── Sync (worker) ────────────────────────────────────────────────────────────

async function syncGmail(db) {
  if (!clientConfig()) return { ok: true, skipped: 'brak GOOGLE_CLIENT_ID/SECRET — Gmail czeka na konfigurację OAuth' };
  const auth = await ensureAccessToken(db);
  if (!auth) return { ok: true, skipped: 'Gmail niepołączony — wejdź na /wiadomosci/api/gmail/auth' };

  // Świeże wiadomości z INBOX; dedup po ID zrobi unique w kom_messages.
  const list = await gmailFetch(auth.token, `/messages?q=${encodeURIComponent('in:inbox newer_than:3d')}&maxResults=${MAX_MESSAGES_PER_SYNC}`);
  const ids = (list.messages || []).map((m) => m.id);
  if (!ids.length) return { ok: true, added: 0 };

  // Odfiltruj już zapisane jednym zapytaniem.
  const extIds = ids.map((id) => `gmail:${id}`);
  const { data: existing, error: exErr } = await db
    .from('kom_messages').select('external_message_id').in('external_message_id', extIds);
  if (exErr) throw exErr;
  const seen = new Set((existing || []).map((m) => m.external_message_id));
  const fresh = ids.filter((id) => !seen.has(`gmail:${id}`));

  let added = 0;
  let archivedInGmail = 0;
  for (const id of fresh) {
    const msg = await gmailFetch(auth.token, `/messages/${id}?format=full`);
    const from = parseFrom(header(msg.payload, 'From'));
    if (!from.email || from.email === auth.email) continue; // własne/wysłane pomijamy
    const subject = header(msg.payload, 'Subject') || '(bez tematu)';
    const bodyText = (extractText(msg.payload) || msg.snippet || '').slice(0, 3000).trim();

    const { customer } = await identity.resolveCustomer(db, {
      type: 'email', value: from.email, displayName: from.name, source: 'webhook',
    });
    const { thread } = await identity.attachThread(db, customer, 'email', msg.threadId);
    if (!thread.meta?.gmail) {
      const meta = { ...(thread.meta || {}), gmail: { threadId: msg.threadId } };
      await db.from('kom_threads').update({ meta }).eq('id', thread.id);
      thread.meta = meta;
    }

    const { data: inserted, error: msgErr } = await db.from('kom_messages').insert({
      thread_id: thread.id,
      direction: 'in',
      body: `Temat: ${subject}\n\n${bodyText}`,
      sent_by: 'customer',
      external_message_id: `gmail:${id}`,
      created_at: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : new Date().toISOString(),
      meta: { gmail: { id, threadId: msg.threadId, subject, from: from.email } },
    }).select('id');
    if (msgErr) {
      if (/duplicate|unique/i.test(msgErr.message)) continue;
      throw msgErr;
    }
    added += 1;
    await db.from('kom_threads')
      .update({ status: 'attention', last_message_at: new Date().toISOString() })
      .eq('id', thread.id);

    const verdict = await triage.classifyInWebhook(db, thread, inserted[0].id, {
      kind: 'email',
      channel: 'email',
      text: `Temat: ${subject}\n${bodyText.slice(0, 1200)}`,
      senderName: from.name || from.email,
      senderType: 'email',
      senderValue: from.email,
      history: [],
    }, 20000);

    // Syf znika też z Gmaila: oznaczamy jako przeczytany, żeby skrzynka
    // nie była zasypana. Klienci i powiadomienia zostają nieprzeczytane.
    if (verdict?.triage === 'archive') {
      try {
        await gmailFetch(auth.token, `/messages/${id}/modify`, {
          method: 'POST',
          body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
        });
        archivedInGmail += 1;
      } catch (err) {
        console.error('Gmail mark-as-read:', err.message);
      }
    }
  }
  return { ok: true, added, markedRead: archivedInGmail, inbox: auth.email };
}

async function status(db) {
  const tokens = await loadTokens(db);
  return { configured: Boolean(clientConfig()), connected: Boolean(tokens?.refresh_token), email: tokens?.email || null };
}

// Oznacz istniejące wiadomości jako przeczytane w Gmailu — używane przy
// wyciszaniu wątku e-mail ("nie chcę widzieć podobnych" = zniknij też z oczu
// w skrzynce). Best-effort: błąd jednej wiadomości nie blokuje reszty.
async function markMessagesRead(db, gmailIds) {
  const auth = await ensureAccessToken(db);
  if (!auth) return 0;
  let marked = 0;
  for (const id of gmailIds) {
    try {
      await gmailFetch(auth.token, `/messages/${id}/modify`, {
        method: 'POST',
        body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
      });
      marked += 1;
    } catch (err) {
      console.error('Gmail markMessagesRead:', err.message);
    }
  }
  return marked;
}

// ── Wysyłka odpowiedzi z panelu ──────────────────────────────────────────────
// Scope gmail.modify obejmuje też messages.send, więc to samo połączenie
// OAuth wystarcza. Odpowiedź wpina się w istniejący wątek Gmaila: temat
// "Re: ...", nagłówki In-Reply-To/References z ostatniego maila klienta
// i threadId przy wysyłce — bez tego odbiorca dostałby osobny, nowy mail.

// RFC 2047: temat z polskimi znakami musi być zakodowany w nagłówku.
function encodeSubject(subject) {
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

async function sendReply(db, { to, subject, text, gmailThreadId, lastGmailMessageId }) {
  const auth = await ensureAccessToken(db);
  if (!auth) throw new Error('Gmail niepołączony — wejdź na /wiadomosci/api/gmail/auth');

  // Message-ID/References ostatniego maila klienta dociągamy w momencie
  // wysyłki (nie trzymamy ich w bazie). Brak nagłówków nie blokuje wysyłki —
  // threadId i tak utrzyma wątek po stronie naszej skrzynki.
  let inReplyTo = '';
  let references = '';
  if (lastGmailMessageId) {
    try {
      const meta = await gmailFetch(
        auth.token,
        `/messages/${lastGmailMessageId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`
      );
      inReplyTo = header(meta.payload, 'Message-ID');
      references = [header(meta.payload, 'References'), inReplyTo].filter(Boolean).join(' ');
    } catch (err) {
      console.error('Gmail nagłówki wątkowania:', err.message);
    }
  }

  const baseSubject = String(subject || '').trim();
  const replySubject = /^re:/i.test(baseSubject) ? baseSubject : `Re: ${baseSubject}`.trim();
  const mime = [
    `From: ${auth.email}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(replySubject)}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(String(text), 'utf8').toString('base64'),
  ].join('\r\n');

  const raw = Buffer.from(mime, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const sent = await gmailFetch(auth.token, '/messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw, ...(gmailThreadId ? { threadId: gmailThreadId } : {}) }),
  });
  return { id: sent.id, threadId: sent.threadId, from: auth.email };
}

// ── Push w czasie rzeczywistym (users.watch → Pub/Sub → nasz webhook) ───────
// Gmail publikuje powiadomienie na topic Pub/Sub przy każdej zmianie w INBOX;
// subskrypcja push woła /api/webhooks/gmail, a ten odpala syncGmail() —
// dedup po ID wiadomości robi resztę, więc powiadomienie jest tylko
// "dzwonkiem", nie źródłem danych. watch wygasa po ~7 dniach → worker
// odnawia go, gdy zostało <24 h.

async function ensureWatch(db) {
  const topic = process.env.GMAIL_PUBSUB_TOPIC; // projects/<projekt>/topics/<topic>
  if (!topic) return { skipped: 'brak GMAIL_PUBSUB_TOPIC — push wyłączony, działa polling' };
  const auth = await ensureAccessToken(db);
  if (!auth) return { skipped: 'Gmail niepołączony' };

  const stored = await loadTokens(db);
  const expiresAt = stored?.watch?.expiration ? Number(stored.watch.expiration) : 0;
  if (expiresAt - Date.now() > 24 * 60 * 60 * 1000 && stored?.watch?.topic === topic) {
    return { active: true, expiresAt: new Date(expiresAt).toISOString() };
  }

  const watch = await gmailFetch(auth.token, '/watch', {
    method: 'POST',
    body: JSON.stringify({ topicName: topic, labelIds: ['INBOX'], labelFilterBehavior: 'INCLUDE' }),
  });
  await saveTokens(db, { ...(await loadTokens(db)), watch: { topic, expiration: watch.expiration, historyId: watch.historyId } });
  return { renewed: true, expiresAt: new Date(Number(watch.expiration)).toISOString() };
}

module.exports = { authUrl, exchangeCode, syncGmail, ensureWatch, status, sendReply, markMessagesRead };
