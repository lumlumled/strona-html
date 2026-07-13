// ── AI-doradca Fable (backend) ──────────────────────────────────────────────
// Czat, który widzi całą firmę: mózg = docs/fable-doradca-lumlum.md VERBATIM
// jako system prompt (guardrails §5), snapshot wstrzykiwany co turę (§4),
// JEDNO narzędzie stats(group, params) nad fasadą queries.js (§0). Tryb głęboki
// (§9): pętla dopuszcza WIELE kolejnych stats() zanim doradca odpowie.
// Streaming (SSE) obsługuje server.js — tu callback onEvent.
const fs = require('fs');
const path = require('path');
const Q = require('./queries');

const MAX_TOOL_RESULT = 12000; // limit rozmiaru wyniku stats() wstrzykiwanego do modelu
const MAX_ITERS = 6;           // bezpiecznik pętli tool-use (deep mode = wiele wywołań)

// ── Prompt Fable (VERBATIM, leniwie z pliku; docs/ dołączane w vercel.json) ──
let _fable = null;
function fablePrompt() {
  if (_fable == null) {
    const p = path.join(__dirname, '..', '..', '..', 'docs', 'fable-doradca-lumlum.md');
    _fable = fs.readFileSync(p, 'utf8');
  }
  return _fable;
}

function buildSystemPrompt(snapshot) {
  return `${fablePrompt()}

---

## AKTUALNY SNAPSHOT FIRMY (żywe dane, wstrzyknięte automatycznie co turę)

To jest wynik \`stats(group:"snapshot")\` na teraz. 80% pytań odpowiadaj z tego, BEZ dopytywania użytkownika o liczby, które tu są. Głębsze grupy przez narzędzie \`stats()\` — do doszczegółowienia i kopania (tryb głęboki, sekcja 9).

\`\`\`json
${JSON.stringify(snapshot, null, 2)}
\`\`\``;
}

// ── Fasada danych: JEDNO narzędzie stats(group, params) → queries.js ─────────
const GROUPS = {
  snapshot: (db) => Q.snapshot(db),
  sprzedaz: (db, p) => Q.sprzedaz(db, p || {}),
  pipeline: (db, p) => Q.pipeline(db, p || {}),
  outreach: (db, p) => Q.outreach(db, p || {}),
  leady: (db) => Q.leady(db),
  'close-rate': (db) => Q.closeRate(db),
  konwersje: (db) => Q.konwersje(db),
  kampanie: (db, p) => Q.kampanie(db, p || {}),
  radar: (db) => Q.b2bRadar(db),
  forward: (db) => Q.forward(db),
  faktury: (db) => Q.faktury(db),
  marza: (db) => Q.marzaRealna(db),
  organik: (db, p) => Q.organik(db, p || {}),
  przeglad: (db) => Q.przeglad(db),
};

const STATS_TOOL = {
  name: 'stats',
  description: 'Żywe liczby LumLum (read-only). Wołaj WIELE razy pod rząd, żeby kopać w głąb: snapshot → anomalia → dociągnij grupę → skoreluj → odpowiedz. Grupy: snapshot (pełny rollup), sprzedaz, pipeline (otwarte wyceny + top do dzwonienia), outreach (telefony, dodzwonienia, czas rozmowy, martwe wyceny), leady (lejek), close-rate, konwersje (krzywa umierania wyceny, ściana cenowa, dowód telefonu), kampanie (ad→lead→przychód + hooki), radar (B2B „powinien już zamówić"), forward (prognoza, cena zaniedbania, wejścia tygodnia), faktury, marza (realna wg cennika), organik, przeglad (momentum + korelacje).',
  input_schema: {
    type: 'object',
    properties: {
      group: { type: 'string', enum: Object.keys(GROUPS) },
      params: {
        type: 'object',
        description: 'Opcjonalne filtry. pipeline: {olderThanDays,minKwota,owner,limit}; outreach/kampanie/organik/sprzedaz: {okres:"1d|3d|7d|30d|90d"} albo {from,to}; outreach też {handlowiec}; sprzedaz: {owner}. Owner="all" = całość (admin).',
      },
    },
    required: ['group'],
  },
};

async function runStats(db, group, params) {
  const fn = GROUPS[group];
  if (!fn) return { error: `Nieznana grupa "${group}". Dozwolone: ${Object.keys(GROUPS).join(', ')}.` };
  try {
    return await fn(db, params);
  } catch (err) {
    return { error: `stats(${group}) padło: ${err.message}` };
  }
}

// ── Wybór modelu (env, wzorem apps/komunikator/server/llm.js) ────────────────
// Szybki model do czatu; deep=true → mocniejszy (Opus) na głęboką analizę.
function parseSpec(spec) {
  const [provider, ...rest] = String(spec).split(':');
  return { provider, model: rest.join(':') };
}
function pickModel(deep) {
  const spec = deep
    ? (process.env.LLM_DORADCA_DEEP || process.env.LLM_DORADCA || 'anthropic:claude-opus-4-1')
    : (process.env.LLM_DORADCA || 'anthropic:claude-sonnet-4-6');
  return parseSpec(spec);
}

// ── Streaming Anthropic Messages API (SSE) z tool-use ────────────────────────
// Zwraca { content: [bloki], stop_reason }. Tekst leci na bieżąco przez onDelta.
async function anthropicStream({ system, model, tools, messages, onDelta }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Brak ANTHROPIC_API_KEY w konfiguracji serwera');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 2048, system, tools, messages, stream: true }),
  });
  if (!res.ok || !res.body) {
    const t = res.body ? await res.text() : '';
    throw new Error(`Anthropic ${res.status}: ${t.slice(0, 300)}`);
  }

  const blocks = [];
  let stopReason = null;
  const handle = (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let ev; try { ev = JSON.parse(payload); } catch { return; }
    switch (ev.type) {
      case 'content_block_start': {
        const b = ev.content_block || {};
        if (b.type === 'text') blocks[ev.index] = { type: 'text', text: b.text || '' };
        else if (b.type === 'tool_use') blocks[ev.index] = { type: 'tool_use', id: b.id, name: b.name, input: {}, _json: '' };
        break;
      }
      case 'content_block_delta': {
        const d = ev.delta || {};
        const b = blocks[ev.index];
        if (!b) break;
        if (d.type === 'text_delta') { b.text += d.text; if (onDelta && d.text) onDelta(d.text); }
        else if (d.type === 'input_json_delta') { b._json += d.partial_json || ''; }
        break;
      }
      case 'content_block_stop': {
        const b = blocks[ev.index];
        if (b && b.type === 'tool_use') { try { b.input = b._json ? JSON.parse(b._json) : {}; } catch { b.input = {}; } delete b._json; }
        break;
      }
      case 'message_delta': { if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason; break; }
      default: break;
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) handle(line);
    }
  }
  if (buf.trim()) handle(buf.trim());
  if (stopReason === 'refusal') throw new Error('Model odmówił odpowiedzi (refusal)');
  return { content: blocks.filter(Boolean), stop_reason: stopReason };
}

// ── Pętla czatu z tool-use (deep mode) ──────────────────────────────────────
// onEvent({type}): 'text'{text} | 'tool'{group,input} | 'tool_result'{group} |
//                  'done'{capped?} | 'error'{message}
// callModel wstrzykiwalny do testów; domyślnie anthropicStream z wybranym modelem.
async function chat({ db, messages, deep = false, onEvent = () => {}, callModel, maxIters = MAX_ITERS }) {
  const snapshot = await Q.snapshot(db);
  const system = buildSystemPrompt(snapshot);
  const { provider, model } = pickModel(deep);
  const call = callModel || (({ system: s, tools, messages: m, onDelta }) => {
    if (provider !== 'anthropic') throw new Error(`Doradca: nieobsługiwany dostawca modelu "${provider}"`);
    return anthropicStream({ system: s, model, tools, messages: m, onDelta });
  });

  const convo = (messages || []).map((m) => ({ role: m.role, content: m.content }));
  let finalText = '';

  for (let i = 0; i < maxIters; i += 1) {
    const turn = await call({
      system,
      tools: [STATS_TOOL],
      messages: convo,
      onDelta: (t) => onEvent({ type: 'text', text: t }),
    });
    const content = turn.content || [];
    convo.push({ role: 'assistant', content });

    const toolUses = content.filter((b) => b.type === 'tool_use');
    finalText = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (!toolUses.length) { onEvent({ type: 'done' }); return finalText; }

    const results = [];
    for (const tu of toolUses) {
      const group = tu.input && tu.input.group;
      onEvent({ type: 'tool', group, input: tu.input });
      const out = await runStats(db, group, tu.input && tu.input.params);
      onEvent({ type: 'tool_result', group });
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(out).slice(0, MAX_TOOL_RESULT),
      });
    }
    convo.push({ role: 'user', content: results });
  }

  onEvent({ type: 'done', capped: true });
  return finalText;
}

module.exports = {
  chat,
  runStats,
  buildSystemPrompt,
  fablePrompt,
  pickModel,
  anthropicStream,
  STATS_TOOL,
  GROUPS,
};
