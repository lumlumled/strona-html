// Testy dwóch reguł, przez które plan dnia rozjeżdżał się z rzeczywistością
// (leady 14 Wiktor / 4 Rafał vs 13 Kamil, 23.07.2026 — patrz komentarze przy
// czyZaopiekowaneDzis i przyszlosciowyRecall):
//   • odhaczenie case'a ma wynikać z FAKTU odbytej rozmowy, nie z tego, czy AI
//     znalazła twarde domknięcie;
//   • lead odesłany w nieokreśloną przyszłość nie może zostać bez terminu.
//   node --test  (z katalogu apps/shared/server)
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { czyZaopiekowaneDzis, przyszlosciowyRecall } = require('./call-analysis');

test('odebrana rozmowa odhacza case, nawet gdy nic nie ustalono', () => {
  // Wiktor: "sam zadzwonię, jak zacznę remont" — brak daty, brak odmowy.
  assert.equal(czyZaopiekowaneDzis(true, { zamkniete_dzis: true, status: 'Przyszłościowy' }), true);
  // Kamil: jawna odmowa — jak dotąd.
  assert.equal(czyZaopiekowaneDzis(true, { zamkniete_dzis: true, status: 'Stracony' }), true);
});

test('AI cofa odhaczenie tylko przy konkretnym zadaniu na dziś', () => {
  assert.equal(czyZaopiekowaneDzis(true, { zamkniete_dzis: false }), false);
});

test('brak analizy nie blokuje odhaczenia — rozmowa i tak się odbyła', () => {
  // analysis=null (transkrypcja padła) oraz fallback z analyzeCall (null).
  assert.equal(czyZaopiekowaneDzis(true, null), true);
  assert.equal(czyZaopiekowaneDzis(true, { zamkniete_dzis: null }), true);
});

test('nieodebrane i poczta głosowa nigdy nie odhaczają', () => {
  assert.equal(czyZaopiekowaneDzis(false, { zamkniete_dzis: true }), false);
  assert.equal(czyZaopiekowaneDzis(false, null), false);
});

test('Przyszłościowy bez terminu wraca kontrolnie za 30 dni', () => {
  const recall = przyszlosciowyRecall('Przyszłościowy', null, '23.07.2026');
  assert.deepEqual(recall, {
    data_feedbacku: '22.08.2026',
    akcja: 'Kontrolny telefon 22.08.2026',
    termin: '22.08.2026',
  });
});

test('istniejący termin i inne statusy zostają nietknięte', () => {
  // Klient umówił konkretny termin — nie nadpisujemy go regułą +30 dni.
  assert.equal(przyszlosciowyRecall('Przyszłościowy', '05.08.2026', '23.07.2026'), null);
  assert.equal(przyszlosciowyRecall('Zadzwonić jeszcze raz', null, '23.07.2026'), null);
  assert.equal(przyszlosciowyRecall('Stracony', null, '23.07.2026'), null);
  // Niepoprawna data "dzisiaj" → brak reguły zamiast śmieciowego terminu.
  assert.equal(przyszlosciowyRecall('Przyszłościowy', null, ''), null);
});
