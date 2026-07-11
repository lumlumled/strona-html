// Testy filtra widoczności Bazy Wiedzy — obowiązkowe przed jakimkolwiek UI
// (docs/plan-baza-wiedzy.md, Etap 0): fakt 'owner' NIE może wyciec do 'team'.
//   node --test  (z katalogu apps/shared/server)
// Atrapa emuluje rpc('kb_match_facts') wiernie względem SQL: filtr status +
// visibility = any(allowed) nałożony PRZED zwróceniem czegokolwiek.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// embed() i completeAsk() chodzą po sieci — podmieniamy fetch na atrapę.
const knowledge = require('./knowledge');

function fakeEmbedding() {
  return Array.from({ length: 1536 }, () => 0.01);
}

let lastLlmUser = null;
global.fetch = async (url, opts) => {
  if (String(url).includes('openai.com/v1/embeddings')) {
    return { ok: true, text: async () => JSON.stringify({ data: [{ embedding: fakeEmbedding() }] }) };
  }
  if (String(url).includes('anthropic.com')) {
    const body = JSON.parse(opts.body);
    lastLlmUser = body.messages[0].content;
    return { ok: true, text: async () => JSON.stringify({ content: [{ type: 'text', text: 'odpowiedź testowa' }] }) };
  }
  throw new Error(`Nieoczekiwany fetch w teście: ${url}`);
};
process.env.OPENAI_API_KEY = 'test';
process.env.ANTHROPIC_API_KEY = 'test';

// ── Atrapa Supabase ─────────────────────────────────────────────────────────

function makeFakeDb() {
  const tables = { kb_facts: [], kb_questions: [] };
  let seq = 0;
  const uid = () => `uuid-${(seq += 1)}`;

  return {
    tables,
    async rpc(fn, args) {
      assert.equal(fn, 'kb_match_facts');
      // Wierna kopia semantyki SQL: status='active' AND visibility=any(...)
      const rows = tables.kb_facts
        .filter((f) => f.status === 'active' && args.allowed_visibility.includes(f.visibility) && f.embedding)
        .slice(0, args.match_count)
        .map((f) => ({ id: f.id, title: f.title, content: f.content, tags: f.tags, visibility: f.visibility, similarity: 0.9 }));
      return { data: rows, error: null };
    },
    from(table) {
      const rowsRef = tables[table];
      return {
        insert(row) {
          const inserted = { id: uid(), ...row };
          rowsRef.push(inserted);
          return {
            select: () => Promise.resolve({ data: [inserted], error: null }),
            then: (resolve) => resolve({ data: null, error: null }),
          };
        },
        select() {
          return {
            eq: (col, val) => ({
              limit: () => Promise.resolve({ data: rowsRef.filter((r) => r[col] === val), error: null }),
            }),
          };
        },
        update(patch) {
          return {
            eq: (col, val) => {
              rowsRef.filter((r) => r[col] === val).forEach((r) => Object.assign(r, patch));
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
      };
    },
  };
}

let db;
beforeEach(() => {
  db = makeFakeDb();
  lastLlmUser = null;
  db.tables.kb_facts.push(
    { id: 'f-owner', title: 'Marża na LumControl', content: 'Koszt zakupu 45,56 zł, marża 83,99%', tags: ['marze'], visibility: 'owner', status: 'active', embedding: fakeEmbedding() },
    { id: 'f-team', title: 'Cena LumControl', content: 'Sterownik LumControl kosztuje 350 zł brutto', tags: ['cennik'], visibility: 'team', status: 'active', embedding: fakeEmbedding() },
    { id: 'f-proposed', title: 'Niezatwierdzony fakt', content: 'Czeka na review', tags: [], visibility: 'team', status: 'proposed', embedding: fakeEmbedding() }
  );
});

test('search: rola team NIE widzi faktu owner (marże niewidoczne)', async () => {
  const facts = await knowledge.search(db, { query: 'ile kosztuje LumControl w zakupie?', role: 'team' });
  const ids = facts.map((f) => f.id);
  assert.ok(!ids.includes('f-owner'), 'fakt owner wyciekł do roli team!');
  assert.ok(ids.includes('f-team'));
});

test('search: rola owner widzi fakty owner i team', async () => {
  const facts = await knowledge.search(db, { query: 'marża LumControl', role: 'owner' });
  const ids = facts.map((f) => f.id);
  assert.ok(ids.includes('f-owner'));
  assert.ok(ids.includes('f-team'));
});

test('search: fakty proposed/rejected nie wchodzą do retrievalu', async () => {
  const facts = await knowledge.search(db, { query: 'cokolwiek', role: 'owner' });
  assert.ok(!facts.map((f) => f.id).includes('f-proposed'));
});

test('search: nieznana rola = twardy błąd (nie fallback do owner)', async () => {
  await assert.rejects(() => knowledge.search(db, { query: 'x', role: 'admin' }), /Nieznana rola/);
  await assert.rejects(() => knowledge.search(db, { query: 'x', role: undefined }), /Nieznana rola/);
});

test('ask jako team: treść faktu owner nie trafia do promptu LLM', async () => {
  await knowledge.ask(db, { question: 'jaka jest marża na LumControl?', role: 'team' });
  assert.ok(lastLlmUser, 'LLM powinien dostać prompt (jest fakt team o LumControl)');
  assert.ok(!lastLlmUser.includes('83,99'), 'marża (owner) wyciekła do promptu dla roli team!');
  assert.ok(!lastLlmUser.includes('45,56'), 'koszt zakupu (owner) wyciekł do promptu dla roli team!');
  assert.ok(lastLlmUser.includes('350 zł'), 'fakt team powinien być w prompcie');
});

test('ask bez pasujących faktów: "Nie mam takich informacji." + luka w kb_questions', async () => {
  db.tables.kb_facts.length = 0;
  const res = await knowledge.ask(db, { question: 'czy robicie oświetlenie basenów?', role: 'team' });
  assert.equal(res.answer, knowledge.NO_KNOWLEDGE_ANSWER);
  assert.equal(res.confident, false);
  assert.equal(db.tables.kb_questions.length, 1);
  assert.equal(db.tables.kb_questions[0].answered, false);
});

test('retrieveForPrompt: pusty string bez faktów, blok z faktami w widoczności roli', async () => {
  const teamBlock = await knowledge.retrieveForPrompt(db, { query: 'cena LumControl', role: 'team' });
  assert.ok(teamBlock.includes('350 zł'));
  assert.ok(!teamBlock.includes('83,99'), 'marża w bloku dla team!');
  db.tables.kb_facts.length = 0;
  assert.equal(await knowledge.retrieveForPrompt(db, { query: 'cokolwiek', role: 'team' }), '');
});

test('proposeFact: domyślnie proposed + owner (bezpieczne domyślne)', async () => {
  await knowledge.proposeFact(db, { title: 'T', content: 'C', source: 'extracted' });
  const fact = db.tables.kb_facts.find((f) => f.title === 'T');
  assert.equal(fact.status, 'proposed');
  assert.equal(fact.visibility, 'owner');
  assert.ok(Array.isArray(fact.embedding));
});
