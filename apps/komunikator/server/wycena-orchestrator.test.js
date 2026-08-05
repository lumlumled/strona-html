// Test orchestratora auto-wyceny: happy path (konkretne produkty → nowy lead +
// szkic wyceny z cenami z cennika + stempel wątku + notatka) oraz bramki pomijania
// (istniejąca wycena / brak produktów / brak kontaktu). createWycena i detekcja
// stubowane (bez sieci/DB), leadPhoneCandidates/sumaPozycji/formularzLink PRAWDZIWE.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// wyceny-endpoints: zachowaj prawdziwe (leadPhoneCandidates/sumaPozycji/
// formularzLink są czyste), nadpisz TYLKO createWycena, żeby złapać argumenty
// i zwrócić fałszywą wycenę z tokenem (formularzLink go użyje).
const wePath = require.resolve(path.join(__dirname, '..', '..', 'shared', 'server', 'wyceny-endpoints.js'));
const realWE = require(wePath);
let createArgs = null;
require.cache[wePath] = {
  id: wePath, filename: wePath, loaded: true,
  exports: {
    ...realWE,
    createWycena: async (_db, args) => { createArgs = args; return { id: 9001, form_token: 'tok123', typ: 'B2C' }; },
  },
};

// wycena-detect: stub (bez ładowania call-analysis/rozmowy/media).
const detectPath = require.resolve(path.join(__dirname, 'wycena-detect.js'));
let detectResult = { pozycje: [], cena: null, analysis: null };
require.cache[detectPath] = {
  id: detectPath, filename: detectPath, loaded: true,
  exports: { detectWycenaFromThread: async () => detectResult },
};

const orch = require('./wycena-orchestrator');

// Konfigurowalny mock supabase: handlers[table](state) → wynik. State niesie
// op (select/insert/update), payload i filtry — wystarcza do asercji.
function makeDb(handlers) {
  function builder(table) {
    const state = { table, op: 'select', payload: null, filters: {} };
    const b = {
      select() { return b; },
      insert(p) { state.op = 'insert'; state.payload = p; return b; },
      update(p) { state.op = 'update'; state.payload = p; return b; },
      eq(k, v) { state.filters[k] = v; return b; },
      in(k, v) { state.filters[k] = v; return b; },
      ilike(k, v) { state.filters[k] = v; return b; },
      order() { return b; },
      limit() { return b; },
      single() { state.single = true; return b; },
      then(res, rej) { return Promise.resolve().then(() => handlers[table](state)).then(res, rej); },
      catch(rej) { return this.then(undefined, rej); },
    };
    return b;
  }
  return { from: (t) => builder(t) };
}

const CENNIK = {
  'Cyfrowa taśma COB 3000K IP20': { sku: 'TASMA-C-3000-20', price_brutto: 50, unit: 'm' },
  'Sterownik LumControl': { sku: 'STER-LUM', price_brutto: 120, unit: 'szt' },
};

function happyHandlers(overrides = {}) {
  const rec = { threadUpdate: null, noteInsert: null, leadInsert: null };
  const handlers = {
    kom_customer_identities: () => ({ data: [{ type: 'phone', value: '48604650590' }, { type: 'email', value: 'jan@ex.pl' }] }),
    wyceny: () => ({ data: [] }), // brak istniejącej wyceny
    sku_cennik: (s) => ({ data: CENNIK[s.filters.nazwa] ? [CENNIK[s.filters.nazwa]] : [] }),
    'Leady B2C': (s) => {
      if (s.op === 'insert') { rec.leadInsert = s.payload; return { data: { 'ID Leada': 501, 'Deal stage': 'Nowy', Name: null } }; }
      if (s.single) return { data: { 'ID Leada': 500 } };     // max ID
      return { data: [] };                                     // brak dopasowania po telefonie
    },
    kom_threads: (s) => { rec.threadUpdate = s.payload; return { error: null }; },
    kom_messages: (s) => { rec.noteInsert = s.payload; return { data: [{ id: 'note1' }], error: null }; },
    app_users: () => ({ data: [] }), // brak adresatów push w teście

    ...overrides,
  };
  return { handlers, rec };
}

const thread = { id: 't1', channel: 'whatsapp', meta: {} };
const customer = { id: 'c1', display_name: 'Jan' };

test('happy path: konkretne produkty → lead + wyceniony szkic + stempel + notatka', async () => {
  detectResult = { pozycje: [
    { name: 'Cyfrowa taśma COB 3000K IP20', quantity: 10, price: '' },
    { name: 'Sterownik LumControl', quantity: 2, price: '' },
  ], cena: '740 zł', analysis: null };
  createArgs = null;
  const { handlers, rec } = happyHandlers();
  const out = await orch.maybeCreateWycena(makeDb(handlers), { thread, customer });

  assert.equal(out.created, true);
  assert.equal(out.lead_created, true);
  assert.equal(out.lead_id, '501');
  // createWycena dostał telefon E.164, lead_id, pozycje z cenami z cennika i sumę
  assert.equal(createArgs.fields.telefon_e164, '+48604650590');
  assert.equal(createArgs.fields.email, 'jan@ex.pl');
  assert.equal(createArgs.fields.lead_id, '501');
  assert.equal(createArgs.fields.items[0].price, 50);
  assert.equal(createArgs.fields.items[1].price, 120);
  assert.equal(createArgs.fields.kwota_proponowana_brutto, 740); // 50*10 + 120*2
  assert.equal(createArgs.source, 'komunikator-auto');
  // stempel wątku: marker + meta z linkiem (formularzLink z tokenu)
  assert.equal(rec.threadUpdate.auto_wycena_id, 9001);
  assert.ok(rec.threadUpdate.meta.auto_wycena.link, 'meta.auto_wycena.link ustawiony');
  assert.equal(rec.threadUpdate.meta.auto_wycena.all_priced, true);
  // notatka wewnętrzna z draftem
  assert.equal(rec.noteInsert.direction, 'internal');
  assert.match(rec.noteInsert.body, /Automat utworzył szkic wyceny #9001/);
  // nowy lead ma sensowne pola
  assert.equal(rec.leadInsert['Phone number'], 604650590);
  assert.equal(rec.leadInsert['Źródło'], 'WhatsApp - wykryta wycena');
});

test('istniejąca (nie stracona) wycena → pomiń, nic nie twórz', async () => {
  detectResult = { pozycje: [{ name: 'x', quantity: 1, price: '' }] };
  createArgs = null;
  const { handlers } = happyHandlers({ wyceny: () => ({ data: [{ id: 7, status: 'Open' }] }) });
  const out = await orch.maybeCreateWycena(makeDb(handlers), { thread, customer });
  assert.equal(out.created, false);
  assert.equal(out.reason, 'existing_wycena');
  assert.equal(createArgs, null);
});

test('brak konkretnych produktów → pomiń', async () => {
  detectResult = { pozycje: [], cena: null };
  createArgs = null;
  const { handlers } = happyHandlers();
  const out = await orch.maybeCreateWycena(makeDb(handlers), { thread, customer });
  assert.equal(out.created, false);
  assert.equal(out.reason, 'no_products');
  assert.equal(createArgs, null);
});

test('brak telefonu i maila → pomiń (nie ma jak dopasować/wysłać)', async () => {
  createArgs = null;
  const { handlers } = happyHandlers({ kom_customer_identities: () => ({ data: [] }) });
  const out = await orch.maybeCreateWycena(makeDb(handlers), { thread, customer });
  assert.equal(out.created, false);
  assert.equal(out.reason, 'no_contact');
});

test('kill-switch KOM_AUTO_WYCENA=0 wyłącza całość', async () => {
  process.env.KOM_AUTO_WYCENA = '0';
  const { handlers } = happyHandlers();
  const out = await orch.maybeCreateWycena(makeDb(handlers), { thread, customer });
  assert.equal(out.created, false);
  assert.equal(out.reason, 'disabled');
  delete process.env.KOM_AUTO_WYCENA;
});

test('composeDraft: styl (😊, numer), suma tylko gdy wszystko wycenione', () => {
  const pozycje = [{ name: 'Cyfrowa taśma COB 3000K IP20', quantity: 10, unit: 'm' }, { name: 'Sterownik LumControl', quantity: 2 }];
  const zSuma = orch.composeDraft(pozycje, 740, true, 'https://lumlum.co/w/tok');
  assert.match(zSuma, /Razem: 740 zł/);
  assert.match(zSuma, /- 10m Cyfrowa taśma COB 3000K IP20/);
  assert.match(zSuma, /- 2 szt Sterownik LumControl/);
  assert.match(zSuma, /604 650 590/);
  assert.match(zSuma, /😊/);
  const bezSumy = orch.composeDraft(pozycje, null, false, 'https://lumlum.co/w/tok');
  assert.doesNotMatch(bezSumy, /Razem:/);
});
