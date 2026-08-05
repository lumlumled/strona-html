// Test: detekcja wyceny z wątku pisanego składa "rozmowę" z wiadomości +
// notek AI o załącznikach i przepuszcza ją przez tę samą ekstrakcję produktów
// co telefon (analyzeCall). Stubujemy analyzeCall (bez sieci) i media (bez llm),
// a parseProduktyToItems zostaje PRAWDZIWE - to ono musi poprawnie zamienić
// "10m Cyfrowa taśma…" na pozycję z ilością 10.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// call-analysis: zachowaj prawdziwy moduł (rozmowy.js zależy od statusRank itd.
// przy require), nadpisz TYLKO analyzeCall, który ma zapisać podany transkrypt
// i zwrócić kontrolowany wynik.
const caPath = require.resolve(path.join(__dirname, '..', '..', 'shared', 'server', 'call-analysis.js'));
const realCA = require(caPath);
let capturedTranscript = null;
let nextAnalysis = { produkty: '', cena_zaproponowana: null };
require.cache[caPath] = {
  id: caPath, filename: caPath, loaded: true,
  exports: {
    ...realCA,
    analyzeCall: async (transcript) => { capturedTranscript = transcript; return { ...nextAnalysis }; },
  },
};

// media: stub notesByMessage (bez ładowania llm). Domyślnie brak notek; test
// załącznika podmienia mapę.
const mediaPath = require.resolve(path.join(__dirname, 'media.js'));
let attMap = new Map();
require.cache[mediaPath] = {
  id: mediaPath, filename: mediaPath, loaded: true,
  exports: { notesByMessage: async () => attMap },
};

const { detectWycenaFromThread, buildThreadTranscript } = require('./wycena-detect');

function mockDb(rows) {
  const chain = {
    select() { return chain; },
    eq() { return chain; },
    order() { return chain; },
    limit() { return Promise.resolve({ data: rows, error: null }); },
  };
  return { from() { return chain; } };
}

test('konkretne produkty w rozmowie → pozycje z poprawnymi ilościami', async () => {
  nextAnalysis = { produkty: '10m Cyfrowa taśma COB 3000K IP20\n2 Sterownik LumControl', cena_zaproponowana: '2300 zł' };
  attMap = new Map();
  const db = mockDb([
    { id: 'm1', direction: 'in', body: 'Cześć, potrzebuję cyfrową taśmę 3000K na 10 metrów' },
    { id: 'm2', direction: 'out', body: 'Jasne, do tego sterownik LumControl' },
  ]);
  const out = await detectWycenaFromThread(db, 't1');
  assert.equal(out.pozycje.length, 2);
  assert.deepEqual(out.pozycje[0], { name: 'Cyfrowa taśma COB 3000K IP20', quantity: 10, price: '' });
  assert.deepEqual(out.pozycje[1], { name: 'Sterownik LumControl', quantity: 2, price: '' });
  assert.equal(out.cena, '2300 zł');
});

test('transkrypt składa się z etykiet KLIENT/LUMLUM i doklejonych notek AI', async () => {
  nextAnalysis = { produkty: '', cena_zaproponowana: null };
  attMap = new Map([['m1', ['[zdjęcie od klienta - analiza AI: rzut z 12 m profilu w suficie]']]]);
  const db = mockDb([
    { id: 'm1', direction: 'in', body: 'Wysyłam rzut' },
    { id: 'm2', direction: 'out', body: 'Dzięki, patrzę' },
  ]);
  await detectWycenaFromThread(db, 't1');
  assert.match(capturedTranscript, /KLIENT: Wysyłam rzut/);
  assert.match(capturedTranscript, /LUMLUM: Dzięki, patrzę/);
  assert.match(capturedTranscript, /analiza AI: rzut z 12 m profilu/);
});

test('brak konkretnych produktów → pozycje puste (nic się nie dzieje)', async () => {
  nextAnalysis = { produkty: '', cena_zaproponowana: null };
  attMap = new Map();
  const db = mockDb([{ id: 'm1', direction: 'in', body: 'Fajne te taśmy, ile kosztują?' }]);
  const out = await detectWycenaFromThread(db, 't1');
  assert.equal(out.pozycje.length, 0);
  assert.equal(out.produkty, null);
});

test('pusty wątek → pusty wynik, bez wołania AI', async () => {
  capturedTranscript = null;
  const db = mockDb([]);
  const out = await detectWycenaFromThread(db, 't1');
  assert.equal(out.pozycje.length, 0);
  assert.equal(capturedTranscript, null);
});

test('buildThreadTranscript dokleja notki tylko do właściwej wiadomości', async () => {
  attMap = new Map([['m2', ['[nagranie głosowe nagrane przez Ciebie - notatka: klient chce 6m']]]);
  const db = mockDb([]);
  const transcript = await buildThreadTranscript(db, [
    { id: 'm1', direction: 'in', body: 'Dzień dobry' },
    { id: 'm2', direction: 'out', body: 'Podsumowuję' },
  ]);
  const lines = transcript.split('\n');
  assert.equal(lines[0], 'KLIENT: Dzień dobry');
  assert.equal(lines[1], 'LUMLUM: Podsumowuję');
  assert.match(lines[2], /notatka: klient chce 6m/);
});
