// Testy sugestii z Bazą Wiedzy (Etap 2 planu Bazy Wiedzy):
//   node --test  (z katalogu apps/komunikator/server)
// Krytyczne: (1) fakty trafiają do promptu WYŁĄCZNIE w widoczności 'team' —
// marże/koszty (owner) nie mogą wyciec do sugestii, którą czyta Lorenzo
// i dostaje klient; (2) awaria KB/przykładów nie wywraca sugestii.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

let lastAnthropicBody = null;
global.fetch = async (url, opts) => {
  if (String(url).includes('openai.com/v1/embeddings')) {
    return { ok: true, text: async () => JSON.stringify({ data: [{ embedding: Array(1536).fill(0.01) }] }) };
  }
  if (String(url).includes('anthropic.com')) {
    lastAnthropicBody = JSON.parse(opts.body);
    return { ok: true, text: async () => JSON.stringify({ content: [{ type: 'text', text: 'Sugestia testowa' }] }) };
  }
  throw new Error(`Nieoczekiwany fetch: ${url}`);
};
process.env.OPENAI_API_KEY = 'test';
process.env.ANTHROPIC_API_KEY = 'test';

const suggest = require('./suggest');

const FACTS = [
  { title: 'Cena LumControl', content: 'Sterownik LumControl kosztuje 350 zł brutto', visibility: 'team' },
  { title: 'Marża LumControl', content: 'koszt zakupu 45,56 zł, marża 83,99%', visibility: 'owner' },
];

function makeFakeDb({ kbError = false, examplesRpcError = false } = {}) {
  const db = {
    rpcCalls: [],
    suggestions: [],
    async rpc(fn, args) {
      db.rpcCalls.push({ fn, args });
      if (fn === 'kom_match_examples') {
        if (examplesRpcError) return { data: null, error: { message: 'brak funkcji' } };
        return { data: [{ context: 'ile kosztuje sterownik?', final: 'Sterownik to 350 zł 😊' }], error: null };
      }
      if (fn === 'kb_match_facts') {
        if (kbError) return { data: null, error: { message: 'awaria kb' } };
        const rows = FACTS.filter((f) => args.allowed_visibility.includes(f.visibility)).map((f) => ({
          id: 'f1', title: f.title, content: f.content, tags: [], visibility: f.visibility, similarity: 0.9,
        }));
        return { data: rows, error: null };
      }
      return { data: null, error: { message: `nieznane rpc ${fn}` } };
    },
    from(table) {
      if (table === 'kom_examples') {
        return {
          select: () => ({
            order: () => ({
              limit: async () => ({ data: [{ context: 'fallback', final: 'Odpowiedź fallback' }], error: null }),
            }),
          }),
        };
      }
      if (table === 'kom_suggestions') {
        return {
          insert(row) {
            db.suggestions.push(row);
            return { select: async () => ({ data: [{ id: 'sug-1' }], error: null }) };
          },
        };
      }
      throw new Error(`nieznana tabela ${table}`);
    },
  };
  return db;
}

const thread = { id: 't1', channel: 'messenger' };
const customer = { display_name: 'Jan', public_id: 'LL-00001', identities: [] };
const messages = [
  { direction: 'in', body: 'Dzień dobry, ile kosztuje sterownik LumControl?' },
];

beforeEach(() => { lastAnthropicBody = null; });

test('fakty team trafiają do promptu, fakty owner NIGDY', async () => {
  const db = makeFakeDb();
  const res = await suggest.generateSuggestion(db, thread, customer, messages);
  assert.equal(res.text, 'Sugestia testowa');
  const prompt = lastAnthropicBody.messages[0].content;
  assert.ok(prompt.includes('350 zł brutto'), 'fakt team powinien być w prompcie');
  assert.ok(!prompt.includes('83,99'), 'marża (owner) wyciekła do promptu sugestii!');
  assert.ok(!prompt.includes('45,56'), 'koszt zakupu (owner) wyciekł do promptu sugestii!');
  const kbCall = db.rpcCalls.find((c) => c.fn === 'kb_match_facts');
  assert.ok(kbCall, 'retrieval KB powinien być wywołany');
  assert.ok(!kbCall.args.allowed_visibility.includes('owner'), 'sugestia zapytała o fakty owner!');
});

test('przykłady stylu dobierane wektorowo trafiają do promptu', async () => {
  const db = makeFakeDb();
  await suggest.generateSuggestion(db, thread, customer, messages);
  const prompt = lastAnthropicBody.messages[0].content;
  assert.ok(prompt.includes('Sterownik to 350 zł 😊'), 'przykład z kom_match_examples powinien być w prompcie');
});

test('awaria KB nie wywraca sugestii (degradacja do promptu bez faktów)', async () => {
  const db = makeFakeDb({ kbError: true });
  const res = await suggest.generateSuggestion(db, thread, customer, messages);
  assert.equal(res.text, 'Sugestia testowa');
  const prompt = lastAnthropicBody.messages[0].content;
  assert.ok(!prompt.includes('Fakty z bazy wiedzy'), 'blok faktów nie powinien powstać przy awarii');
});

test('brak funkcji kom_match_examples → fallback na najnowsze przykłady', async () => {
  const db = makeFakeDb({ examplesRpcError: true });
  await suggest.generateSuggestion(db, thread, customer, messages);
  const prompt = lastAnthropicBody.messages[0].content;
  assert.ok(prompt.includes('Odpowiedź fallback'), 'fallback z kom_examples powinien wejść do promptu');
});

test('sugestia zapisuje się z nową wersją promptu', async () => {
  const db = makeFakeDb();
  await suggest.generateSuggestion(db, thread, customer, messages);
  assert.equal(db.suggestions[0].prompt_version, suggest.PROMPT_VERSION);
  assert.equal(suggest.PROMPT_VERSION, 'suggest-v2-kb');
});
