// Testy modułu tożsamości na atrapie Supabase w pamięci (bez sieci):
//   node --test  (z katalogu apps/komunikator/server)
// Atrapa emuluje dokładnie te kawałki API supabase-js, których używa
// identity.js, w tym unikalność (type,value) i (channel,external_thread_id).
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const identity = require('./identity');

// ── Atrapa Supabase ─────────────────────────────────────────────────────────

function makeFakeDb() {
  const tables = {
    kom_customers: [],
    kom_customer_identities: [],
    kom_threads: [],
    kom_memory: [],
    kom_commitments: [],
    kom_merge_proposals: [],
  };
  let seq = 10000;
  const uid = () => `uuid-${(seq += 1)}`;

  function uniqueViolation(table, row) {
    if (table === 'kom_customer_identities') {
      return tables[table].some((r) => r.type === row.type && r.value === row.value);
    }
    if (table === 'kom_threads') {
      return tables[table].some(
        (r) => r.channel === row.channel && r.external_thread_id === row.external_thread_id
      );
    }
    return false;
  }

  function builder(table) {
    const state = { op: 'select', filters: [], rows: null, limit: null };
    const api = {
      select() { if (state.op === 'select') state.op = 'select'; return api; },
      insert(rows) {
        state.op = 'insert';
        state.rows = Array.isArray(rows) ? rows : [rows];
        return api;
      },
      update(patch) { state.op = 'update'; state.patch = patch; return api; },
      eq(col, val) { state.filters.push([col, val]); return api; },
      limit(n) { state.limit = n; return api; },
      then(resolve, reject) {
        try { resolve(run()); } catch (e) { reject(e); }
      },
    };
    function matches(row) {
      return state.filters.every(([col, val]) => String(row[col]) === String(val));
    }
    function run() {
      if (state.op === 'insert') {
        const inserted = [];
        for (const row of state.rows) {
          if (uniqueViolation(table, row)) {
            return { data: null, error: { message: 'duplicate key value violates unique constraint' } };
          }
          // Odwzoruj defaulty kolumn z migracji — kod produkcyjny na nich polega.
          const defaults = {};
          if (table === 'kom_merge_proposals') defaults.status = 'pending';
          if (table === 'kom_threads') defaults.status = 'attention';
          const full = { id: uid(), created_at: new Date().toISOString(), merged_into: null, ...defaults, ...row };
          if (table === 'kom_customers') full.public_id = `LL-${(seq += 1)}`;
          tables[table].push(full);
          inserted.push(full);
        }
        return { data: inserted, error: null };
      }
      if (state.op === 'update') {
        const updated = [];
        for (const row of tables[table]) {
          if (matches(row)) { Object.assign(row, state.patch); updated.push(row); }
        }
        return { data: updated, error: null };
      }
      let rows = tables[table].filter(matches);
      if (state.limit) rows = rows.slice(0, state.limit);
      return { data: rows, error: null };
    }
    return api;
  }

  return { from: builder, _tables: tables };
}

let db;
beforeEach(() => { db = makeFakeDb(); });

// ── normalize ───────────────────────────────────────────────────────────────

test('normalize: telefon do samych cyfr z prefiksem 48', () => {
  assert.equal(identity.normalize('phone', '604 650 590'), '48604650590');
  assert.equal(identity.normalize('phone', '+48 604-650-590'), '48604650590');
  assert.equal(identity.normalize('phone', '0048604650590'), '48604650590');
  assert.equal(identity.normalize('phone', '48604650590'), '48604650590');
});

test('normalize: email lowercase, fb surowe ID', () => {
  assert.equal(identity.normalize('email', ' Jan.K@GMAIL.com '), 'jan.k@gmail.com');
  assert.equal(identity.normalize('fb', '1234567890'), '1234567890');
});

test('extractContacts: mail z treści rozmowy', () => {
  const r = identity.extractContacts('chyba cyfrowej, mój mail to antoni.chodurski@gmail.com Czy sterownik?');
  assert.deepEqual(r.emails, ['antoni.chodurski@gmail.com']);
  assert.deepEqual(r.phones, []);
});

test('extractContacts: telefon z sygnałem albo formatem grupowanym → 48XXXXXXXXX', () => {
  assert.deepEqual(identity.extractContacts('mój numer 604 650 590').phones, ['48604650590']);
  assert.deepEqual(identity.extractContacts('tel: 604-650-590').phones, ['48604650590']);
  assert.deepEqual(identity.extractContacts('+48 513 141 389').phones, ['48513141389']);
  assert.deepEqual(identity.extractContacts('telefon 513141389').phones, ['48513141389']);
});

test('extractContacts: NIE łapie numeru zamówienia/ilości jako telefonu', () => {
  assert.deepEqual(identity.extractContacts('zamówienie nr 123456789 w toku').phones, []);
  assert.deepEqual(identity.extractContacts('numer zamówienia 123456789').phones, []);
  assert.deepEqual(identity.extractContacts('kupię 20m taśmy za 750zł').phones, []);
  assert.deepEqual(identity.extractContacts('hej chciałbym kupić 10m').phones, []);
});

// ── resolveCustomer ─────────────────────────────────────────────────────────

test('pierwsze zdarzenie tworzy klienta LL- z jedną tożsamością', async () => {
  const { customer, created } = await identity.resolveCustomer(db, {
    type: 'fb', value: 'fb-111', displayName: 'Krzysiek',
  });
  assert.equal(created, true);
  assert.match(customer.public_id, /^LL-\d+$/);
  assert.equal(db._tables.kom_customer_identities.length, 1);
  assert.equal(db._tables.kom_customer_identities[0].value, 'fb-111');
});

test('drugie zdarzenie z tym samym ID trafia do tego samego klienta', async () => {
  const first = await identity.resolveCustomer(db, { type: 'fb', value: 'fb-111' });
  const second = await identity.resolveCustomer(db, { type: 'fb', value: 'fb-111' });
  assert.equal(second.created, false);
  assert.equal(second.customer.id, first.customer.id);
  assert.equal(db._tables.kom_customers.length, 1);
});

test('różne zapisy tego samego telefonu = jeden klient', async () => {
  const a = await identity.resolveCustomer(db, { type: 'phone', value: '604 650 590' });
  const b = await identity.resolveCustomer(db, { type: 'phone', value: '+48604650590' });
  assert.equal(b.customer.id, a.customer.id);
});

// ── enrichCustomer ──────────────────────────────────────────────────────────

test('enrich dopina wolny identyfikator (drugi kanał tego samego klienta)', async () => {
  const { customer } = await identity.resolveCustomer(db, { type: 'fb', value: 'fb-111' });
  const result = await identity.enrichCustomer(db, customer.id, { type: 'phone', value: '604650590' });
  assert.equal(result.status, 'added');
  // Telefon prowadzi teraz do tego samego klienta:
  const byPhone = await identity.resolveCustomer(db, { type: 'phone', value: '604650590' });
  assert.equal(byPhone.created, false);
  assert.equal(byPhone.customer.id, customer.id);
});

test('enrich własnym identyfikatorem = already_own', async () => {
  const { customer } = await identity.resolveCustomer(db, { type: 'fb', value: 'fb-111' });
  const result = await identity.enrichCustomer(db, customer.id, { type: 'fb', value: 'fb-111' });
  assert.equal(result.status, 'already_own');
});

test('BEZPIECZNIK: identyfikator innego klienta = conflict, zero scalania', async () => {
  const a = await identity.resolveCustomer(db, { type: 'fb', value: 'fb-111' });
  const b = await identity.resolveCustomer(db, { type: 'phone', value: '604650590' });
  const result = await identity.enrichCustomer(db, a.customer.id, { type: 'phone', value: '604650590' });
  assert.equal(result.status, 'conflict');
  assert.equal(result.otherCustomer.id, b.customer.id);
  assert.equal(db._tables.kom_customers.length, 2); // nikt nikogo nie scalił
});

// ── attachThread ────────────────────────────────────────────────────────────

test('attachThread: idempotentny po (channel, external_thread_id)', async () => {
  const { customer } = await identity.resolveCustomer(db, { type: 'fb', value: 'fb-111' });
  const t1 = await identity.attachThread(db, customer, 'messenger', 'fb-111');
  const t2 = await identity.attachThread(db, customer, 'messenger', 'fb-111');
  assert.equal(t1.created, true);
  assert.equal(t2.created, false);
  assert.equal(t2.thread.id, t1.thread.id);
});

// ── merge: propose / confirm / reject ───────────────────────────────────────

test('confirmMerge przepina wątki i tożsamości, przegrany dostaje merged_into', async () => {
  const fbGuy = await identity.resolveCustomer(db, { type: 'fb', value: 'fb-111' });
  const phoneGuy = await identity.resolveCustomer(db, { type: 'phone', value: '604650590' });
  const { thread } = await identity.attachThread(db, phoneGuy.customer, 'phone', '48604650590');

  const proposal = await identity.proposeMerge(db, {
    threadId: thread.id,
    candidateId: fbGuy.customer.id,
    reason: 'ai_probable_match',
    evidence: { claim: 'pisałem o schodach na Facebooku' },
    confidence: 0.8,
  });

  const winner = await identity.confirmMerge(db, proposal.id);
  assert.equal(winner.id, fbGuy.customer.id);

  // Wątek telefoniczny należy teraz do zwycięzcy:
  assert.equal(db._tables.kom_threads[0].customer_id, fbGuy.customer.id);
  // Telefon prowadzi do zwycięzcy (przez merged_into):
  const byPhone = await identity.resolveCustomer(db, { type: 'phone', value: '604650590' });
  assert.equal(byPhone.customer.id, fbGuy.customer.id);
  // Przegrany oznaczony:
  const loserRow = db._tables.kom_customers.find((c) => c.id === phoneGuy.customer.id);
  assert.equal(loserRow.merged_into, fbGuy.customer.id);
});

test('proposeMerge nie duplikuje wiszącej propozycji', async () => {
  const a = await identity.resolveCustomer(db, { type: 'fb', value: 'fb-111' });
  const b = await identity.resolveCustomer(db, { type: 'phone', value: '604650590' });
  const { thread } = await identity.attachThread(db, b.customer, 'phone', '48604650590');
  const p1 = await identity.proposeMerge(db, { threadId: thread.id, candidateId: a.customer.id, reason: 'x', evidence: {} });
  const p2 = await identity.proposeMerge(db, { threadId: thread.id, candidateId: a.customer.id, reason: 'x', evidence: {} });
  assert.equal(p2.id, p1.id);
  assert.equal(db._tables.kom_merge_proposals.length, 1);
});

test('rejectMerge zostawia klientów nietkniętych', async () => {
  const a = await identity.resolveCustomer(db, { type: 'fb', value: 'fb-111' });
  const b = await identity.resolveCustomer(db, { type: 'phone', value: '604650590' });
  const { thread } = await identity.attachThread(db, b.customer, 'phone', '48604650590');
  const p = await identity.proposeMerge(db, { threadId: thread.id, candidateId: a.customer.id, reason: 'x', evidence: {} });
  await identity.rejectMerge(db, p.id);
  assert.equal(db._tables.kom_merge_proposals[0].status, 'rejected');
  assert.equal(db._tables.kom_customers.filter((c) => !c.merged_into).length, 2);
});
