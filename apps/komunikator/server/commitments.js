// ── Obietnice z wiadomości -> kom_commitments ────────────────────────────────
// Ożywienie tabeli-widma wg docs/plan-komunikator-followupy.md Etap 3 +
// docs/plan-watchdog-feedback.md (wiadomości). Działa w cronie workera
// (co 30 min przez pg_cron), dwie fazy:
//   1. auto-zamykanie: owner='klient' zamyka odpowiedź klienta (in),
//      owner='my' zamyka nasza wysłana wiadomość (out) — po created_at obietnicy,
//   2. ekstrakcja: nieprzeskanowane wiadomości in/out z ostatnich 3 dni,
//      per wątek jeden call LLM (task 'commitments'); AI tworzy od razu
//      status 'open' (model zaufania z planu — bez kolejki akceptacji).
// Znacznik przeskanowania: kom_messages.meta.commitments_checked = true.
// Alertowanie przeterminowanych robi dispatcher watchdoga (unia), nie ten moduł.

const { complete } = require('./llm');

const EXTRACT_WINDOW_DAYS = 3;
const THREADS_PER_RUN = 10;
const CONTEXT_MESSAGES = 8;

function warsawToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date()); // YYYY-MM-DD
}

// "YYYY-MM-DD" (Warsaw, 09:00) -> ISO. Offset liczony iteracyjnie jak w
// apps/shared/server/watchdog.js (DST przesuwa o pełną godzinę).
function warsawDateToIso(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  let guess = Date.UTC(y, mo - 1, d, 9, 0) - 3600000;
  for (let i = 0; i < 2; i += 1) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Warsaw', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(guess)).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    const diff = Date.UTC(y, mo - 1, d, 9, 0)
      - Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    if (!diff) break;
    guess += diff;
  }
  return new Date(guess).toISOString();
}

function buildSystem(dzisiaj) {
  return `Jesteś asystentem komunikatora firmy LumLum (oświetlenie LED premium).
Dostajesz fragment rozmowy z klientem. Wyłap NOWE obietnice/zobowiązania:
- owner "my"     — MY coś zrobimy ("prześlę jutro wycenę", "oddzwonię", "sprawdzę i dam znać"),
- owner "klient" — KLIENT coś zrobi / da znać ("zdecyduję po weekendzie", "wrócę z urlopu i zamówię", "pogadam z żoną").
Zwróć WYŁĄCZNIE JSON: {"commitments": [{"description": "...", "owner": "my|klient", "due_date": "YYYY-MM-DD"}]}.

ZASADY:
- DZISIAJ: ${dzisiaj}. Daty względne ("jutro", "za tydzień", "po świętach") przelicz na konkretną datę.
- Obietnica bez terminu: oceń pilność i wybierz due_date +3 dni (pilne/konkretne),
  +7 dni (normalne) albo +14 dni (luźne "kiedyś dam znać").
- description: krótko po polsku (max 10 słów), co i kto ma zrobić.
- NIE twórz obietnicy z ogólników, pytań ani uprzejmości. Wątpliwe → pomiń.
- NIE duplikuj obietnic z listy JUŻ OTWARTYCH (podanej niżej) — jeśli to samo
  zobowiązanie, pomiń.
- Brak obietnic → {"commitments": []}.`;
}

function parseCommitments(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed.commitments) ? parsed.commitments : [];
  } catch {
    return [];
  }
}

async function markChecked(db, messages, report) {
  for (const msg of messages) {
    const meta = { ...(msg.meta || {}), commitments_checked: true };
    const { error } = await db.from('kom_messages').update({ meta }).eq('id', msg.id);
    if (error) report.errors.push(`mark ${msg.id}: ${error.message}`);
  }
}

async function sweep(db, { threadsLimit = THREADS_PER_RUN } = {}) {
  const report = { autoclosed: 0, threads: 0, created: 0, checked: 0, errors: [] };

  // 1. Auto-zamykanie otwartych obietnic (aktywność = wiadomość we właściwym
  // kierunku po utworzeniu obietnicy).
  const { data: open, error: openErr } = await db.from('kom_commitments')
    .select('id,thread_id,customer_id,owner,created_at').eq('status', 'open');
  if (openErr) { report.errors.push(`open: ${openErr.message}`); return report; }
  for (const c of open || []) {
    if (!c.thread_id) continue;
    const dir = c.owner === 'klient' ? 'in' : 'out';
    const { data: m, error } = await db.from('kom_messages')
      .select('id').eq('thread_id', c.thread_id).eq('direction', dir)
      .gt('created_at', c.created_at).limit(1);
    if (error) { report.errors.push(`autoclose ${c.id}: ${error.message}`); continue; }
    if (m && m.length) {
      const { error: upErr } = await db.from('kom_commitments')
        .update({ status: 'done', resolved_at: new Date().toISOString() }).eq('id', c.id).eq('status', 'open');
      if (upErr) report.errors.push(`autoclose-up ${c.id}: ${upErr.message}`);
      else report.autoclosed += 1;
    }
  }

  // 2. Ekstrakcja z nieprzeskanowanych wiadomości (okno 3 dni, per wątek).
  const since = new Date(Date.now() - EXTRACT_WINDOW_DAYS * 86400000).toISOString();
  const { data: msgs, error: msgErr } = await db.from('kom_messages')
    .select('id,thread_id,direction,body,created_at,meta')
    .in('direction', ['in', 'out'])
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(300);
  if (msgErr) { report.errors.push(`msgs: ${msgErr.message}`); return report; }
  const unchecked = (msgs || []).filter((m) => !(m.meta && m.meta.commitments_checked) && String(m.body || '').trim());

  const byThread = new Map();
  unchecked.forEach((m) => {
    if (!byThread.has(m.thread_id)) byThread.set(m.thread_id, []);
    byThread.get(m.thread_id).push(m);
  });

  const threadIds = [...byThread.keys()].slice(0, threadsLimit);
  for (const threadId of threadIds) {
    const newMsgs = byThread.get(threadId);
    try {
      const { data: threads, error: tErr } = await db.from('kom_threads')
        .select('id,customer_id,channel,kom_customers(display_name,public_id)').eq('id', threadId).limit(1);
      if (tErr) throw tErr;
      const thread = threads && threads[0];
      if (!thread || !thread.customer_id) { await markChecked(db, newMsgs, report); continue; }

      const [ctxRes, openCustRes] = await Promise.all([
        db.from('kom_messages').select('direction,body,created_at').eq('thread_id', threadId)
          .order('created_at', { ascending: false }).limit(CONTEXT_MESSAGES),
        db.from('kom_commitments').select('description,owner,due_at').eq('customer_id', thread.customer_id).eq('status', 'open'),
      ]);
      const ctx = (ctxRes.data || []).reverse();
      const openCust = openCustRes.data || [];

      const newIds = new Set(newMsgs.map((m) => m.id));
      const payload = [
        `Klient: ${thread.kom_customers?.display_name || thread.kom_customers?.public_id || 'nieznany'} (kanał: ${thread.channel})`,
        '',
        'ROZMOWA (od najstarszej; [NOWE] = wiadomości do przeskanowania, reszta to kontekst):',
        ...ctx.map((m) => `${m.direction === 'in' ? 'KLIENT' : 'MY'} (${String(m.created_at).slice(0, 16)}): ${String(m.body).slice(0, 500)}`),
        ...newMsgs.filter((m) => !ctx.some((c) => c.created_at === m.created_at && c.body === m.body))
          .map((m) => `[NOWE] ${m.direction === 'in' ? 'KLIENT' : 'MY'} (${String(m.created_at).slice(0, 16)}): ${String(m.body).slice(0, 500)}`),
        '',
        'JUŻ OTWARTE OBIETNICE (nie duplikuj):',
        JSON.stringify(openCust),
      ].join('\n');

      const { text } = await complete({
        task: 'commitments',
        system: buildSystem(warsawToday()),
        messages: [{ role: 'user', content: payload }],
        maxTokens: 1000,
        json: true,
        reasoningEffort: 'minimal',
      });
      const found = parseCommitments(text);
      for (const c of found) {
        const owner = c.owner === 'klient' ? 'klient' : 'my';
        const dueAt = warsawDateToIso(c.due_date) || warsawDateToIso(warsawToday());
        const description = String(c.description || '').trim().slice(0, 300);
        if (!description || !dueAt) continue;
        const { error: insErr } = await db.from('kom_commitments').insert({
          customer_id: thread.customer_id,
          thread_id: threadId,
          source_message_id: newMsgs[newMsgs.length - 1].id,
          description,
          owner,
          due_at: dueAt,
          status: 'open',
          created_by: 'ai',
        });
        if (insErr) report.errors.push(`insert ${threadId}: ${insErr.message}`);
        else report.created += 1;
      }
      await markChecked(db, newMsgs, report);
      report.checked += newMsgs.length;
      report.threads += 1;
    } catch (err) {
      report.errors.push(`thread ${threadId}: ${err.message}`);
    }
  }
  return report;
}

module.exports = { sweep, warsawDateToIso, parseCommitments };
