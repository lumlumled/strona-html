// Testy auto-domknięcia feedbacku po próbie kontaktu w dniu terminu
// (sweepDotrzymaneDzis — reguła 5 panelu Test przeniesiona na feedback_watch:
// telefon z numerem w DNIU terminu = obietnica dotrzymana, watch się odhacza).
//   node --test  (z katalogu apps/shared/server)
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { sweepDotrzymaneDzis } = require('./watchdog-dispatcher');

// Sweep liczy "dziś" z realnego zegara (doba warszawska), więc fixtury żyją
// w sekundowych odstępach wokół teraz — wszystkie na pewno w tej samej dobie.
const S = 1000;
const H = 3600 * 1000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// Atrapa Supabase wierna użytym łańcuchom: lista watchy (select→is→eq,
// thenable), resolveWatch (update→eq→eq→is→select), lookupy leadów/wycen
// (select→in) i Log zmian (select→not→gte).
function fakeSupabase({ watches = [], leady = [], wyceny = [], logs = [] } = {}) {
  const calls = { resolved: [], watchEqs: [], logNot: null };
  return {
    calls,
    from(table) {
      if (table === 'feedback_watch') {
        const q = {
          _update: null, _eqs: [],
          select() {
            if (q._update) {
              calls.resolved.push({ patch: q._update, eqs: Object.fromEntries(q._eqs) });
              return Promise.resolve({ data: [{ id: 1 }], error: null });
            }
            return q;
          },
          update(patch) { q._update = patch; return q; },
          is() { return q; },
          eq(col, val) { q._eqs.push([col, val]); if (!q._update) calls.watchEqs.push([col, val]); return q; },
          then(res, rej) { return Promise.resolve({ data: watches, error: null }).then(res, rej); },
        };
        return q;
      }
      if (table === 'Leady B2C') {
        return { select() { return this; }, in() { return Promise.resolve({ data: leady, error: null }); } };
      }
      if (table === 'wyceny') {
        return { select() { return this; }, in() { return Promise.resolve({ data: wyceny, error: null }); } };
      }
      if (table === 'Log zmian') {
        return {
          select() { return this; },
          not(col, op, val) { calls.logNot = [col, op, val]; return this; },
          gte() { return Promise.resolve({ data: logs, error: null }); },
        };
      }
      throw new Error(`nieznana tabela: ${table}`);
    },
  };
}

function raport() { return { armed: 0, alerted: 0, resolved_activity: 0, resolved_obietnica: 0, resolved_closed: 0, errors: [] }; }

const WATCH_LEAD = {
  id: 10, object_type: 'lead', object_id: '400', visible: true,
  due_at: iso(NOW), baseline_at: iso(NOW - 2 * S), resolved_at: null,
};

test('telefon w dniu terminu domyka watch leada (resolution: activity)', async () => {
  const sb = fakeSupabase({
    watches: [WATCH_LEAD],
    // "ID Leada" bywa numericiem '400.0' — kanonizacja przez leadObjectId.
    leady: [{ 'ID Leada': 400.0, 'Phone number': 48501043583 }],
    logs: [{ telefon: '48501043583', data_zmiany: iso(NOW - S) }],
  });
  const r = raport();
  await sweepDotrzymaneDzis(sb, r);
  assert.equal(r.resolved_obietnica, 1);
  assert.deepEqual(r.errors, []);
  const w = sb.calls.resolved[0];
  assert.equal(w.patch.resolution, 'activity');
  assert.ok(w.patch.resolved_at);
  assert.equal(w.eqs.object_type, 'lead');
  assert.equal(w.eqs.object_id, '400');
});

test('rozmowa sprzed baseline (ta, która umówiła termin) NIE domyka', async () => {
  const sb = fakeSupabase({
    watches: [WATCH_LEAD],
    leady: [{ 'ID Leada': 400, 'Phone number': 48501043583 }],
    logs: [{ telefon: '48501043583', data_zmiany: iso(NOW - 3 * S) }], // przed baseline
  });
  const r = raport();
  await sweepDotrzymaneDzis(sb, r);
  assert.equal(r.resolved_obietnica, 0);
  assert.equal(sb.calls.resolved.length, 0);
});

test('watch z terminem na inny dzień jest nietykany', async () => {
  const sb = fakeSupabase({
    watches: [{ ...WATCH_LEAD, due_at: iso(NOW + 30 * H) }],
    leady: [{ 'ID Leada': 400, 'Phone number': 48501043583 }],
    logs: [{ telefon: '48501043583', data_zmiany: iso(NOW - S) }],
  });
  const r = raport();
  await sweepDotrzymaneDzis(sb, r);
  assert.equal(r.resolved_obietnica, 0);
  assert.equal(sb.calls.resolved.length, 0);
});

test('watch wyceny domykany po telefon_digits (9 cyfr vs 48 w Logu)', async () => {
  const sb = fakeSupabase({
    watches: [{ ...WATCH_LEAD, id: 11, object_type: 'wycena', object_id: '1764' }],
    wyceny: [{ id: 1764, telefon_digits: '511528138', telefon_e164: '48511528138' }],
    logs: [{ telefon: '48511528138', data_zmiany: iso(NOW - S) }],
  });
  const r = raport();
  await sweepDotrzymaneDzis(sb, r);
  assert.equal(r.resolved_obietnica, 1);
  assert.equal(sb.calls.resolved[0].eqs.object_type, 'wycena');
  assert.equal(sb.calls.resolved[0].eqs.object_id, '1764');
});

test('telefon do INNEGO numeru nie domyka niczego', async () => {
  const sb = fakeSupabase({
    watches: [WATCH_LEAD],
    leady: [{ 'ID Leada': 400, 'Phone number': 48501043583 }],
    logs: [{ telefon: '48999888777', data_zmiany: iso(NOW - S) }],
  });
  const r = raport();
  await sweepDotrzymaneDzis(sb, r);
  assert.equal(r.resolved_obietnica, 0);
});

test('bierze tylko jawne terminy i wiersze Logu z kierunkiem (połączenia)', async () => {
  const sb = fakeSupabase({
    watches: [WATCH_LEAD],
    leady: [{ 'ID Leada': 400, 'Phone number': 48501043583 }],
    logs: [{ telefon: '48501043583', data_zmiany: iso(NOW - S) }],
  });
  await sweepDotrzymaneDzis(sb, raport());
  // Zapytanie o watche filtruje visible=true (ciche watche AI zostawiamy
  // istniejącej ścieżce 'activity'), a Log zmian po kierunek != null.
  assert.deepEqual(sb.calls.watchEqs, [['visible', true]]);
  assert.deepEqual(sb.calls.logNot, ['kierunek', 'is', null]);
});

test('błąd bazy ląduje w raporcie, nie wywraca sweepa', async () => {
  const sb = {
    from() { return { select() { return this; }, is() { return this; }, eq() { return this; }, then(res) { return Promise.resolve({ data: null, error: { message: 'timeout' } }).then(res); } }; },
  };
  const r = raport();
  await sweepDotrzymaneDzis(sb, r);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /obietnice-dzis: /);
});
