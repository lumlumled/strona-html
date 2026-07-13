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

// ── Zegar biznesowy 9–21 (speed-to-lead; decyzja Antoniego 2026-07-13) ───────
test('bizMinutes: lead z nocy startuje o 9:00, wieczór ucina o 21:00', () => {
  const { bizMinutes } = Q._internal;
  // Lipiec = CEST (UTC+2). 23:00 Warszawy 10.07 = 21:00Z; 9:30 Warszawy 11.07 = 7:30Z.
  const noc = Date.UTC(2026, 6, 10, 21, 0);
  const rano930 = Date.UTC(2026, 6, 11, 7, 30);
  assert.equal(bizMinutes(noc, rano930), 30, 'nocny lead: liczy się dopiero od 9:00');
  // Ten sam dzień w oknie: 10:00→11:30 = 90 min.
  assert.equal(bizMinutes(Date.UTC(2026, 6, 11, 8, 0), Date.UTC(2026, 6, 11, 9, 30)), 90);
  // Przez wieczór: 20:30 → 9:15 następnego dnia = 30 + 15.
  assert.equal(bizMinutes(Date.UTC(2026, 6, 10, 18, 30), Date.UTC(2026, 6, 11, 7, 15)), 45);
});

test('parseHook: kreacja przed pierwszym „ - ", platforma z [FB]/[IG]', () => {
  const { parseHook } = Q._internal;
  assert.deepEqual(parseHook('Robi wrażenie [FB] B2C - Nowi – kopia - Nowi sam Facebook - Leady B2C  - Dół lejka'),
    { hook: 'Robi wrażenie B2C', platforma: 'FB' });
  assert.deepEqual(parseHook('Reklama #1 [IG] B2C - Nowi - Nowi sam IG'), { hook: 'Reklama #1 B2C', platforma: 'IG' });
  assert.equal(parseHook('Montaż B2C - Retarg').platforma, null);
});

test('konwersje: krzywa umierania (paid_at / zamówienie phone-match) + ściana cenowa + dowód telefonu', async () => {
  const t0 = Date.now();
  const wyceny = [
    // won same-id, domknięta po 2 dniach (paid_at) — bucket 0–3, kwota 900 → przedział „do 1 tys."
    { id: 1, typ: 'ZAMÓWIENIE', status: 'Waiting for payment', source: 'panel', created_at: iso(10 * DAY), paid_at: iso(8 * DAY), telefon_digits: '111111111', kwota_sprzedazy_brutto: 900 },
    // won phone-match po 9 dniach — bucket 8–14, kwota 3000 → „2–5 tys."
    { id: 2, typ: 'WYCENA', status: 'Open', source: 'panel', created_at: iso(40 * DAY), telefon_digits: '222222222', kwota_proponowana_brutto: 3000 },
    { id: 99, typ: 'ZAMÓWIENIE', status: 'Fulfilled', source: 'shopify', created_at: iso(31 * DAY), telefon_digits: '222222222', kwota_sprzedazy_brutto: 3000 },
    // lost, kwota 3000 → „2–5 tys." (rozstrzygnięte 2, domknięte 1)
    { id: 3, typ: 'WYCENA', status: 'Stracone', source: 'panel', created_at: iso(6 * DAY), telefon_digits: '333333333', kwota_proponowana_brutto: 3000 },
  ];
  const log = [
    // start logu 12 dni temu; wycena id=3 (6 dni) dostała telefon w 1 dzień → tknięta
    { telefon: '999999999', data_zmiany: iso(12 * DAY), zrodlo: 'zadarma_webhook', disposition: 'no_answer', kierunek: 'wychodzące' },
    { telefon: '333333333', data_zmiany: iso(5 * DAY), zrodlo: 'zadarma_webhook', disposition: 'answered', kierunek: 'wychodzące' },
  ];
  const kv = await Q.konwersje(makeDb({ wyceny, 'Log zmian': log }));

  assert.equal(kv.close_rate.domkniete, 2);
  assert.equal(kv.close_rate.stracone, 1);
  const buckets = Object.fromEntries(kv.krzywa_umierania.przedzialy.map((b) => [b.label, b.n]));
  assert.equal(buckets['0–3 dni'], 1, 'paid_at po 2 dniach');
  assert.equal(buckets['8–14 dni'], 1, 'zamówienie shopify po 9 dniach');
  assert.equal(kv.czas_do_domkniecia.n, 2);
  const sciana = Object.fromEntries(kv.sciana_cenowa.przedzialy.map((b) => [b.label, b]));
  assert.equal(sciana['do 1 tys.'].domkniete, 1);
  assert.equal(sciana['2–5 tys.'].rozstrzygniete, 2);
  assert.equal(sciana['2–5 tys.'].domkniete, 1);
  // Dowód telefonu: badane tylko wyceny od startu logu (id=1 sprzed → poza; id=3 tknięta).
  assert.equal(kv.dowod_telefonu.tkniete_7d.rozstrzygniete, 1, 'id=3 (powstała po starcie logu, telefon w 7 dni)');
  assert.match(kv.dowod_telefonu.status, /buduje się/);
});

test('b2bRadar: cykl per NIP, przeterminowany >1,25×, jednorazowy >90 dni', async () => {
  const wyceny = [
    // firma A: -200d, -130d, -60d → cykl 70, od ostatniego 60 < 87,5 → ok
    { id: 1, typ: 'ZAMÓWIENIE', created_at: iso(200 * DAY), invoice_company_nip: '111-111-11-11', invoice_company_name: 'Alfa', kwota_sprzedazy_brutto: 1000 },
    { id: 2, typ: 'ZAMÓWIENIE', created_at: iso(130 * DAY), invoice_company_nip: '1111111111', invoice_company_name: 'Alfa Sp. z o.o.', kwota_sprzedazy_brutto: 1000 },
    { id: 3, typ: 'ZAMÓWIENIE', created_at: iso(60 * DAY), invoice_company_nip: '1111111111', kwota_sprzedazy_brutto: 1000 },
    // firma B: -300d, -200d → cykl 100, od ostatniego 200 > 125 → przeterminowany
    { id: 4, typ: 'ZAMÓWIENIE', created_at: iso(300 * DAY), invoice_company_nip: '2222222222', invoice_company_name: 'Beta', kwota_sprzedazy_brutto: 5000 },
    { id: 5, typ: 'ZAMÓWIENIE', created_at: iso(200 * DAY), invoice_company_nip: '2222222222', kwota_sprzedazy_brutto: 5000 },
    // firma C: jedno zamówienie 100 dni temu → do_odezwania
    { id: 6, typ: 'ZAMÓWIENIE', created_at: iso(100 * DAY), invoice_company_nip: '3333333333', invoice_company_name: 'Gamma', kwota_sprzedazy_brutto: 700 },
    // bez NIP — poza radarem
    { id: 7, typ: 'ZAMÓWIENIE', created_at: iso(10 * DAY), kwota_sprzedazy_brutto: 400 },
  ];
  const r = await Q.b2bRadar(makeDb({ wyceny }));
  assert.equal(r.firmy_n, 3);
  const byNip = Object.fromEntries(r.lista.map((f) => [f.nip, f]));
  assert.equal(byNip['1111111111'].status, 'ok');
  assert.equal(byNip['1111111111'].cykl_dni, 70);
  assert.equal(byNip['1111111111'].nazwa, 'Alfa Sp. z o.o.', 'nazwa z ostatniego niepustego wpisu');
  assert.equal(byNip['2222222222'].status, 'przeterminowany');
  assert.equal(byNip['3333333333'].status, 'do_odezwania');
  assert.equal(r.lista[0].nip, '2222222222', 'przeterminowani na górze');
});

test('kampanie: dedupe telefonu, atrybucja tylko PO dacie leada, rollup hooków', async () => {
  const d = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const leady = [
    { Date: d(20), ad_name: 'Montaż [FB] B2C - Nowi', 'Phone number': '111111111' },
    { Date: d(19), ad_name: 'Montaż [FB] B2C - Nowi', 'Phone number': '111111111' }, // duplikat FB — dedupe
    { Date: d(15), ad_name: 'Robi wrażenie [FB] B2C - Nowi', 'Phone number': '222222222' },
    { Date: d(10), ad_name: '', 'Phone number': '333333333' }, // bez reklamy
  ];
  const wyceny = [
    // zamówienie PO leadzie 111 → liczy się do kampanii Montaż
    { id: 1, typ: 'ZAMÓWIENIE', status: 'Fulfilled', source: 'panel', created_at: iso(5 * DAY), telefon_digits: '111111111', kwota_sprzedazy_brutto: 2000 },
    // zamówienie PRZED leadem 222 (retarg na starego klienta) → NIE liczy się
    { id: 2, typ: 'ZAMÓWIENIE', status: 'Fulfilled', source: 'shopify', created_at: iso(30 * DAY), telefon_digits: '222222222', kwota_sprzedazy_brutto: 999 },
    // wycena PO leadzie 222
    { id: 3, typ: 'WYCENA', status: 'Open', source: 'panel', created_at: iso(8 * DAY), telefon_digits: '222222222', kwota_proponowana_brutto: 1500 },
  ];
  const k = await Q.kampanie(makeDb({ 'Leady B2C': leady, wyceny }));
  assert.equal(k.leady_w_oknie, 3, '3 unikalne telefony');
  assert.equal(k.bez_reklamy, 1);
  const byHook = Object.fromEntries(k.kampanie.map((c) => [c.hook, c]));
  assert.equal(byHook['Montaż B2C'].leady, 1, 'duplikat FB zdeduplikowany');
  assert.equal(byHook['Montaż B2C'].zamowienia, 1);
  assert.equal(byHook['Montaż B2C'].przychod, 2000);
  assert.equal(byHook['Robi wrażenie B2C'].zamowienia, 0, 'zakup sprzed leada nie jest zasługą reklamy');
  assert.equal(byHook['Robi wrażenie B2C'].wyceny, 1);
});

test('forward: cena zaniedbania = nietknięte leady + nieodgrzany martwy pipeline (przy założonym CR)', async () => {
  const wyceny = [
    // martwa otwarta wycena 20 dni, bez telefonu → nieodgrzana, 10 000 zł
    { id: 1, typ: 'WYCENA', status: 'Open', source: 'panel', created_at: iso(20 * DAY), telefon_digits: '111111111', kwota_proponowana_brutto: 10000 },
  ];
  const leady = [
    { 'Phone number': '555555555', 'Deal stage': 'Nowy' }, // nietknięty
  ];
  const f = await Q.forward(makeDb({ wyceny, 'Leady B2C': leady, 'Log zmian': [] }));
  const cz = f.cena_zaniedbania;
  assert.equal(cz.martwy_pipeline_nieodgrzany.n, 1);
  assert.equal(cz.martwy_pipeline_nieodgrzany.suma_wycen, 10000);
  assert.equal(cz.martwy_pipeline_nieodgrzany.marza_szac, Math.round(10000 * 0.25 * 0.74 * 100) / 100);
  assert.equal(cz.leady_nietkniete.n, 1);
  // AOV brak zamówień → fallback 1600: 1 lead × 0,25 × 1600 × 0,74 = 296
  assert.equal(cz.leady_nietkniete.marza_szac, 296);
  assert.equal(cz.razem, Math.round((296 + 1850) * 100) / 100);
  assert.match(cz.zalozenia, /close rate 0.25 \(przyjęty\)/);
});

test('przeglad: sprzedaż bez leada = lead_id NULL i source ∉ {shopify,import}; tygodnie pon–nd', async () => {
  const wyceny = [
    // dzisiaj → bieżący (częściowy) tydzień
    { typ: 'ZAMÓWIENIE', created_at: iso(0), lead_id: null, source: 'panel', kwota_sprzedazy_brutto: 1000 },   // bez leada (kanał prywatny)
    { typ: 'ZAMÓWIENIE', created_at: iso(0), lead_id: '123', source: 'panel', kwota_sprzedazy_brutto: 500 },   // z lejka leadów
    { typ: 'ZAMÓWIENIE', created_at: iso(0), lead_id: null, source: 'shopify', kwota_sprzedazy_brutto: 700 },  // e-commerce → poza OBIEMA seriami
  ];
  const pr = await Q.przeglad(makeDb({ wyceny, 'Leady B2C': [], marketing_organic_daily: [], marketing_organic_posts: [] }), { weeks: 4 });
  assert.equal(pr.tygodnie.length, 4);
  const last = pr.tygodnie[3];
  assert.equal(last.bez_leada_zl, 1000, 'shopify wykluczony z „bez leada"');
  assert.equal(last.z_leada_zl, 500);
  assert.equal(last.sprzedaz_zl, 2200, 'sprzedaż razem liczy wszystko');
  assert.ok('zasieg_sprzedaz_bez_leada' in pr.korelacja, 'korelacja na nowym modelu');
  assert.equal(pr.momentum.bez_leada_zl.teraz, 1000);
  // Etykieta ostatniego kubełka = poniedziałek bieżącego tygodnia (pon–nd, Warszawa).
  const wall = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [y, m, d] = wall.split('-').map(Number);
  const isoDow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  const mon = new Date(Date.UTC(y, m - 1, d - isoDow));
  const expected = `${String(mon.getUTCDate()).padStart(2, '0')}.${String(mon.getUTCMonth() + 1).padStart(2, '0')}`;
  assert.equal(last.label, expected, 'ostatni kubełek zaczyna się w poniedziałek');
});

test('resolveWindow: okres i własny zakres (to = koniec dnia)', () => {
  const { resolveWindow } = Q._internal;
  const w7 = resolveWindow({ okres: '7d' });
  assert.ok(Math.abs(w7.fromTs - (Date.now() - 7 * DAY)) < 2000);
  assert.equal(w7.toTs, null);
  const wc = resolveWindow({ from: '2026-07-01', to: '2026-07-10' });
  assert.ok(wc.toTs > wc.fromTs);
  assert.equal(new Date(wc.toTs + 1).toISOString().slice(0, 10), '2026-07-11', 'to obejmuje cały dzień');
  assert.deepEqual(resolveWindow({}), { fromTs: null, toTs: null });
});
