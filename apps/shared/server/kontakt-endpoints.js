// ── Panel Kontakt na karcie leada (Backlog B2C + CRM) ────────────────────────
// Etap 1 planu docs/plan-kontakt-karta-leada.md: scalona oś czasu kontaktu.
// Telefony/notatki żyją w kolumnie "Historia rozmów" i "Log zmian" (front ma
// je pod ręką), a ten endpoint dokłada wiadomości z komunikatora (mail/DM/
// komentarze, docelowo SMS) dopasowane po telefonie/e-mailu leada — wzorzec
// read-time jak GET /api/wyceny/dla-leada, bez nowej tabeli.
//
// Przy pierwszym trafieniu zapisuje kom_customers.crm_lead_id — "jedyny most
// do CRM" z migracji komunikatora (001_init.sql), dotąd nieużywany. Dzięki
// temu kolejne odczyty i przyszłe odwrotne lookupy (komunikator → karta) mają
// trwały link; istniejącego, INNEGO powiązania nigdy nie nadpisujemy.

// Czysta logika tożsamości komunikatora (normalizacja 48XXXXXXXXX, łańcuch
// merged_into) — moduł jest dependency-injected, więc require przez appki
// CRM/Backlog jest bezpieczny (Vercel dociąga plik przez trace require()).
const identity = require('../../komunikator/server/identity');
// Wysyłka Gmail (Etap 3): reply-in-thread / nowy mail + skrzynka usera
// (kom_mailboxes.app_user_id). Env GOOGLE_* jest project-wide na Vercelu.
const gmail = require('../../komunikator/server/ingest/gmail');
// SMS (Etap 4): podpisany klient API Zadarmy z backlogu (HMAC-SHA1).
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

function handleError(res, err, fallbackStatus = 400) {
  console.error(err);
  const message = err.message || 'Wewnętrzny błąd serwera';
  res.status(fallbackStatus).json({ error: message });
}

function registerKontaktEndpoints(app, { getClient, requireView, requireEdit }) {
  const view = requireView || ((req, res, next) => next());
  const edit = requireEdit || ((req, res, next) => next());

  // GET /api/kontakt/dla-leada?telefon=&email=&lead_id= — klienci komunikatora
  // dopasowani do leada + ich wiadomości (wszystkie kanały, najnowsze pierwsze,
  // limit 300). Front skleja to z wpisami karty w jedną oś czasu.
  app.get('/api/kontakt/dla-leada', view, async (req, res) => {
    try {
      const db = getClient();
      const digits = normalizePhoneDigits(req.query.telefon);
      const email = String(req.query.email || '').trim().toLowerCase();
      // lead_id kanonicznie int-jako-tekst ("314", nie "314.0") — spójnie
      // z wyceny.lead_id i GET /api/wyceny/szukaj-leada.
      const leadIdNum = Number(req.query.lead_id);
      const leadId = Number.isFinite(leadIdNum) ? String(leadIdNum) : null;
      if (!digits && !email && !leadId) {
        return res.status(400).json({ error: 'Podaj telefon, email lub lead_id' });
      }

      // Twarde identyfikatory → kom_customer_identities (telefon w formacie
      // komunikatora: 9 cyfr dostaje prefiks 48). Dwa osobne zapytania zamiast
      // .or() — e-mail z przecinkiem/nawiasem rozsypałby składnię filtra.
      const komPhone = digits ? identity.normalize('phone', digits) : '';
      const lookups = [];
      if (komPhone) {
        lookups.push(db.from('kom_customer_identities').select('customer_id').eq('type', 'phone').eq('value', komPhone));
      }
      if (email) {
        lookups.push(db.from('kom_customer_identities').select('customer_id').eq('type', 'email').eq('value', email));
      }
      const results = await Promise.all(lookups);
      for (const r of results) if (r.error) throw r.error;
      const ids = new Set();
      results.forEach((r) => (r.data || []).forEach((row) => ids.add(row.customer_id)));

      // Klienci już powiązani z leadem (poprzednie wizyty zapisały most).
      if (leadId) {
        const { data: linked, error: linkedErr } = await db
          .from('kom_customers')
          .select('id')
          .eq('crm_lead_id', leadId)
          .is('merged_into', null);
        if (linkedErr) throw linkedErr;
        (linked || []).forEach((r) => ids.add(r.id));
      }

      // Tożsamości mogą wskazywać rekordy scalone — podążamy za merged_into
      // do żywych klientów i deduplikujemy.
      const customers = [];
      const seen = new Set();
      for (const id of ids) {
        const c = await identity.loadCustomer(db, id);
        if (c && !seen.has(c.id)) {
          seen.add(c.id);
          customers.push(c);
        }
      }

      // Most do CRM: dopiero co dopasowany klient bez powiązania dostaje
      // ID Leada. Błąd zapisu nie psuje odczytu (oś czasu i tak wraca).
      if (leadId) {
        for (const c of customers) {
          if (c.crm_lead_id) continue;
          const { error: updErr } = await db.from('kom_customers').update({ crm_lead_id: leadId }).eq('id', c.id);
          if (updErr) console.warn('kontakt: zapis crm_lead_id nie powiódł się:', updErr.message);
          else c.crm_lead_id = leadId;
        }
      }

      if (!customers.length) return res.json({ customers: [], messages: [] });

      const { data: threads, error: thErr } = await db
        .from('kom_threads')
        .select('id, channel')
        .in('customer_id', customers.map((c) => c.id));
      if (thErr) throw thErr;
      const threadChannel = new Map((threads || []).map((t) => [t.id, t.channel]));

      let messages = [];
      if (threadChannel.size) {
        const { data: msgs, error: msgErr } = await db
          .from('kom_messages')
          .select('id, thread_id, direction, body, sent_by, created_at, meta')
          .in('thread_id', [...threadChannel.keys()])
          .order('created_at', { ascending: false })
          .limit(300);
        if (msgErr) throw msgErr;
        messages = (msgs || []).map((m) => ({
          id: m.id,
          channel: threadChannel.get(m.thread_id) || 'note',
          direction: m.direction,
          body: m.body || '',
          sent_by: m.sent_by || null,
          created_at: m.created_at,
          // meta.kind: 'comment' = publiczny komentarz FB/IG/TikTok (nie DM).
          kind: (m.meta && m.meta.kind) || null,
        }));
      }

      // Dane dla composera (Etap 3-4): skrzynka zalogowanego użytkownika,
      // tryb wysyłki maila (odpowiedź w wątku vs nowy) i gotowość SMS.
      // Reply-in-thread tylko gdy wątek należy do skrzynki piszącego —
      // wysyłka z cudzej skrzynki byłaby podszyciem, wtedy nowy mail.
      let wysylka = null;
      try {
        const userBox = req.user ? await gmail.mailboxForUser(db, req.user.id) : null;
        const mailInfo = await findMailThread(db, customers.map((c) => c.id));
        const wWatku = Boolean(mailInfo && userBox && mailInfo.thread.meta.gmail.mailbox === userBox.email);
        wysylka = {
          mail: {
            skrzynka: userBox ? userBox.email : null,
            tryb: wWatku ? 'watek' : 'nowy',
            temat: wWatku ? mailInfo.temat : null,
          },
          sms: { skonfigurowany: Boolean(process.env.ZADARMA_API_KEY && process.env.ZADARMA_API_SECRET) },
        };
      } catch (err) {
        console.warn('kontakt: info o wysyłce niedostępne:', err.message);
      }

      res.json({
        customers: customers.map((c) => ({
          public_id: c.public_id,
          display_name: c.display_name || null,
          // Deep-link jak z hubu — komunikator otwiera klienta po public_id.
          url: `/wiadomosci/?klient=${encodeURIComponent(c.public_id)}`,
        })),
        messages,
        wysylka,
      });
    } catch (err) {
      handleError(res, err, 502);
    }
  });

  // POST /api/kontakt/mail — { lead_id, telefon, email, temat?, tresc }.
  // Wysyłka ze skrzynki ZALOGOWANEGO użytkownika (kom_mailboxes.app_user_id):
  // klient ma wątek mailowy w tej skrzynce → odpowiedź w wątku (Re:/
  // In-Reply-To/threadId), w przeciwnym razie nowy mail (wymaga tematu).
  // Ślad: kom_messages (direction out, sent_by = nazwa usera) + linia
  // "[Mail→] …" w Historii rozmów leada.
  app.post('/api/kontakt/mail', edit, async (req, res) => {
    try {
      const db = getClient();
      const tresc = String(req.body?.tresc || '').trim();
      const to = String(req.body?.email || '').trim().toLowerCase();
      const digits = normalizePhoneDigits(req.body?.telefon);
      if (!tresc) return res.status(400).json({ error: 'Pusta treść maila' });
      if (!to) return res.status(400).json({ error: 'Lead nie ma adresu e-mail' });

      const userBox = req.user ? await gmail.mailboxForUser(db, req.user.id) : null;
      if (!userBox) {
        return res.status(400).json({
          error: 'Brak podpiętej skrzynki Gmail dla Twojego konta',
          connect: '/wiadomosci/api/gmail/auth',
        });
      }

      const lead = await findLeadByIdLeada(db, req.body?.lead_id);
      const customer = await resolveCustomerForLead(db, {
        digits, email: to, displayName: lead ? lead['Name'] : null,
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
          text: tresc,
          gmailThreadId: mailInfo.thread.meta.gmail.threadId,
          lastGmailMessageId: mailInfo.lastGmailMessageId,
        });
        threadRow = mailInfo.thread;
      } else {
        subjectUsed = String(req.body?.temat || '').trim();
        if (!subjectUsed) return res.status(400).json({ error: 'Podaj temat — to będzie nowy mail (klient nie ma wątku w Twojej skrzynce)' });
        sent = await gmail.sendNew(db, { mailbox: userBox.email, to, subject: subjectUsed, text: tresc });
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
        body: tresc,
        sent_by: (req.user && req.user.name) || 'antoni',
        external_message_id: `gmail:${sent.id}`,
        meta: { gmail: { id: sent.id, threadId: sent.threadId, subject: subjectUsed, mailbox: userBox.email }, zrodlo: 'karta_leada' },
      });
      if (msgErr) console.warn('kontakt: zapis kom_messages:', msgErr.message);
      await db.from('kom_threads').update({ last_message_at: new Date().toISOString() }).eq('id', threadRow.id);

      await appendHistoriaLine(db, lead, `[Mail→] ${subjectUsed} — ${tresc.replace(/\s+/g, ' ').slice(0, 120)}`);

      res.json({ ok: true, tryb: wWatku ? 'watek' : 'nowy', temat: subjectUsed, skrzynka: userBox.email });
    } catch (err) {
      handleError(res, err, 502);
    }
  });

  // POST /api/kontakt/sms — { lead_id, telefon, tresc }. Wysyłka przez API
  // Zadarmy (/v1/sms/send/, konto firmowe; nadawca per user = v2). Ślad:
  // kom_messages w wątku kanału 'sms' (jeden per klient, external_thread_id
  // = 48XXXXXXXXX) + linia "[SMS→] …" w Historii rozmów.
  app.post('/api/kontakt/sms', edit, async (req, res) => {
    try {
      const db = getClient();
      const tresc = String(req.body?.tresc || '').trim();
      const digits = normalizePhoneDigits(req.body?.telefon);
      if (!tresc) return res.status(400).json({ error: 'Pusta treść SMS-a' });
      if (!digits || digits.length < 9) return res.status(400).json({ error: 'Brak poprawnego numeru telefonu' });
      const komPhone = identity.normalize('phone', digits);

      const params = { number: komPhone, message: tresc };
      if (process.env.ZADARMA_SMS_CALLER_ID) params.caller_id = process.env.ZADARMA_SMS_CALLER_ID;
      const wynik = await callZadarma('/v1/sms/send/', params, 'POST');
      if (!wynik || wynik.status !== 'success') {
        throw new Error(`Zadarma SMS: ${wynik && (wynik.message || wynik.status) || 'brak odpowiedzi'}`);
      }

      const lead = await findLeadByIdLeada(db, req.body?.lead_id);
      const customer = await resolveCustomerForLead(db, {
        digits, email: null, displayName: lead ? lead['Name'] : null,
      });
      const { thread } = await identity.attachThread(db, customer, 'sms', komPhone);
      const { error: msgErr } = await db.from('kom_messages').insert({
        thread_id: thread.id,
        direction: 'out',
        body: tresc,
        sent_by: (req.user && req.user.name) || 'antoni',
        meta: { sms: { messages: wynik.messages ?? null, cost: wynik.cost ?? null }, zrodlo: 'karta_leada' },
      });
      if (msgErr) console.warn('kontakt: zapis kom_messages (sms):', msgErr.message);
      await db.from('kom_threads').update({ last_message_at: new Date().toISOString() }).eq('id', thread.id);

      await appendHistoriaLine(db, lead, `[SMS→] ${tresc.replace(/\s+/g, ' ').slice(0, 160)}`);

      res.json({ ok: true, czesci: wynik.messages ?? null });
    } catch (err) {
      handleError(res, err, 502);
    }
  });
}

module.exports = { registerKontaktEndpoints };
