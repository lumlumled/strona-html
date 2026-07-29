// Test parsera produktów z analizy rozmowy → pozycje wyceny (rdzeń panelu
// "Wykryliśmy wycenę"). Format wejścia = ZASADY POLA produkty z call-analysis.js.
const { test } = require('node:test');
const assert = require('node:assert');
const { parseProduktyToItems } = require('./rozmowy');

test('taśma z jednostką "m" → ilość to liczba, "m" nie wchodzi do nazwy', () => {
  const items = parseProduktyToItems('10m Cyfrowa taśma COB 3000K IP20');
  assert.deepEqual(items, [{ name: 'Cyfrowa taśma COB 3000K IP20', quantity: 10, price: '' }]);
});

test('sztuki bez jednostki → ilość + nazwa', () => {
  const items = parseProduktyToItems('2 Sterownik LumControl');
  assert.deepEqual(items, [{ name: 'Sterownik LumControl', quantity: 2, price: '' }]);
});

test('wiele linii → wiele pozycji, każda z pustą ceną', () => {
  const items = parseProduktyToItems('10m Cyfrowa taśma COB 3000K IP20\n2 Zasilacz 150W 24V\n1 Pilot MONO 4 strefy');
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((i) => i.quantity), [10, 2, 1]);
  assert.ok(items.every((i) => i.price === ''));
});

test('pusty tekst → pusta lista (brak propozycji wyceny)', () => {
  assert.deepEqual(parseProduktyToItems(''), []);
  assert.deepEqual(parseProduktyToItems(null), []);
});

test('linia bez wiodącej ilości → ilość 1, cała linia jako nazwa', () => {
  assert.deepEqual(parseProduktyToItems('Zasilacz bez ilości'), [{ name: 'Zasilacz bez ilości', quantity: 1, price: '' }]);
});

test('ułamkowy metraż (przecinek) → liczba', () => {
  assert.deepEqual(parseProduktyToItems('2,5m Analogowa taśma COB IP67'), [{ name: 'Analogowa taśma COB IP67', quantity: 2.5, price: '' }]);
});

test('puste linie pomijane', () => {
  assert.equal(parseProduktyToItems('\n\n3 Zestaw czujników ruchu\n\n').length, 1);
});
