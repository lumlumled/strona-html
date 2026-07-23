// Testy słownika powodów straty (decyzja Antoniego 2026-07-23): każde ręczne
// domknięcie tematu niesie powód, bo bez niego po pół roku nie da się
// odpowiedzieć, czy tracimy przez cenę, czy przez bujanie.
//   node --test apps/shared/server/stracony.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { POWODY_STRATY, formatPowod, powodZRozmowy } = require('./stracony');

test('sam kod daje czytelną etykietę', () => {
  assert.equal(formatPowod('nierokujacy'), 'Nierokujący');
  assert.equal(formatPowod('za_drogo', ''), 'Za drogo');
});

test('komentarz doklejany po myślniku, nigdy nie gubi etykiety', () => {
  assert.equal(
    formatPowod('za_drogo', 'ma ofertę 3300 od elektryka'),
    'Za drogo - ma ofertę 3300 od elektryka',
  );
  assert.equal(formatPowod('nierokujacy', '  4. raz wysyłam wycenę  '), 'Nierokujący - 4. raz wysyłam wycenę');
});

test('"Inny powód" zapisuje wyłącznie treść handlowca', () => {
  // Etykieta "Inny powód - ..." nic nie wnosi, liczy się to, co napisał.
  assert.equal(formatPowod('inny', 'zmarł'), 'zmarł');
  // Pusty "Inny powód" nie może przejść — front go blokuje, serwer też.
  assert.equal(formatPowod('inny', '   '), 'Inny powód');
});

test('nieznany kod: zostaje sam komentarz, a bez komentarza null', () => {
  assert.equal(formatPowod('wymyslony', 'klient zniknął'), 'klient zniknął');
  assert.equal(formatPowod('wymyslony', ''), null);
  // null blokuje zapis w endpoincie — nie da się zamknąć tematu bez powodu.
  assert.equal(formatPowod(undefined, undefined), null);
});

test('powód z rozmowy jest znakowany, żeby nie udawał wpisu handlowca', () => {
  assert.equal(powodZRozmowy('Kupił u konkurencji'), 'Kupił u konkurencji (z rozmowy)');
  // AI nic nie wyłapała → pusto, zamiast zmyślonego powodu.
  assert.equal(powodZRozmowy(''), null);
  assert.equal(powodZRozmowy(null), null);
});

test('każdy powód ze słownika ma komplet pól do kafelka', () => {
  assert.ok(POWODY_STRATY.length >= 5);
  POWODY_STRATY.forEach((p) => {
    assert.match(p.kod, /^[a-z_]+$/);
    assert.ok(p.label && p.emoji, `powód ${p.kod} bez etykiety/emoji`);
  });
  assert.ok(POWODY_STRATY.some((p) => p.kod === 'inny'), 'musi być furtka na własny opis');
});
