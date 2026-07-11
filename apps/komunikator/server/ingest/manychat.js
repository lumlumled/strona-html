// ── Ingestia ManyChat (Messenger / Instagram / WhatsApp) ────────────────────
// Wspólny wzorzec każdego modułu ingestii (docs/plan-komunikator.md §2):
// surowy payload do kom_inbox_raw → dedup → tożsamość → wątek → wiadomość →
// wątek na 'attention'. Zero AI w tym module — tylko tania, synchroniczna
// robota, którą webhook zdąży zrobić w limicie czasu.
//
// Payload z ManyChat External Request (pola mapuje Antoni w automatyzacji):
//   { subscriber_id, channel, text, message_id?, first_name?, last_name?,
//     phone?, email? }
// channel: 'messenger'|'facebook'|'instagram'|'whatsapp' (albo ?channel= w URL).
const crypto = require('crypto');
const identity = require('../identity');

const CHANNEL_MAP = {
  messenger: { channel: 'messenger', identityType: 'fb' },
  facebook: { channel: 'messenger', identityType: 'fb' },
  fb: { channel: 'messenger', identityType: 'fb' },
  instagram: { channel: 'instagram', identityType: 'ig' },
  ig: { channel: 'instagram', identityType: 'ig' },
  whatsapp: { channel: 'whatsapp', identityType: 'wa' },
  wa: { channel: 'whatsapp', identityType: 'wa' },
};

function pick(payload, ...keys) {
  for (const key of keys) {
    const v = payload?.[key];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

// ManyChat nie zawsze da ID wiadomości — wtedy dedup po treści w oknie
// 10 minut: retry webhooka nie zdubluje, a klient piszący dwa razy "ok"
// w odstępie godzin przejdzie normalnie.
function externalMessageId(payload, subscriberId, text) {
  const explicit = pick(payload, 'message_id', 'messageId');
  if (explicit) return explicit;
  const bucket = Math.floor(Date.now() / (10 * 60 * 1000));
  return `h-${crypto.createHash('sha1').update(`${subscriberId}|${text}|${bucket}`).digest('hex').slice(0, 20)}`;
}

// Dociąganie pełnego profilu z ManyChat API — dzięki temu External Request
// w ManyChat może wysyłać samo subscriber_id+text, a imię/telefon/email
// i live_chat_url (link do rozmowy w ManyChat) bierzemy sami z getInfo.
// Swagger: GET /fb/subscriber/getInfo?subscriber_id=<int>.
async function fetchSubscriberInfo(subscriberId) {
  const token = process.env.MANYCHAT_API_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(
      `https://api.manychat.com/fb/subscriber/getInfo?subscriber_id=${encodeURIComponent(subscriberId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return null;
    const body = await res.json();
    return body?.status === 'success' ? body.data : null;
  } catch (err) {
    console.error('ManyChat getInfo:', err.message);
    return null;
  }
}

async function storeRaw(db, payload) {
  const { data, error } = await db
    .from('kom_inbox_raw')
    .insert({ source: 'manychat', payload })
    .select('id');
  if (error) throw error;
  return data[0].id;
}

async function markRaw(db, rawId, patch) {
  await db.from('kom_inbox_raw').update(patch).eq('id', rawId);
}

// Główne wejście: przetwarza jeden webhook. Zwraca opis tego, co się stało —
// endpoint odsyła to ManyChatowi (i logom) wprost.
// kind='comment': trigger komentarza pod postem FB/IG — ManyChat NIE
// udostępnia treści komentarza jako zmiennej, więc zapisujemy sam fakt
// ("skomentował post") i wątek ląduje w 'waiting', nie 'attention' —
// właściwa rozmowa zacznie się, gdy klient odpowie na DM od ManyChata.
// Komentarz NIE otwiera okna 24 h DM (Meta), stąd meta.kind na wiadomości.
async function handleWebhook(db, payload, channelHint, kindHint) {
  const rawId = await storeRaw(db, payload);
  try {
    const mapped = CHANNEL_MAP[String(channelHint || payload?.channel || 'messenger').toLowerCase()];
    if (!mapped) throw new Error(`Nieznany kanał: ${channelHint || payload?.channel}`);
    const isComment = String(kindHint || payload?.kind || '').toLowerCase() === 'comment';

    const subscriberId = pick(payload, 'subscriber_id', 'subscriberId', 'user_id', 'id');
    if (!subscriberId) throw new Error('Brak subscriber_id w payloadzie');
    let text = pick(payload, 'text', 'last_input_text', 'message');
    if (!text && isComment) text = 'Skomentował(a) post — treść komentarza niedostępna z ManyChat.';
    if (!text) throw new Error('Brak treści wiadomości (text)');

    // Profil: co przyszło w payloadzie + dociągnięte z ManyChat API (getInfo
    // uzupełnia braki — dzięki temu minimalne body w ManyChat wystarcza).
    const info = await fetchSubscriberInfo(subscriberId);
    const firstName = pick(payload, 'first_name', 'firstName') || String(info?.first_name || '').trim();
    const lastName = pick(payload, 'last_name', 'lastName') || String(info?.last_name || '').trim();
    const displayName = [firstName, lastName].filter(Boolean).join(' ')
      || pick(payload, 'name') || String(info?.name || '').trim() || null;
    const phone = pick(payload, 'phone') || String(info?.phone || info?.optin_phone || '').trim();
    const email = pick(payload, 'email') || String(info?.email || info?.optin_email || '').trim();

    const { customer, created } = await identity.resolveCustomer(db, {
      type: mapped.identityType,
      value: subscriberId,
      displayName,
      source: 'webhook',
    });

    // Klient znany, ale bez nazwy → uzupełnij (ManyChat zna imię z profilu).
    if (!created && displayName && !customer.display_name) {
      await db.from('kom_customers').update({ display_name: displayName }).eq('id', customer.id);
      customer.display_name = displayName;
    }

    const { thread, created: threadCreated } = await identity.attachThread(db, customer, mapped.channel, subscriberId);

    // live_chat_url = link "otwórz tę rozmowę w ManyChat" — fallback ręczny
    // po zamknięciu okna 24 h (jeden klik zamiast szukania w Business Suite).
    if (info?.live_chat_url && thread.meta?.live_chat_url !== info.live_chat_url) {
      await db.from('kom_threads')
        .update({ meta: { ...(thread.meta || {}), live_chat_url: info.live_chat_url } })
        .eq('id', thread.id);
    }

    // Telefon/email z profilu ManyChat wzbogaca klienta; konflikt z innym
    // klientem = propozycja scalenia do potwierdzenia, nigdy auto-merge.
    const conflicts = [];
    for (const [type, value] of [['phone', phone], ['email', email]]) {
      if (!value) continue;
      const result = await identity.enrichCustomer(db, customer.id, { type, value, source: 'webhook' });
      if (result.status === 'conflict' && result.otherCustomer) {
        conflicts.push({ type, value, otherCustomer: result.otherCustomer });
        await identity.proposeMerge(db, {
          threadId: thread.id,
          candidateId: result.otherCustomer.id,
          reason: 'identity_conflict',
          evidence: { type, value: identity.normalize(type, value), source: 'manychat_profile' },
        });
      }
    }

    const extId = externalMessageId(payload, subscriberId, `${isComment ? 'c:' : ''}${text}`);
    const { error: msgErr } = await db.from('kom_messages').insert({
      thread_id: thread.id,
      direction: 'in',
      body: text,
      sent_by: 'customer',
      external_message_id: extId,
      meta: {
        manychat: { subscriber_id: subscriberId, channel: mapped.channel },
        ...(isComment ? { kind: 'comment' } : {}),
      },
    });
    if (msgErr) {
      if (/duplicate|unique/i.test(msgErr.message)) {
        await markRaw(db, rawId, { processed: true, error: 'duplikat wiadomości — pominięto' });
        return { ok: true, duplicate: true, customer: customer.public_id };
      }
      throw msgErr;
    }

    // Komentarz nie wymaga natychmiastowej akcji (ManyChat odpisał DM-em):
    // świeży wątek → 'waiting'; istniejący zostaje przy swoim statusie.
    // Prawdziwa wiadomość DM zawsze podbija na 'attention'.
    const statusPatch = { last_message_at: new Date().toISOString() };
    if (!isComment) statusPatch.status = 'attention';
    else if (threadCreated) statusPatch.status = 'waiting';
    await db.from('kom_threads').update(statusPatch).eq('id', thread.id);

    await markRaw(db, rawId, { processed: true });
    return {
      ok: true,
      customer: customer.public_id,
      customerCreated: created,
      threadId: thread.id,
      conflicts: conflicts.length,
    };
  } catch (err) {
    await markRaw(db, rawId, { error: err.message }).catch(() => {});
    throw err;
  }
}

module.exports = { handleWebhook, CHANNEL_MAP };
