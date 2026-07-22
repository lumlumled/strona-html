// ── Wspólna wysyłka SMS/mail z logowaniem śladu ──────────────────────────────
// Wyjęte z handlerów kontakt-endpoints.js (Etap 0 planu docs/plan-kampanie.md),
// żeby tę samą ścieżkę wołała karta leada (panel Kontakt) ORAZ worker kampanii.
// Ślad wysyłki jest zawsze ten sam: kom_messages (direction out) w wątku
// klienta komunikatora + linia "[SMS→]/[Mail→]" w Historii rozmów leada
// (gdy lead jest znany). Zachowanie 1:1 z dotychczasowymi handlerami.

const identity = require('../../komunikator/server/identity');
const gmail = require('../../komunikator/server/ingest/gmail');
const { callZadarma } = require('../../backlog-b2c/server/zadarma');

const LEADY_B2C_TABLE = 'Leady B2C';

function normalizePhoneDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

function warsawDateTimeStr(date = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Warsaw', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = dtf.formatToParts(date).reduce((acc, x) => { acc[x.type] = x.value; return acc; }, {});
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
}

async function findLeadByIdLeada(db, leadId) {
  const idNum = Number(leadId);
  if (!Number.isFinite(idNum)) return null;
  const { data, error } = await db.from(LEADY_B2C_TABLE).select('*').eq('ID Leada', idNum).limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

// Jednolinijkowy ślad wysyłki w kolumnie "Historia rozmów" (decyzja Antoniego
// 2026-07-14: mobile i stare widoki widzą kontakt bez zmian). Prefiksy
// [Mail→]/[SMS→] rozpoznaje panel Kontakt i filtruje je jako duplikaty,
// gdy pokazuje pełną wiadomość z komunikatora. Zapis przez RPC z bypassem
// triggera (jak notatka) — bez wpisu-widma w Log zmian.
async function appendHistoriaLine(db, lead, line) {
  if (!lead) return;
  const entry = `${warsawDateTimeStr()} - ${line}`;
  const { error } = await db.rpc('app_update_leady_notatka', {
    p_phone: lead['Phone number'],
    p_historia: lead['Historia rozmów'] ? `${entry}\n${lead['Historia rozmów']}` : entry,
    p_set_akcja: false,
    p_akcja: null,
    p_akcja_termin: null,
    p_akcja_owner: null,
    p_data_feedbacku: null,
    p_godzina_feedbacku: null,
  });
  if (error) console.warn('kontakt: dopis do Historii rozmów nie powiódł się:', error.message);
}

// Klient komunikatora dla leada — istniejący (po telefonie/e-mailu) albo
// świeżo utworzony z tożsamością mailową/telefoniczną (source 'manual',
// wysyłka z karty to świadome działanie handlowca). Drugi identyfikator
// dopinany przez enrich; konflikt (identyfikator u innego klienta) nie
// blokuje wysyłki — zostaje do scalenia w komunikatorze.
async function resolveCustomerForLead(db, { digits, email, displayName }) {
  const komPhone = digits ? identity.normalize('phone', digits) : '';
  const lookups = [];
  if (komPhone) lookups.push(db.from('kom_customer_identities').select('customer_id').eq('type', 'phone').eq('value', komPhone));
  if (email) lookups.push(db.from('kom_customer_identities').select('customer_id').eq('type', 'email').eq('value', email));
  const results = await Promise.all(lookups);
  for (const r of results) if (r.error) throw r.error;
  const ids = [...new Set(results.flatMap((r) => (r.data || []).map((row) => row.customer_id)))];
  if (ids.length) {
    const customer = await identity.loadCustomer(db, ids[0]);
    if (customer) {
      const enrich = async (type, value) => {
        try { await identity.enrichCustomer(db, customer.id, { type, value, source: 'manual' }); } catch (_) { /* konflikt/duplikat — nie blokuje */ }
      };
      if (email) await enrich('email', email);
      if (komPhone) await enrich('phone', komPhone);
      return customer;
    }
  }
  const seed = email ? { type: 'email', value: email } : { type: 'phone', value: komPhone };
  const { customer } = await identity.resolveCustomer(db, { ...seed, displayName: displayName || null, source: 'manual' });
  const second = email && komPhone ? { type: 'phone', value: komPhone } : null;
  if (second) {
    try { await identity.enrichCustomer(db, customer.id, { ...second, source: 'manual' }); } catch (_) { /* jw. */ }
  }
  return customer;
}

// Najświeższy mailowy wątek klienta z meta.gmail + dane do reply-in-thread
// (temat i gmailowe ID ostatniego maila PRZYCHODZĄCEGO — nagłówki wątkowania).
async function findMailThread(db, customerIds) {
  if (!customerIds.length) return null;
  const { data: threads, error } = await db
    .from('kom_threads')
    .select('*')
    .eq('channel', 'email')
    .in('customer_id', customerIds)
    .order('last_message_at', { ascending: false })
    .limit(5);
  if (error) throw error;
  const thread = (threads || []).find((t) => t.meta && t.meta.gmail && t.meta.gmail.threadId);
  if (!thread) return null;
  const { data: msgs, error: msgErr } = await db
    .from('kom_messages')
    .select('direction, meta, created_at')
    .eq('thread_id', thread.id)
    .order('created_at', { ascending: false })
    .limit(20);
  if (msgErr) throw msgErr;
  const zTematem = (msgs || []).find((m) => m.meta && m.meta.gmail && m.meta.gmail.subject);
  const ostatniIn = (msgs || []).find((m) => m.direction === 'in' && m.meta && m.meta.gmail && m.meta.gmail.id);
  return {
    thread,
    temat: zTematem ? zTematem.meta.gmail.subject : '(bez tematu)',
    lastGmailMessageId: ostatniIn ? ostatniIn.meta.gmail.id : null,
  };
}

// Nadawca SMS-a: numer HANDLOWCA (Lorenzo → jego numer Zadarmy), fallback =
// jawny override ZADARMA_SMS_CALLER_ID albo numer firmowy. Bez plusa: Zadarma
// trzyma numery jako '48459567870' (tak zwraca /v1/direct_numbers) i dopasowuje
// caller_id po dokładnym stringu — '+48…' nie łapie rejestracji i SMS wychodzi
// jako domyślny nadawca "zadarma.com".
function resolveSmsCaller(senderName) {
  const perUser = { lorenzo: process.env.LORENZO_ZADARMA_NUMBER };
  const rawCaller = perUser[String(senderName || '').trim().toLowerCase()]
    || process.env.ZADARMA_SMS_CALLER_ID
    || process.env.ZADARMA_OWN_NUMBER;
  return String(rawCaller || '').replace(/\D/g, '');
}

// Wysyłka SMS + pełny ślad. Rzuca Error, gdy Zadarma nie zwróci success
// (celowo bez fallbacku na nadawcę "zadarma.com" — błąd ma być widoczny).
async function sendSmsAndLog(db, { telefonDigits, tresc, senderName, lead = null, displayName = null, zrodlo = 'karta_leada', metaExtra = {} }) {
  const body = String(tresc || '').trim();
  const digits = normalizePhoneDigits(telefonDigits);
  if (!body) throw new Error('Pusta treść SMS-a');
  if (!digits || digits.length < 9) throw new Error('Brak poprawnego numeru telefonu');
  const komPhone = identity.normalize('phone', digits);

  const callerDigits = resolveSmsCaller(senderName);
  const params = { number: komPhone, message: body };
  if (callerDigits) params.caller_id = callerDigits;
  const wynik = await callZadarma('/v1/sms/send/', params, 'POST');
  if (!wynik || wynik.status !== 'success') {
    throw new Error(`Zadarma SMS: ${wynik && (wynik.message || wynik.status) || 'brak odpowiedzi'}`);
  }

  const customer = await resolveCustomerForLead(db, {
    digits, email: null, displayName: (lead && lead['Name']) || displayName || null,
  });
  const { thread } = await identity.attachThread(db, customer, 'sms', komPhone);
  const { error: msgErr } = await db.from('kom_messages').insert({
    thread_id: thread.id,
    direction: 'out',
    body,
    sent_by: senderName || 'antoni',
    meta: { sms: { messages: wynik.messages ?? null, cost: wynik.cost ?? null, nadawca: callerDigits || null }, zrodlo, ...metaExtra },
  });
  if (msgErr) console.warn('kontakt: zapis kom_messages (sms):', msgErr.message);
  await db.from('kom_threads').update({ last_message_at: new Date().toISOString() }).eq('id', thread.id);

  await appendHistoriaLine(db, lead, `[SMS→] ${body.replace(/\s+/g, ' ').slice(0, 160)}`);

  return { ok: true, czesci: wynik.messages ?? null, koszt: wynik.cost ?? null, threadId: thread.id };
}

// Wysyłka maila + pełny ślad. Skrzynka NADAWCY (kom_mailboxes.app_user_id);
// odpowiedź w wątku tylko gdy najświeższy wątek klienta należy do tej skrzynki
// (wysyłka z cudzej byłaby podszyciem), inaczej nowy mail z wymaganym tematem.
// Błędy oczekiwane niosą err.code: NO_MAILBOX / TEMAT_REQUIRED.
async function sendMailAndLog(db, { email, temat, tresc, senderUserId, senderName, lead = null, zrodlo = 'karta_leada', metaExtra = {} }) {
  const body = String(tresc || '').trim();
  const to = String(email || '').trim().toLowerCase();
  if (!body) throw new Error('Pusta treść maila');
  if (!to) throw new Error('Brak adresu e-mail odbiorcy');

  const userBox = senderUserId ? await gmail.mailboxForUser(db, senderUserId) : null;
  if (!userBox) {
    const err = new Error('Brak podpiętej skrzynki Gmail dla nadawcy');
    err.code = 'NO_MAILBOX';
    throw err;
  }

  const customer = await resolveCustomerForLead(db, {
    digits: '', email: to, displayName: lead ? lead['Name'] : null,
  });

  const mailInfo = await findMailThread(db, [customer.id]);
  const wWatku = Boolean(mailInfo && mailInfo.thread.meta.gmail.mailbox === userBox.email);
  let sent;
  let subjectUsed;
  let threadRow;
  if (wWatku) {
    subjectUsed = mailInfo.temat;
    sent = await gmail.sendReply(db, {
      mailbox: userBox.email,
      to,
      subject: subjectUsed,
      text: body,
      gmailThreadId: mailInfo.thread.meta.gmail.threadId,
      lastGmailMessageId: mailInfo.lastGmailMessageId,
    });
    threadRow = mailInfo.thread;
  } else {
    subjectUsed = String(temat || '').trim();
    if (!subjectUsed) {
      const err = new Error('Podaj temat — to będzie nowy mail (klient nie ma wątku w Twojej skrzynce)');
      err.code = 'TEMAT_REQUIRED';
      throw err;
    }
    sent = await gmail.sendNew(db, { mailbox: userBox.email, to, subject: subjectUsed, text: body });
    const { thread } = await identity.attachThread(db, customer, 'email', sent.threadId);
    threadRow = thread;
    // meta.gmail jak przy ingest — odpowiedź klienta dołączy do tego
    // samego wątku kom, a komunikator wie, z której skrzynki odpisywać.
    const meta = { ...(thread.meta || {}), gmail: { ...(thread.meta?.gmail || {}), threadId: sent.threadId, mailbox: userBox.email } };
    const { error: metaErr } = await db.from('kom_threads').update({ meta }).eq('id', thread.id);
    if (metaErr) console.warn('kontakt: zapis meta wątku:', metaErr.message);
  }

  const { error: msgErr } = await db.from('kom_messages').insert({
    thread_id: threadRow.id,
    direction: 'out',
    body,
    sent_by: senderName || 'antoni',
    external_message_id: `gmail:${sent.id}`,
    meta: { gmail: { id: sent.id, threadId: sent.threadId, subject: subjectUsed, mailbox: userBox.email }, zrodlo, ...metaExtra },
  });
  if (msgErr) console.warn('kontakt: zapis kom_messages:', msgErr.message);
  await db.from('kom_threads').update({ last_message_at: new Date().toISOString() }).eq('id', threadRow.id);

  await appendHistoriaLine(db, lead, `[Mail→] ${subjectUsed} — ${body.replace(/\s+/g, ' ').slice(0, 120)}`);

  return { ok: true, tryb: wWatku ? 'watek' : 'nowy', temat: subjectUsed, skrzynka: userBox.email, threadId: threadRow.id };
}

// Zapis PRZYCHODZĄCEGO SMS-a (Zadarma → Make → webhook). Lustro sendSmsAndLog,
// tylko direction 'in': wątek klienta w komunikatorze + wiadomość, dzięki czemu
// worker kampanii (odpowiedzialSmsem czyta kom_messages 'in') sam zatrzymuje
// follow-upy po odpowiedzi. NIE dotyka feedbacku/akcji leada - to robi warstwa
// wyżej (webhook) po analizie AI. Zwraca { threadId, customerId }.
async function recordInboundSms(db, { fromDigits, tresc, lead = null, displayName = null, metaExtra = {} }) {
  const digits = normalizePhoneDigits(fromDigits);
  const body = String(tresc || '').trim();
  if (!digits || digits.length < 9) throw new Error('Brak poprawnego numeru nadawcy SMS');
  if (!body) throw new Error('Pusta treść SMS-a');
  const komPhone = identity.normalize('phone', digits);
  const customer = await resolveCustomerForLead(db, {
    digits, email: null, displayName: (lead && lead['Name']) || displayName || null,
  });
  const { thread } = await identity.attachThread(db, customer, 'sms', komPhone);
  const { error: msgErr } = await db.from('kom_messages').insert({
    thread_id: thread.id,
    direction: 'in',
    body,
    sent_by: null,
    meta: { sms: { nadawca: komPhone }, zrodlo: 'zadarma_sms', ...metaExtra },
  });
  if (msgErr) console.warn('kontakt: zapis kom_messages (sms in):', msgErr.message);
  await db.from('kom_threads').update({ last_message_at: new Date().toISOString() }).eq('id', thread.id);
  return { threadId: thread.id, customerId: customer.id };
}

module.exports = {
  normalizePhoneDigits,
  warsawDateTimeStr,
  findLeadByIdLeada,
  appendHistoriaLine,
  resolveCustomerForLead,
  findMailThread,
  resolveSmsCaller,
  sendSmsAndLog,
  sendMailAndLog,
  recordInboundSms,
};
