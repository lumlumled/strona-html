// ── Ingestia Zernio (Messenger / Instagram / WhatsApp + komentarze) ─────────
// Wspólny wzorzec każdego modułu ingestii (docs/plan-komunikator.md §2):
// surowy payload do kom_inbox_raw → dedup → tożsamość → wątek → wiadomość →
// status wątku. Zero AI w tym module — tylko tania, synchroniczna robota,
// którą webhook zdąży zrobić w limicie 5 s Zernio.
//
// Eventy (rejestrowane przez scripts/register-zernio-webhook.js):
//   message.received      → wiadomość 'in', wątek na 'attention'
//   message.sent          → wiadomość 'out' (łapie też odpowiedzi wysłane
//                           poza panelem: dashboard Zernio, automaty)
//   conversation.started  → pre-tworzy klienta+wątek (profil od razu w karcie)
//   comment.received      → wiadomość meta.kind='comment' Z TREŚCIĄ (Zernio
//                           daje pełny tekst + autora, czego ManyChat nie dawał)
//
// Wątek DM: external_thread_id = zernio conversationId; do wysyłki potrzebny
// też accountId — trzymany w kom_threads.meta.zernio. Komentarze mają osobny
// wątek per autor: external_thread_id = 'comments:<authorId>' (komentarz nie
// otwiera okna DM Meta, więc nie wolno go mieszać z wątkiem rozmowy).
const crypto = require('crypto');
const identity = require('../identity');
const triage = require('../triage');

const PLATFORM_MAP = {
  facebook: { channel: 'messenger', identityType: 'fb' },
  instagram: { channel: 'instagram', identityType: 'ig' },
  whatsapp: { channel: 'whatsapp', identityType: 'wa' },
};

// HMAC-SHA256 surowego body, hex — nagłówek X-Zernio-Signature.
function verifySignature(rawBody, signature, secret) {
  if (!signature || !secret || !rawBody) return false;
  const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(String(signature));
  const b = Buffer.from(computed);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function storeRaw(db, payload) {
  const { data, error } = await db
    .from('kom_inbox_raw')
    .insert({ source: 'zernio', payload })
    .select('id');
  if (error) throw error;
  return data[0].id;
}

async function markRaw(db, rawId, patch) {
  await db.from('kom_inbox_raw').update(patch).eq('id', rawId);
}

function attachmentSummary(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return '';
  const labels = { image: 'zdjęcie', video: 'wideo', audio: 'audio', sticker: 'naklejka', file: 'plik' };
  return attachments.map((a) => `[${labels[a.type] || a.type || 'załącznik'}]`).join(' ');
}

// Meta wątku: dopisuje dane Zernio (conversationId/accountId — bez nich nie ma
// wysyłki) i profil rozmówcy, tylko gdy coś się realnie zmieniło.
async function ensureThreadMeta(db, thread, zernioMeta) {
  const current = thread.meta?.zernio || {};
  const next = { ...current, ...zernioMeta };
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  const meta = { ...(thread.meta || {}), zernio: next };
  await db.from('kom_threads').update({ meta }).eq('id', thread.id);
  thread.meta = meta;
}

// ── message.received / message.sent ─────────────────────────────────────────
async function handleMessage(db, payload) {
  const msg = payload.message || {};
  const conv = payload.conversation || {};
  const account = payload.account || {};
  const mapped = PLATFORM_MAP[msg.platform];
  if (!mapped) return { ok: true, skipped: `platforma bez obsługi: ${msg.platform}` };

  const conversationId = msg.conversationId || conv.id;
  if (!conversationId) throw new Error('Brak conversationId w payloadzie');
  const incoming = msg.direction === 'incoming';

  // Tożsamość: dla przychodzącej nadawca; dla wychodzącej nadawcą jest firma,
  // więc rozmówcę bierzemy z conversation.participantId.
  const identityValue = incoming
    ? String(msg.sender?.id || conv.participantId || '')
    : String(conv.participantId || '');
  if (!identityValue) throw new Error('Brak identyfikatora rozmówcy (sender.id/participantId)');
  const displayName = (incoming ? msg.sender?.name : conv.participantName)
    || conv.participantName || msg.sender?.username || conv.participantUsername || null;

  const { customer, created } = await identity.resolveCustomer(db, {
    type: mapped.identityType,
    value: identityValue,
    displayName,
    source: 'webhook',
  });
  if (!created && displayName && !customer.display_name) {
    await db.from('kom_customers').update({ display_name: displayName }).eq('id', customer.id);
    customer.display_name = displayName;
  }

  const { thread } = await identity.attachThread(db, customer, mapped.channel, conversationId);
  await ensureThreadMeta(db, thread, {
    conversationId,
    accountId: account.accountId || account.id || null,
    platform: msg.platform,
    participantUsername: conv.participantUsername || msg.sender?.username || null,
    participantName: conv.participantName || msg.sender?.name || null,
  });

  // WhatsApp daje numer telefonu wprost — najtwardszy łącznik między kanałami.
  if (incoming && msg.sender?.phoneNumber) {
    const result = await identity.enrichCustomer(db, customer.id, {
      type: 'phone', value: msg.sender.phoneNumber, source: 'webhook',
    });
    if (result.status === 'conflict' && result.otherCustomer) {
      await identity.proposeMerge(db, {
        threadId: thread.id,
        candidateId: result.otherCustomer.id,
        reason: 'identity_conflict',
        evidence: { type: 'phone', value: identity.normalize('phone', msg.sender.phoneNumber), source: 'zernio_whatsapp' },
      });
    }
  }

  const text = (msg.text || '').trim() || attachmentSummary(msg.attachments) || '[pusta wiadomość]';

  // Wychodząca wysłana z NASZEGO panelu już jest w bazie (insert przy wysyłce,
  // bez external_message_id — panel nie zna go w momencie insertu). Webhook
  // message.sent wtedy tylko dopina ID zamiast dublować bąbelka.
  if (!incoming) {
    const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data: recent } = await db
      .from('kom_messages').select('id,body,external_message_id')
      .eq('thread_id', thread.id).eq('direction', 'out')
      .is('external_message_id', null).gte('created_at', cutoff)
      .order('created_at', { ascending: false }).limit(5);
    const own = (recent || []).find((m) => m.body === text);
    if (own) {
      await db.from('kom_messages')
        .update({ external_message_id: msg.id, meta: { zernio: { messageId: msg.id, platformMessageId: msg.platformMessageId } } })
        .eq('id', own.id);
      return { ok: true, customer: customer.public_id, matchedOwnSend: true };
    }
  }

  const { data: inserted, error: msgErr } = await db.from('kom_messages').insert({
    thread_id: thread.id,
    direction: incoming ? 'in' : 'out',
    body: text,
    sent_by: incoming ? 'customer' : 'antoni',
    external_message_id: msg.id,
    ...(incoming ? {} : { triage: 'inbox' }),
    meta: {
      zernio: { messageId: msg.id, platformMessageId: msg.platformMessageId, eventId: payload.id },
      ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
      ...(msg.sender?.instagramProfile ? { instagram_profile: msg.sender.instagramProfile } : {}),
    },
  }).select('id');
  if (msgErr) {
    if (/duplicate|unique/i.test(msgErr.message)) return { ok: true, duplicate: true, customer: customer.public_id };
    throw msgErr;
  }

  await db.from('kom_threads')
    .update({ status: incoming ? 'attention' : 'waiting', last_message_at: new Date().toISOString() })
    .eq('id', thread.id);

  // Triage w budżecie czasu webhooka; porażka = wiadomość czeka na sweep.
  let verdict = null;
  if (incoming) {
    const { data: history } = await db
      .from('kom_messages').select('direction,body').eq('thread_id', thread.id)
      .neq('id', inserted[0].id).order('created_at', { ascending: false }).limit(5);
    verdict = await triage.classifyInWebhook(db, thread, inserted[0].id, {
      kind: 'dm',
      channel: mapped.channel,
      text,
      senderName: displayName,
      senderType: mapped.identityType,
      senderValue: identityValue,
      history: (history || []).reverse(),
    });
  }
  return { ok: true, customer: customer.public_id, customerCreated: created, threadId: thread.id, triage: verdict?.triage };
}

// ── conversation.started ─────────────────────────────────────────────────────
// Pre-tworzy klienta i wątek z profilem (imię, username, avatar), zanim
// przyjdzie pierwsza wiadomość. Event jest naturalnie dedupowany po stronie
// Zernio (odpala się raz na rozmowę).
async function handleConversationStarted(db, payload) {
  const conv = payload.conversation || {};
  const account = payload.account || {};
  const mapped = PLATFORM_MAP[conv.platform];
  if (!mapped) return { ok: true, skipped: `platforma bez obsługi: ${conv.platform}` };
  if (!conv.participantId || !conv.id) return { ok: true, skipped: 'brak participantId/id' };

  const { customer } = await identity.resolveCustomer(db, {
    type: mapped.identityType,
    value: String(conv.participantId),
    displayName: conv.participantName || conv.participantUsername || null,
    source: 'webhook',
  });
  const { thread } = await identity.attachThread(db, customer, mapped.channel, conv.id);
  await ensureThreadMeta(db, thread, {
    conversationId: conv.id,
    accountId: account.accountId || account.id || null,
    platform: conv.platform,
    participantUsername: conv.participantUsername || null,
    participantName: conv.participantName || null,
  });
  return { ok: true, customer: customer.public_id, threadId: thread.id };
}

// ── comment.received ─────────────────────────────────────────────────────────
// Pełna treść + autor (przewaga Zernio nad ManyChat). Komentarz NIE otwiera
// okna DM Meta → osobny wątek 'comments:<authorId>', status 'waiting' dla
// nowego wątku (nie wymaga natychmiastowej akcji jak DM). postId+commentId
// w meta umożliwiają private reply (7 dni, 1 na komentarz) z panelu.
async function handleComment(db, payload) {
  const comment = payload.comment || {};
  const account = payload.account || {};
  const mapped = PLATFORM_MAP[comment.platform];
  if (!mapped) return { ok: true, skipped: `platforma bez obsługi komentarzy: ${comment.platform}` };

  const author = comment.author || {};
  if (!author.id) throw new Error('Brak comment.author.id w payloadzie');
  const text = (comment.text || '').trim() || attachmentSummary([comment.attachment].filter(Boolean)) || '[pusty komentarz]';

  const { customer, created } = await identity.resolveCustomer(db, {
    type: mapped.identityType,
    value: String(author.id),
    displayName: author.name || author.username || null,
    source: 'webhook',
  });
  if (!created && (author.name || author.username) && !customer.display_name) {
    await db.from('kom_customers').update({ display_name: author.name || author.username }).eq('id', customer.id);
  }

  const { thread, created: threadCreated } = await identity.attachThread(
    db, customer, mapped.channel, `comments:${author.id}`
  );
  await ensureThreadMeta(db, thread, {
    kind: 'comments',
    accountId: account.accountId || account.id || null,
    platform: comment.platform,
    participantUsername: author.username || null,
    participantName: author.name || null,
  });

  const { data: inserted, error: msgErr } = await db.from('kom_messages').insert({
    thread_id: thread.id,
    direction: 'in',
    body: text,
    sent_by: 'customer',
    external_message_id: comment.id,
    meta: {
      kind: 'comment',
      zernio: {
        commentId: comment.id,
        postId: comment.platformPostId,
        platform: comment.platform,
        isReply: comment.isReply || false,
        parentCommentId: comment.parentCommentId || null,
        ...(comment.ad ? { ad: comment.ad } : {}),
        eventId: payload.id,
      },
    },
  }).select('id');
  if (msgErr) {
    if (/duplicate|unique/i.test(msgErr.message)) return { ok: true, duplicate: true, customer: customer.public_id };
    throw msgErr;
  }

  const statusPatch = { last_message_at: new Date().toISOString() };
  if (threadCreated) statusPatch.status = 'waiting';
  await db.from('kom_threads').update(statusPatch).eq('id', thread.id);

  const verdict = await triage.classifyInWebhook(db, thread, inserted[0].id, {
    kind: 'comment',
    channel: mapped.channel,
    text,
    senderName: author.name || author.username || null,
    senderType: mapped.identityType,
    senderValue: String(author.id),
    history: [],
  });
  return { ok: true, customer: customer.public_id, customerCreated: created, threadId: thread.id, comment: true, triage: verdict?.triage };
}

// Główne wejście: jeden webhook → jeden rekord kom_inbox_raw + dispatch po
// payload.event. Nieznane eventy przechodzą jako processed (nie ma sensu
// zmuszać Zernio do retry czegoś, czego świadomie nie obsługujemy).
async function handleWebhook(db, payload) {
  const rawId = await storeRaw(db, payload);
  try {
    let result;
    switch (payload?.event) {
      case 'message.received':
      case 'message.sent':
        result = await handleMessage(db, payload);
        break;
      case 'conversation.started':
        result = await handleConversationStarted(db, payload);
        break;
      case 'comment.received':
        result = await handleComment(db, payload);
        break;
      default:
        result = { ok: true, skipped: `event bez obsługi: ${payload?.event}` };
    }
    await markRaw(db, rawId, { processed: true, ...(result.skipped ? { error: result.skipped } : {}) });
    return result;
  } catch (err) {
    await markRaw(db, rawId, { error: err.message }).catch(() => {});
    throw err;
  }
}

module.exports = { handleWebhook, verifySignature, PLATFORM_MAP };
