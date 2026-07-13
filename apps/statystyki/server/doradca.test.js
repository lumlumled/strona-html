// Testy pętli AI-doradcy (tryb głęboki = wiele stats() pod rząd):
//   node --test apps/statystyki/server/doradca.test.js
// Krytyczne: (1) doradca może zrobić KILKA kolejnych wywołań stats() zanim
// odpowie (guardrails §5/§9); (2) bezpiecznik maxIters kończy pętlę; (3) tekst
// leci strumieniowo (onEvent 'text'), a wyniki narzędzia wracają do modelu.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const doradca = require('./doradca');

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
  const finalText = await doradca.chat({
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
  // Trzecia tura widziała tool_result z poprzednich (wynik wrócił do modelu).
  const lastMsgs = seenMessages[2];
  assert.ok(lastMsgs.some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result')));
});

test('chat: bezpiecznik maxIters kończy niekończącą się pętlę tool-use', async () => {
  const callModel = async ({ onDelta }) => {
    onDelta('kręcę się ');
    return { content: [{ type: 'tool_use', id: 'x', name: 'stats', input: { group: 'snapshot' } }], stop_reason: 'tool_use' };
  };
  const events = [];
  await doradca.chat({
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
  const out = await doradca.runStats(emptyDb(), 'nie-ma-takiej');
  assert.ok(out.error && /Nieznana grupa/.test(out.error));
});
