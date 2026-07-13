// Testy metryk Statystyk (guardrails §1/§2/§4):
//   node --test apps/statystyki/server/queries.test.js
// Krytyczne: (1) close rate liczy DWA sygnały domknięcia (same-id flip +
// phone-match 30 dni) BEZ podwójnego liczenia i reklasyfikuje „Stracone",
// które i tak kupiło; (2) martwe_wyceny_tkniete_7d i leady_nietkniete liczą
// się po telefonie z Log zmian (nie z „Ilość telefonów").
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Q = require('./queries');

// ── Minimalny mock query-buildera Supabase ──────────────────────────────────
// Chainable select/eq/neq/ilike, awaitable (then) → { data, error }.
function makeDb(tables) {
  return {
    from(table) {
      const filters = [];
      const builder = {
        select() { return builder; },
        eq(col, val) { filters.push(['eq', col, val]); return builder; },
        neq(col, val) { filters.push(['neq', col, val]); return builder; },
        ilike(col, val) { filters.push(['ilike', col, val]); return builder; },
        then(resolve) {
          let rows = (tables[table] || []).slice();
          for (const [op, col, val] of filters) {
            rows = rows.filter((r) => {
              const cell = r[col];
              if (op === 'eq') return cell === val;
              if (op === 'neq') return cell !== val;
              if (op === 'ilike') return String(cell || '').toLowerCase() === String(val).toLowerCase();
              return true;
            });
          }
          resolve({ data: rows, error: null });
        },
      };
      return builder;
    },
  };
}

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const DAY = 86400000;

test('closeRate: same-id flip + phone-match 30d, bez double-count, reklasyfikuje Stracone który kupił', async () => {
  const wyceny = [
    // (1) panelowa wycena domknięta jako TEN SAM id (flip → ZAMÓWIENIE)
    { id: 1, typ: 'ZAMÓWIENIE', status: 'Waiting for payment', source: 'quick-add', created_at: iso(3 * DAY), telefon_digits: '111111111' },
    // (2) panelowa wycena wciąż WYCENA/Open, telefon kupił w SKLEPIE w 9 dni → domknięta innym kanałem
    { id: 2, typ: 'WYCENA', status: 'Open', source: 'quick-add', created_at: iso(40 * DAY), telefon_digits: '222222222' },
    { id: 99, typ: 'ZAMÓWIENIE', status: 'Waiting for payment', source: 'shopify', created_at: iso(31 * DAY), telefon_digits: '222222222' },
    // (3) panelowa wycena przegrana, telefon NIE kupił → Stracone
    { id: 3, typ: 'WYCENA', status: 'Stracone', source: 'quick-add', created_at: iso(40 * DAY), telefon_digits: '333333333' },
    // (4) oznaczona Stracone, ale telefon kupił w sklepie w 5 dni → reklasyfikacja na domkniętą
    { id: 4, typ: 'WYCENA', status: 'Stracone', source: 'quick-add', created_at: iso(40 * DAY), telefon_digits: '444444444' },
    { id: 98, typ: 'ZAMÓWIENIE', status: 'Waiting for payment', source: 'shopify', created_at: iso(35 * DAY), telefon_digits: '444444444' },
    // (5) otwarta, młodsza niż 30 dni, brak zamówienia → dojrzewa, poza mianownikiem
    { id: 5, typ: 'WYCENA', status: 'Open', source: 'quick-add', created_at: iso(5 * DAY), telefon_digits: '555555555' },
    // historia importu — poza kohortą (ale gdyby miała telefon, i tak zasila orderTsByPhone)
    { id: 6, typ: 'WYCENA', status: 'Open', source: 'import', created_at: iso(200 * DAY), telefon_digits: '666666666' },
    // NOTATKA — odfiltrowana przez neq('typ','NOTATKA')
    { id: 7, typ: 'NOTATKA', status: null, source: 'quick-add', created_at: iso(1 * DAY), telefon_digits: '777777777' },
  ];
  const cr = await Q.closeRate(makeDb({ wyceny }));

  assert.equal(cr.wyceny_w_panelu, 5, 'kohorta = 5 panelowych (bez import/NOTATKA)');
  assert.equal(cr.domkniete_ten_sam_id, 1, 'flip id=1');
  assert.equal(cr.domkniete_inny_kanal, 2, 'phone-match id=2 i id=4');
  assert.equal(cr.domkniete, 3, 'brak podwójnego liczenia (WYCENA vs ZAMÓWIENIE rozłączne)');
  assert.equal(cr.stracone, 1, 'tylko id=3 (id=4 przeszło na domkniętą)');
  assert.equal(cr.otwarte, 1, 'tylko id=5 (id=2 domknięte innym kanałem)');
  assert.equal(cr.dojrzewajace, 1, 'id=5 otwarte <30 dni');
  assert.equal(cr.close_rate, null, 'próbka 4/15 — buduje się');
  assert.match(cr.status, /buduje się/);
});

test('closeRate: przy próbce ≥15 rozstrzygniętych zwraca liczbę', async () => {
  const wyceny = [];
  for (let i = 0; i < 12; i += 1) wyceny.push({ id: 100 + i, typ: 'ZAMÓWIENIE', status: 'Waiting for payment', source: 'quick-add', created_at: iso(10 * DAY), telefon_digits: `10000000${i}` });
  for (let i = 0; i < 3; i += 1) wyceny.push({ id: 200 + i, typ: 'WYCENA', status: 'Stracone', source: 'quick-add', created_at: iso(40 * DAY), telefon_digits: `30000000${i}` });
  const cr = await Q.closeRate(makeDb({ wyceny }));
  assert.equal(cr.domkniete, 12);
  assert.equal(cr.stracone, 3);
  assert.equal(cr.close_rate, 0.8, '12/15 = 0.8');
  assert.equal(cr.status, 'ok');
});

test('outreach: martwe_wyceny_tkniete_7d i leady_nietkniete liczone po telefonie z Log zmian', async () => {
  const log = [
    // telefon 111: połączenie 2 dni temu (w oknie 7d)
    { telefon: '111111111', data_zmiany: iso(2 * DAY), zrodlo: 'zadarma_webhook', disposition: 'answered', kierunek: 'wychodzące', status_po: null },
    // telefon 999: stare połączenie 40 dni temu (w callPhones, poza 7d)
    { telefon: '999999999', data_zmiany: iso(40 * DAY), zrodlo: 'zadarma_webhook', disposition: 'no_answer', kierunek: 'wychodzące', status_po: null },
    // nie-telefon — ignorowany (guardrails §2.2)
    { telefon: '888888888', data_zmiany: iso(1 * DAY), zrodlo: 'notatka_handlowca', disposition: null, kierunek: null, status_po: null },
  ];
  const wyceny = [
    { id: 1, typ: 'WYCENA', status: 'Open', created_at: iso(20 * DAY), telefon_digits: '111111111' }, // martwa >14d + telefon tknięty 7d → liczy
    { id: 2, typ: 'WYCENA', status: 'Open', created_at: iso(5 * DAY), telefon_digits: '111111111' },  // <14d → nie martwa
    { id: 3, typ: 'WYCENA', status: 'Open', created_at: iso(30 * DAY), telefon_digits: '222222222' }, // martwa, ale telefon bez połączenia 7d
  ];
  const leady = [
    { 'Phone number': '+48111111111', 'Deal stage': 'Nowy' },   // ma połączenie → tknięty
    { 'Phone number': '555555555', 'Deal stage': 'Nowy' },      // brak połączenia, aktywny → nietknięty
    { 'Phone number': '666666666', 'Deal stage': 'Sprzedane' }, // domknięty → poza
    { 'Phone number': '777777777', 'Deal stage': 'Nie odebrał' }, // brak połączenia, aktywny → nietknięty
  ];
  const out = await Q.outreach(makeDb({ 'Log zmian': log, 'Leady B2C': leady, wyceny }));

  assert.equal(out.martwe_wyceny_tkniete_7d, 1, 'tylko wycena id=1');
  assert.equal(out.leady_nietkniete, 2, '555 i 777 (aktywne, bez połączenia)');
  assert.equal(out.telefony_tydzien, 1, 'jedno realne połączenie w 7 dni');
});
