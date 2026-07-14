// Testy pętli AI-doradcy (tryb głęboki = wiele stats() pod rząd):
//   node --test apps/doradca/server/fable.test.js
// Krytyczne: (1) doradca może zrobić KILKA kolejnych wywołań stats() zanim
// odpowie (guardrails §5/§9); (2) bezpiecznik maxIters kończy pętlę; (3) tekst
// leci strumieniowo (onEvent 'text'), a wyniki narzędzia wracają do modelu.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fable = require('./fable');

// Pusty mock db — Q.snapshot() zbuduje się na zerach (bez rzucania).
function emptyDb() {
  return {
    from() {
      const b = {
        select() { return b; },
        eq() { return b; },
        neq() { return b; },
        ilike() { return b; },
        then(resolve) { resolve({ data: [], error: null }); },
      };
      return b;
    },
  };
}

test('chat: wiele kolejnych stats() zanim doradca odpowie (deep mode)', async () => {
  const script = [
    { text: 'Sprawdzę pipeline. ', tool: { id: 't1', name: 'stats', input: { group: 'pipeline' } } },
    { text: 'I outreach. ', tool: { id: 't2', name: 'stats', input: { group: 'outreach' } } },
    { text: 'Następny ruch: zadzwoń do 5 martwych wycen — do 12:00.', tool: null },
  ];
  let turn = 0;
  const seenMessages = [];
  const callModel = async ({ messages, onDelta }) => {
    seenMessages.push(JSON.parse(JSON.stringify(messages)));
    const s = script[turn++];
    if (s.text) onDelta(s.text);
    const content = [];
    if (s.text) content.push({ type: 'text', text: s.text });
    if (s.tool) content.push({ type: 'tool_use', ...s.tool });
    return { content, stop_reason: s.tool ? 'tool_use' : 'end_turn' };
  };

  const events = [];
  const finalText = await fable.chat({
    db: emptyDb(),
    messages: [{ role: 'user', content: 'co dziś?' }],
    onEvent: (e) => events.push(e),
    callModel,
  });

  const tools = events.filter((e) => e.type === 'tool').map((e) => e.group);
  assert.deepEqual(tools, ['pipeline', 'outreach'], 'dwa kolejne wywołania stats()');
  assert.equal(events.filter((e) => e.type === 'tool_result').length, 2);
  assert.ok(events.some((e) => e.type === 'text'), 'tekst streamowany');
  const done = events.find((e) => e.type === 'done');
  assert.ok(done && !done.capped, 'zakończone naturalnie, nie limitem');
  assert.match(finalText, /Następny ruch/);
  const lastMsgs = seenMessages[2];
  assert.ok(lastMsgs.some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result')));
});

test('chat: memoryText trafia do system promptu (uczenie)', async () => {
  let seenSystem = '';
  const callModel = async ({ system, onDelta }) => {
    seenSystem = system;
    onDelta('ok');
    return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
  };
  await fable.chat({
    db: emptyDb(),
    messages: [{ role: 'user', content: 'hej' }],
    memoryText: '**Wiedza / preferencje:**\n- Antoni nie chce podnosić cen',
    onEvent: () => {},
    callModel,
  });
  assert.match(seenSystem, /PAMIĘĆ DORADCY/);
  assert.match(seenSystem, /nie chce podnosić cen/);
});

test('chat: bezpiecznik maxIters kończy niekończącą się pętlę tool-use', async () => {
  const callModel = async ({ onDelta }) => {
    onDelta('kręcę się ');
    return { content: [{ type: 'tool_use', id: 'x', name: 'stats', input: { group: 'snapshot' } }], stop_reason: 'tool_use' };
  };
  const events = [];
  await fable.chat({
    db: emptyDb(),
    messages: [{ role: 'user', content: 'test' }],
    onEvent: (e) => events.push(e),
    callModel,
    maxIters: 3,
  });
  assert.equal(events.filter((e) => e.type === 'tool').length, 3, 'dokładnie maxIters wywołań');
  const done = events.find((e) => e.type === 'done');
  assert.ok(done && done.capped === true, 'zakończone limitem');
});

test('runStats: nieznana grupa zwraca błąd zamiast rzucać', async () => {
  const out = await fable.runStats(emptyDb(), 'nie-ma-takiej');
  assert.ok(out.error && /Nieznana grupa/.test(out.error));
});

test('pickModel: wybór z UI (whitelist) ma pierwszeństwo, nieznany klucz → default', () => {
  assert.equal(fable.pickModel(false, 'opus-4-8').model, 'claude-opus-4-8', 'opus z UI');
  assert.equal(fable.pickModel(false, 'haiku-4-5').model, 'claude-haiku-4-5-20251001', 'haiku z UI');
  assert.equal(fable.pickModel(false, 'nie-ma').model, 'claude-fable-5', 'nieznany klucz → fable-5');
  assert.equal(fable.pickModel(false, '').model, 'claude-fable-5', 'brak klucza → fable-5');
});

test('buildSystemPrompt: dodatkowy kontekst wstrzykiwany tylko gdy niepusty', () => {
  const withCtx = fable.buildSystemPrompt({}, '', 'MOJE MARŻE: COB 74%');
  assert.match(withCtx, /DODATKOWY KONTEKST OD ANTONIEGO/);
  assert.match(withCtx, /COB 74%/);
  const noCtx = fable.buildSystemPrompt({}, '', '');
  assert.ok(!/DODATKOWY KONTEKST/.test(noCtx), 'brak sekcji gdy kontekst pusty');
});
