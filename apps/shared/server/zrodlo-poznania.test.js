// Testy czystych części atrybucji "skąd klient nas zna" (zrodlo-poznania.js):
// normalizacja detekcji (polityka "nie zgaduj"), parsowanie dopasowania filmu
// (próg pewności, format z KATALOGU a nie z deklaracji modelu) i tekst na
// kartę. Ścieżki z GPT/Supabase testujemy ręcznie — tu tylko logika.
//   node --test  (z katalogu apps/shared/server)
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeZrodlo, parseMatchResponse, buildSkadNasZna, catalogLine, ZRODLO_FALLBACK } = require('./zrodlo-poznania');
const { buildCallAnalysisPrompt } = require('./call-analysis');

test('normalizeZrodlo: śmieciowy kod = brak detekcji (nic nie zgadujemy)', () => {
  assert.deepEqual(normalizeZrodlo({ zrodlo_poznania: 'tiktoki' }), ZRODLO_FALLBACK);
  assert.deepEqual(normalizeZrodlo(null), ZRODLO_FALLBACK);
  // Kod poprawny → reszta pól znormalizowana, nie przepisana w ciemno.
  assert.deepEqual(
    normalizeZrodlo({ zrodlo_poznania: 'facebook', zrodlo_obserwuje: 'tak', zrodlo_cytat: '', film_opis: 'ten o schodach' }),
    { zrodlo_poznania: 'facebook', zrodlo_obserwuje: false, zrodlo_cytat: null, film_opis: 'ten o schodach' },
  );
});

test('parseMatchResponse: próg 0.3, format z katalogu, max 3, sort po pewności', () => {
  const rowsById = new Map([
    ['tiktok:1', { platform: 'tiktok', video_id: '1', url: 'u1', format: 'obiekt_grafika' }],
    ['tiktok:2', { platform: 'tiktok', video_id: '2', url: 'u2', format: 'talking_head_popup' }],
  ]);
  const out = parseMatchResponse({
    temat: 'ledy na schodach',
    kandydaci: [
      { id: 'tiktok:2', pewnosc: 0.5, dlaczego: 'schody' },
      { id: 'tiktok:1', pewnosc: 0.9, dlaczego: 'schody + led' },
      { id: 'tiktok:zmyslony', pewnosc: 0.99 },   // halucynacja — nie ma w katalogu
      { id: 'tiktok:2', pewnosc: 0.1 },            // poniżej progu
    ],
  }, rowsById);
  assert.equal(out.kandydaci.length, 2);
  assert.equal(out.kandydaci[0].video_id, '1');
  assert.equal(out.film_format, 'obiekt_grafika'); // z katalogu, po najlepszym
  assert.equal(out.temat, 'ledy na schodach');
});

test('parseMatchResponse: pusta lista = uczciwe "nie wiadomo"', () => {
  const out = parseMatchResponse({ temat: 'coś z ledami', kandydaci: [] }, new Map());
  assert.deepEqual(out.kandydaci, []);
  assert.equal(out.film_format, null);
});

test('buildSkadNasZna: pełny wariant i degradacje', () => {
  const det = { zrodlo_poznania: 'instagram', zrodlo_obserwuje: true, film_opis: 'ten o ledach na schodach' };
  const match = { kandydaci: [{ format: 'obiekt_grafika', pewnosc: 0.72 }] };
  assert.equal(buildSkadNasZna(det, match), 'Instagram (obserwuje nas) — „ten o ledach na schodach” → obiekt_grafika (72%)');
  // Film opisany, ale bez dopasowania → temat zamiast udawanego trafienia.
  assert.equal(
    buildSkadNasZna(det, { kandydaci: [], temat: 'ledy schody' }),
    'Instagram (obserwuje nas) — „ten o ledach na schodach” [temat: ledy schody]',
  );
  // Samo źródło bez filmu.
  assert.equal(buildSkadNasZna({ zrodlo_poznania: 'polecenie' }, null), 'Polecenie');
  assert.equal(buildSkadNasZna({ zrodlo_poznania: null }, null), null);
});

test('catalogLine: zwięzła linia, summary z visual, fallback na caption', () => {
  const line = catalogLine({ platform: 'tiktok', video_id: '7', published_at: '2026-06-12T10:00:00Z', format: 'obiekt_grafika', hook: 'Myślisz, że montaż to kosmos?', summary: 'Profil LED na schodach z adnotacją ceny' });
  assert.match(line, /^tiktok:7 \| 2026-06-12 \| obiekt_grafika \| Myślisz/);
  const line2 = catalogLine({ platform: 'instagram', video_id: '9', caption: 'opis z platformy' });
  assert.match(line2, /opis z platformy/);
});

test('prompt analizy rozmowy zawiera reguły i pola zrodlo_*', () => {
  const prompt = buildCallAnalysisPrompt('07.08.2026', 'przychodzące', '', '');
  assert.match(prompt, /ZASADY zrodlo_poznania/);
  assert.match(prompt, /"zrodlo_poznania"/);
  assert.match(prompt, /"film_opis"/);
});
