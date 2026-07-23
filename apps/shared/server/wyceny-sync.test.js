// Testy domykania wycen straconego klienta (decyzja Antoniego 2026-07-23,
// lead 467 Kamil): odmowa klienta ma zamykać jego OTWARTĄ WYCENĘ, ale nie może
// tknąć zamówienia ani płatności w toku.
//   node --test  (z katalogu apps/shared/server)
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { zamknijWycenyStraconego } = require('./wyceny-sync');

// Atrapa Supabase wierna użytemu API, rozdzielona PER TABELA — domykanie
// wyceny dotyka dwóch: 'wyceny' (status) i 'feedback_watch' (resolveWatch,
// żeby alert "temat ucieka" nie wrócił drugimi drzwiami).
function fakeSupabase({ rows = [], selectError = null, updateError = null } = {}) {
  const calls = { filters: {}, or: null, updated: null, updateIds: null, watchResolved: [] };
  return {
    calls,
    from(table) {
      if (table === 'feedback_watch') {
        const w = { patch: null, eqs: {} };
        const q = {
          update(patch) { w.patch = patch; return q; },
          eq(col, val) { w.eqs[col] = val; return q; },
          is() { return q; },
          select() { calls.watchResolved.push(w); return Promise.resolve({ data: [{ id: 1 }], error: null }); },
        };
        return q;
      }
      const q = {
        select() { return q; },
        eq(col, val) { calls.filters[col] = val; return q; },
        or(expr) { calls.or = expr; return Promise.resolve({ data: rows, error: selectError }); },
        update(patch) { calls.updated = patch; return q; },
        in(_col, ids) { calls.updateIds = ids; return Promise.resolve({ error: updateError }); },
      };
      return q;
    },
  };
}

test('domyka tylko otwarte wyceny, nigdy zamówień ani płatności w toku', async () => {
  const sb = fakeSupabase({ rows: [{ id: 1974 }] });
  const res = await zamknijWycenyStraconego(sb, { leadId: 467, telefon: '48518337069' });

  assert.deepEqual(res, { ids: [1974], error: null });
  assert.equal(sb.calls.filters.typ, 'WYCENA');       // nie ZAMÓWIENIE
  assert.equal(sb.calls.filters.status, 'Open');       // nie Waiting for payment
  assert.deepEqual(sb.calls.updated, { status: 'Stracone' });
  assert.deepEqual(sb.calls.updateIds, [1974]);        // update po id, nie po filtrze
});

test('zamyka też watcha wyceny — inaczej alert "temat ucieka" wraca do planu', async () => {
  const sb = fakeSupabase({ rows: [{ id: 1974 }] });
  await zamknijWycenyStraconego(sb, { leadId: 467, telefon: '518337069' });

  assert.equal(sb.calls.watchResolved.length, 1);
  const w = sb.calls.watchResolved[0];
  assert.equal(w.patch.resolution, 'cancelled');
  assert.ok(w.patch.resolved_at, 'watch dostaje resolved_at');
  assert.equal(w.eqs.object_type, 'wycena');
  assert.equal(w.eqs.object_id, '1974');
});

test('dopasowuje po lead_id ORAZ po telefonie bez prefiksu 48', async () => {
  const sb = fakeSupabase({ rows: [] });
  await zamknijWycenyStraconego(sb, { leadId: 467, telefon: '48518337069' });
  // Konwencja tabeli `wyceny`: telefon_digits to 9 cyfr bez 48.
  assert.equal(sb.calls.or, 'lead_id.eq.467,telefon_digits.eq.518337069');
});

test('sam telefon wystarcza — wyceny-sieroty nie mają lead_id', async () => {
  const sb = fakeSupabase({ rows: [{ id: 5 }] });
  await zamknijWycenyStraconego(sb, { leadId: null, telefon: '518337069' });
  assert.equal(sb.calls.or, 'telefon_digits.eq.518337069');
});

test('brak wycen do domknięcia to nie błąd', async () => {
  const sb = fakeSupabase({ rows: [] });
  const res = await zamknijWycenyStraconego(sb, { leadId: 1, telefon: '500100200' });
  assert.deepEqual(res, { ids: [], error: null });
  assert.equal(sb.calls.updated, null); // żadnego zapisu
});

test('bez leadId i bez telefonu nie rusza niczego', async () => {
  const sb = fakeSupabase({ rows: [{ id: 9 }] });
  const res = await zamknijWycenyStraconego(sb, {});
  assert.deepEqual(res, { ids: [], error: null });
  assert.equal(sb.calls.or, null);
});

test('błąd bazy nie wywraca operacji nadrzędnej (rozmowy/edycji leada)', async () => {
  const sb = fakeSupabase({ rows: [{ id: 1 }], updateError: { message: 'timeout' } });
  const res = await zamknijWycenyStraconego(sb, { leadId: 467, telefon: '518337069' });
  assert.deepEqual(res.ids, []);
  assert.equal(res.error, 'timeout');
});
