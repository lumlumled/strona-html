// Testy domykania wycen straconego klienta (decyzja Antoniego 2026-07-23,
// lead 467 Kamil): odmowa klienta ma zamykać jego OTWARTĄ WYCENĘ, ale nie może
// tknąć zamówienia ani płatności w toku.
//   node --test  (z katalogu apps/shared/server)
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { zamknijWycenyStraconego, stracLeadaPoWycenie } = require('./wyceny-sync');

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

test('powód straty wędruje na wycenę razem ze statusem', async () => {
  const sb = fakeSupabase({ rows: [{ id: 1974 }] });
  await zamknijWycenyStraconego(sb, { leadId: 467, telefon: '518337069', powod: 'Nierokujący - buja mnie' });
  assert.deepEqual(sb.calls.updated, { status: 'Stracone', powod_straty: 'Nierokujący - buja mnie' });
});

test('brak powodu nie nadpisuje kolumny pustką', async () => {
  const sb = fakeSupabase({ rows: [{ id: 1974 }] });
  // Automat z rozmowy bywa bez powodu (AI nic nie wyłapała) — wtedy wycena
  // dostaje sam status, a wcześniejszy powód (jeśli był) zostaje.
  await zamknijWycenyStraconego(sb, { leadId: 467, telefon: '518337069', powod: null });
  assert.deepEqual(sb.calls.updated, { status: 'Stracone' });
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

// ── Kierunek odwrotny: wycena "Stracone" → lead "Stracony" ──────────────────
// Atrapa dla stracLeadaPoWycenie: lead czytany z "Leady B2C", zapis idzie RPC
// app_lead_stracony (migracja 013), a ślad decyzji do "Log zmian".
function fakeSupabaseLead({ lead = null, leadByPhone = null } = {}) {
  const calls = { rpc: null, log: null, phoneQuery: null, idQuery: null };
  return {
    calls,
    rpc(name, params) { calls.rpc = { name, params }; return Promise.resolve({ error: null }); },
    from(table) {
      if (table === 'Log zmian') {
        return { insert(row) { calls.log = row; return Promise.resolve({ error: null }); } };
      }
      const q = {
        _col: null,
        select() { return q; },
        eq(col, val) { q._col = col; if (col === 'Phone number') calls.phoneQuery = val; else calls.idQuery = val; return q; },
        limit() {
          const wynik = q._col === 'Phone number' ? leadByPhone : lead;
          return Promise.resolve({ data: wynik ? [wynik] : [], error: null });
        },
      };
      return q;
    },
  };
}

const LEAD = { 'ID Leada': 467, ID: 'L467', 'Deal stage': 'Wycena wysłana', 'Historia rozmów': 'stary wpis' };

test('wycena stracona domyka leada tym samym RPC co ręczne domknięcie', async () => {
  const sb = fakeSupabaseLead({ lead: LEAD });
  const res = await stracLeadaPoWycenie(sb, { id: 1974, lead_id: 467, telefon_digits: '518337069' }, {
    powod: 'Za drogo, ma ofertę 3300', handlowiec: 'Lorenzo',
  });

  assert.deepEqual(res, { leadId: 467, statusPrzed: 'Wycena wysłana', telefon: '48518337069' });
  assert.equal(sb.calls.rpc.name, 'app_lead_stracony');
  assert.equal(sb.calls.rpc.params.p_id_leada, 467);
  assert.equal(sb.calls.rpc.params.p_powod, 'Za drogo, ma ofertę 3300');
  // Nowy wpis na GÓRZE historii, stary zachowany.
  assert.match(sb.calls.rpc.params.p_historia, /\[Stracony\] Za drogo, ma ofertę 3300\nstary wpis$/);
  assert.equal(sb.calls.log.zrodlo, 'wycena_stracona');
  assert.equal(sb.calls.log.status_przed, 'Wycena wysłana');
  assert.equal(sb.calls.log.status_po, 'Stracony');
});

test('lead znajdowany po telefonie, gdy wycena nie ma lead_id (sierota)', async () => {
  const sb = fakeSupabaseLead({ leadByPhone: LEAD });
  const res = await stracLeadaPoWycenie(sb, { id: 1974, lead_id: null, telefon_digits: '518337069' }, {});
  assert.equal(res.leadId, 467);
  // Leady B2C trzyma numer z prefiksem 48 jako liczbę.
  assert.equal(sb.calls.phoneQuery, 48518337069);
});

test('sprzedanego leada nie cofa strata wyceny', async () => {
  const sb = fakeSupabaseLead({ lead: { ...LEAD, 'Deal stage': 'Sprzedane' } });
  assert.equal(await stracLeadaPoWycenie(sb, { id: 1, lead_id: 467 }, {}), null);
  assert.equal(sb.calls.rpc, null); // żadnego zapisu
});

test('lead już stracony — bez powtórnego zapisu i drugiego wpisu w logu', async () => {
  const sb = fakeSupabaseLead({ lead: { ...LEAD, 'Deal stage': 'Stracony' } });
  assert.equal(await stracLeadaPoWycenie(sb, { id: 1, lead_id: 467 }, {}), null);
  assert.equal(sb.calls.rpc, null);
  assert.equal(sb.calls.log, null);
});

test('brak leada (czysta sierota z wyceną) to nie błąd', async () => {
  const sb = fakeSupabaseLead({});
  assert.equal(await stracLeadaPoWycenie(sb, { id: 1, lead_id: null, telefon_digits: '500100200' }, {}), null);
});

test('bez powodu wpis i tak mówi, skąd wzięła się strata', async () => {
  const sb = fakeSupabaseLead({ lead: LEAD });
  await stracLeadaPoWycenie(sb, { id: 1974, lead_id: 467 }, {});
  assert.match(sb.calls.log.opis, /\[Stracony\] Wycena 1974 oznaczona jako stracona/);
});
