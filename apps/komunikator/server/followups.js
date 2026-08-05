// Follow-up obietnic klienta (docs/plan-auto-odpowiedzi-komentarze.md, v1).
//
// POMYSŁ: klient coś obiecał ("zmierzę w przyszłym tygodniu", "zdecyduję po
// weekendzie") -> commitments.sweep zapisał to jako kom_commitments
// owner='klient', status='open', due_at. Ten moduł:
//   - od razu po obietnicy wysyła krótkie "Jasne, czekamy 😊" (ack),
//   - rano po terminie, jeśli klient milczy, przypomina Twoim stylem (nudge),
//   - +7 dni jeszcze raz (nudge2), potem koniec.
//
// REUSE: ten SAM włącznik co autoresponder (kom_settings.auto_send_enabled),
// ta sama bramka okna Meta (ctx.computeSendState), te same funkcje wysyłki
// (ctx.sendViaZernio / ctx.sendPrivateReply) i ten sam worker (/api/cron/outbox).
// Osobny outbox (kom_followup), żeby nie mieszać z pierwszym kontaktem
// (kom_autoreply) i nie ruszać działającego autorespondera.
//
// BEZPIECZEŃSTWO: OFF (domyślnie) = podgląd 'held' ("wysłałby"), nic nie leci.
// "open" obietnicy = klient milczy (commitments.sweep zamyka na 'done' przy
// pierwszej wiadomości klienta), więc nie przypominamy komuś, kto już odpisał.
// Pre-sale bramka siedzi w generacji (generateFollowup zwraca POMIŃ dla spraw
// posprzedażowych/reklamacji/off-topic -> wiersz 'skipped: not-presale').

const llm = require('./llm');

const AUTO_KEY = 'auto_send_enabled';        // wspólny włącznik z autoresponderem
const ACK_FRESH_MS = 3 * 60 * 60 * 1000;     // ack tylko dla świeżych obietnic (anty-backfill)
const ACK_DELAY_MIN_MS = 2 * 60 * 1000;      // ack z lekkim opóźnieniem (anty-bot): 2..12 min
const ACK_DELAY_MAX_MS = 12 * 60 * 1000;
const NUDGE_MAX_AGE_MS = 21 * 86400000;      // nie budzimy obietnic dawno po terminie (anty-backfill)
const SECOND_AFTER_MS = 7 * 86400000;        // drugie przypomnienie +7 dni po pierwszym
const COMMITS_PER_RUN = 200;                 // ile obietnic skanujemy przy kolejkowaniu
const BATCH = 6;                             // ile pozycji wysyłamy/podglądamy na przebieg

function randAckDelayMs() {
  return ACK_DELAY_MIN_MS + Math.floor(Math.random() * (ACK_DELAY_MAX_MS - ACK_DELAY_MIN_MS));
}

// ── Kolejkowanie: kom_commitments (klient, open) -> wiersze kom_followup ──────
async function queue(db, result) {
  const nowMs = Date.now();
  const { data: commits, error } = await db
    .from('kom_commitments')
    .select('id,thread_id,customer_id,description,due_at,created_at,status,owner')
    .eq('owner', 'klient')
    .eq('status', 'open')
    .not('thread_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(COMMITS_PER_RUN);
  if (error) { result.errors.push(`queue-commits: ${error.message}`); return; }

  for (const c of commits || []) {
    try {
      const createdMs = new Date(c.created_at).getTime();
      const dueMs = c.due_at ? new Date(c.due_at).getTime() : null;

      // Jakie follow-upy ta obietnica już ma (żeby nie dublować).
      const { data: rows, error: rErr } = await db
        .from('kom_followup')
        .select('purpose,status,created_at,sent_at')
        .eq('commitment_id', c.id);
      if (rErr) { result.errors.push(`queue-rows ${c.id}: ${rErr.message}`); continue; }
      const byPurpose = new Map((rows || []).map((r) => [r.purpose, r]));

      // (1) ACK — świeża obietnica, jeszcze nie potwierdzona.
      if (!byPurpose.has('ack') && nowMs - createdMs < ACK_FRESH_MS) {
        await insertRow(db, c, 'ack', 0, new Date(createdMs + randAckDelayMs()).toISOString(), result);
      }

      // (2) NUDGE — termin minął (świeżo), jeszcze nie przypominaliśmy.
      if (!byPurpose.has('nudge') && dueMs && dueMs <= nowMs && nowMs - dueMs < NUDGE_MAX_AGE_MS) {
        await insertRow(db, c, 'nudge', 1, new Date(dueMs).toISOString(), result);
      }

      // (3) NUDGE2 — +7 dni po REALNIE wysłanym pierwszym przypomnieniu, dalej cisza.
      const nudge = byPurpose.get('nudge');
      if (nudge && nudge.status === 'sent' && !byPurpose.has('nudge2')) {
        const sentMs = new Date(nudge.sent_at || nudge.created_at).getTime();
        if (nowMs - sentMs >= SECOND_AFTER_MS) {
          await insertRow(db, c, 'nudge2', 2, new Date(nowMs).toISOString(), result);
        }
      }
    } catch (err) {
      result.errors.push(`queue ${c.id}: ${err.message}`);
    }
  }
}

async function insertRow(db, commit, purpose, stage, sendAfter, result) {
  const { error } = await db.from('kom_followup').insert({
    commitment_id: commit.id,
    thread_id: commit.thread_id,
    customer_id: commit.customer_id,
    purpose,
    stage,
    send_after: sendAfter,
    status: 'queued',
  });
  if (error) result.errors.push(`insert ${purpose} ${commit.id}: ${error.message}`);
  else result.queued += 1;
}

// ── Wysyłka / podgląd: dojrzałe wiersze kom_followup ─────────────────────────
async function dispatch(db, ctx, enabled, result) {
  const nowIso = new Date().toISOString();
  const { data: due, error } = await db
    .from('kom_followup')
    .select('*')
    .eq('status', 'queued')
    .lte('send_after', nowIso)
    .order('send_after', { ascending: true })
    .limit(BATCH);
  if (error) { result.errors.push(`dispatch: ${error.message}`); return; }

  for (const row of due || []) {
    result.processed += 1;
    try {
      // Obietnica wciąż otwarta? Klient odpisał -> autoclose ustawił 'done' ->
      // nie przypominamy (temat sam się domknął).
      const { data: cs, error: cErr } = await db
        .from('kom_commitments').select('status,description,created_at,due_at').eq('id', row.commitment_id).limit(1);
      if (cErr) throw cErr;
      const commit = cs && cs[0];
      if (!commit) { await mark(db, row.id, 'skipped', { reason: 'no-commitment' }); result.skipped += 1; continue; }
      if (commit.status !== 'open') { await mark(db, row.id, 'cancelled', { reason: 'commitment-resolved' }); result.skipped += 1; continue; }

      const { data: threads, error: tErr } = await db
        .from('kom_threads').select('*').eq('id', row.thread_id).limit(1);
      if (tErr) throw tErr;
      const thread = threads && threads[0];
      if (!thread) { await mark(db, row.id, 'skipped', { reason: 'no-thread' }); result.skipped += 1; continue; }

      const { data: messages, error: mErr } = await db
        .from('kom_messages').select('*')
        .eq('thread_id', thread.id).order('created_at', { ascending: true }).limit(100);
      if (mErr) throw mErr;
      const msgs = messages || [];

      // Ktoś już zareagował ręcznie? Nie wchodzimy w drogę człowiekowi.
      // ACK: jakakolwiek nasza wysyłka po obietnicy = już potwierdzono/odpisano.
      // NUDGE: nasza NIE-followupowa wysyłka po terminie = człowiek już zaczepił.
      const createdMs = new Date(commit.created_at).getTime();
      const dueMs = commit.due_at ? new Date(commit.due_at).getTime() : createdMs;
      const humanOutAfter = (afterMs) => msgs.some((m) =>
        m.direction === 'out' && new Date(m.created_at).getTime() > afterMs && !(m.meta && m.meta.followup));
      if (row.purpose === 'ack' && humanOutAfter(createdMs)) {
        await mark(db, row.id, 'skipped', { reason: 'already-replied' }); result.skipped += 1; continue;
      }
      if (row.purpose !== 'ack' && humanOutAfter(dueMs)) {
        await mark(db, row.id, 'skipped', { reason: 'human-handled' }); result.skipped += 1; continue;
      }

      // Bramka okna Meta — to samo źródło prawdy co wysyłka z panelu.
      const sendState = ctx.computeSendState(thread, msgs);
      if (['closed', 'none', 'manual_only'].includes(sendState.mode)) {
        await mark(db, row.id, 'skipped', { reason: `window-${sendState.mode}:${sendState.reason || ''}` });
        result.skipped += 1;
        continue;
      }

      const customer = await ctx.loadCustomer(db, thread.customer_id);
      const { data: ids } = await db
        .from('kom_customer_identities').select('type').eq('customer_id', customer.id);
      customer.identities = ids || [];

      const text = (await generateFollowup(db, thread, customer, msgs, commit, row.purpose)).trim();
      // Pusto / POMIŃ = pre-sale bramka odrzuciła (sprawa posprzedażowa itp.).
      if (!text) { await mark(db, row.id, 'skipped', { reason: 'not-presale' }); result.skipped += 1; continue; }

      // Wyłączone -> podgląd na sucho: zapisz co BY wysłał, nic nie wychodzi.
      if (!enabled) { await mark(db, row.id, 'held', { generated_text: text }); result.held += 1; continue; }

      // Włączone -> realna wysyłka per kanał (jak autoresponder).
      const outMeta = { auto: true, followup: row.purpose, commitment_id: row.commitment_id };
      if (sendState.mode === 'private_reply') {
        await ctx.sendPrivateReply(thread, sendState.comment, text);
        outMeta.private_reply_to = sendState.comment.commentId;
      } else {
        await ctx.sendViaZernio(thread, text, { humanAgent: sendState.mode === 'human_agent' });
        if (sendState.mode === 'human_agent') outMeta.human_agent = true;
      }
      await db.from('kom_messages').insert({
        thread_id: thread.id,
        direction: 'out',
        body: text,
        sent_by: 'ai_auto',
        meta: outMeta,
      });
      await db.from('kom_threads')
        .update({ status: 'waiting', last_message_at: new Date().toISOString() })
        .eq('id', thread.id);
      await mark(db, row.id, 'sent', { generated_text: text, sent_at: new Date().toISOString() });
      result.sent += 1;
    } catch (err) {
      const windowClosed = err && err.windowClosed;
      await mark(db, row.id, windowClosed ? 'skipped' : 'failed', {
        error: err.message, ...(windowClosed ? { reason: 'window-closed' } : {}),
      });
      result[windowClosed ? 'skipped' : 'failed'] += 1;
      console.error('followups.dispatch row:', err.message);
    }
  }
}

// ── Generacja treści (Twój styl + bramka pre-sale) ───────────────────────────
const STYLE = `Piszesz jak Antoni, właściciel LumLum (oświetlenie LED premium, lumlum.co):
konkretnie, ciepło, po ludzku, bez korporacyjnych formułek i bez podpisu. To czat, nie e-mail - KRÓTKO.
- Lustro powitania: klient "Cześć/hej" -> "Cześć" i na "Ty"; "Dzień dobry" -> grzecznościowo. NIGDY "Pan/Pani" ze slashem; gdy nie znasz płci, pisz bezosobowo.
- Język: klient po polsku/czesku/słowacku -> odpowiadasz po polsku; inny język -> po angielsku (numer +48 604 650 590).
- Emoji: wyłącznie 😊 (nie 🙂, nie 👍). Bez slangu.
- TWARDA ZASADA: nigdy długiego myślnika "—"; zawsze zwykły dywiz "-".`;

function purposeInstruction(purpose, description) {
  if (purpose === 'ack') {
    return `Klient właśnie obiecał: "${description}". Napisz BARDZO krótkie, ciepłe potwierdzenie, że czekamy i nie ma pośpiechu (wzór: "Jasne, czekamy 😊"). NIE proś o numer telefonu. Nic poza jednym zdaniem.`;
  }
  return `Klient obiecał: "${description}", termin minął, a klient milczy. Napisz krótkie, miłe przypomnienie, które NAWIĄZUJE do tej obietnicy (np. gdy obiecał pomiary: "Dzień dobry, czy udało się już pomierzyć?"). Jedno-dwa zdania, bez natrętności, bez twardej prośby o numer.`;
}

function recentTranscript(messages) {
  return messages.slice(-8).map((m) => {
    const who = m.direction === 'in' ? 'KLIENT' : (m.direction === 'internal' ? 'NOTATKA' : 'MY');
    return `${who}: ${String(m.body || '').slice(0, 400)}`;
  }).join('\n');
}

// Zwraca treść wiadomości albo '' gdy pre-sale bramka mówi POMIŃ.
async function generateFollowup(db, thread, customer, messages, commit, purpose) {
  const phoneKnown = (customer.identities || []).some((i) => i.type === 'phone');
  const system = `${STYLE}

${purposeInstruction(purpose, String(commit.description || '').slice(0, 200))}

BRAMKA PRE-SALE: przypominamy TYLKO w sprawach prowadzących do sprzedaży (pomiar, sprawdzenie, decyzja o zakupie, dobór zestawu). Jeśli to sprawa POSPRZEDAŻOWA (reklamacja, problem z zamówieniem/dostawą, montaż po zakupie), spór/negocjacja "a taniej", off-topic albo cokolwiek, gdzie automatyczne przypomnienie byłoby nie na miejscu - zwróć DOKŁADNIE jedno słowo: POMIŃ (i nic więcej).

Kanał: ${thread.channel}. Numer telefonu klienta: ${phoneKnown ? 'ZNANY' : 'NIEZNANY'}.
Odpowiedz WYŁĄCZNIE treścią wiadomości do klienta albo słowem POMIŃ.`;

  const payload = `Klient: ${customer.display_name || '(imię nieznane)'}\n\nOstatnia rozmowa:\n${recentTranscript(messages)}`;
  const { text } = await llm.complete({
    task: 'suggest',
    system,
    messages: [{ role: 'user', content: payload }],
    maxTokens: 220,
  });
  const clean = String(text || '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  // Bramka pre-sale: model zwraca "POMIŃ", gdy NIE wysyłać. Uwaga: \b nie działa
  // po "Ń" (znak nie-ASCII), więc normalizujemy ń->n i dopasowujemy sentinel
  // wprost — cała treść "pomin" albo "pomin" + znak niebędący literą (kropka itp.).
  const sentinel = clean.toLowerCase().replace(/ń/g, 'n');
  if (!clean || /^pomin([^a-ząćęłóśźż]|$)/.test(sentinel)) return '';
  return clean;
}

async function mark(db, id, status, patch = {}) {
  await db.from('kom_followup').update({ status, ...patch }).eq('id', id);
}

// Worker (ten sam takt co autoresponder). ctx = autoreplyCtx() z server.js.
async function sweep(db, ctx) {
  const enabled = (await ctx.getSetting(db, AUTO_KEY, false)) === true;
  const result = { enabled, queued: 0, processed: 0, sent: 0, held: 0, skipped: 0, failed: 0, errors: [] };
  try {
    await queue(db, result);
  } catch (err) {
    result.errors.push(`queue: ${err.message}`);
  }
  await dispatch(db, ctx, enabled, result);
  return result;
}

module.exports = { sweep, generateFollowup, AUTO_KEY };
