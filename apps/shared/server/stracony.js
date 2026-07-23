// ── Ręczne domknięcie tematu: "Stracony" + POWÓD ────────────────────────────
// Analiza rozmowy celowo nie zamyka leada, który gra na zwłokę ("muszę się
// jeszcze zastanowić", "oddzwonię") — patrz ZASADY STATUSU w call-analysis.js.
// AI nie słyszy tego, co handlowiec słyszy po kliencie, więc ręczna decyzja
// musi być osobnym wejściem. Żeby jednak nie zgubić wiedzy "z czego tracimy",
// każde domknięcie niesie powód: kod ze słownika (do liczenia) + opcjonalny
// komentarz własny (do czytania).
//
// Słownik jest JEDNYM źródłem prawdy — front dociąga go z
// GET /api/leady/powody-straty i renderuje kafelki, więc etykieta na przycisku
// i tekst zapisany w bazie nigdy się nie rozjadą.

const POWODY_STRATY = [
  {
    kod: 'nierokujacy',
    emoji: '🥱',
    label: 'Nierokujący',
    opis: 'Gra na zwłokę, kolejny raz "muszę się zastanowić"',
  },
  {
    kod: 'za_drogo',
    emoji: '💸',
    label: 'Za drogo',
    opis: 'Cena poza budżetem, nie chce negocjować',
  },
  {
    kod: 'konkurencja',
    emoji: '🏳️',
    label: 'Wybrał konkurencję',
    opis: 'Kupił gdzie indziej',
  },
  {
    kod: 'brak_kontaktu',
    emoji: '📵',
    label: 'Brak kontaktu',
    opis: 'Nie odbiera, nie oddzwania, nie odpisuje',
  },
  {
    kod: 'rezygnacja',
    emoji: '🛑',
    label: 'Zrezygnował z projektu',
    opis: 'Temat nieaktualny - odłożony remont, inna technologia',
  },
  {
    kod: 'bledne_dane',
    emoji: '❌',
    label: 'Błędne dane',
    opis: 'Pomyłka, nie ten temat, numer nie ten',
  },
  {
    kod: 'inny',
    emoji: '✍️',
    label: 'Inny powód',
    opis: 'Opisz własnymi słowami',
  },
];

const POWOD_BY_KOD = new Map(POWODY_STRATY.map((p) => [p.kod, p]));

// Tekst zapisywany w kolumnie "Powód stracenia", w historii rozmów i w opisie
// wiersza "Log zmian" — zawsze ten sam, żeby dało się go szukać jednym grepem.
// "Inny powód" nie dokleja etykiety: liczy się wtedy wyłącznie to, co handlowiec
// napisał (etykieta "Inny powód - ..." nic nie wnosi).
function formatPowod(kod, komentarz) {
  const powod = POWOD_BY_KOD.get(kod);
  const tekst = String(komentarz || '').trim();
  if (!powod) return tekst || null;
  if (powod.kod === 'inny') return tekst || powod.label;
  return tekst ? `${powod.label} - ${tekst}` : powod.label;
}

// Powód wyłapany przez AI z rozmowy (analyzeCall.powod_straty) — znakowany
// "(z rozmowy)", żeby na karcie było widać, że to nie handlowiec go wpisał.
// Zwraca null, gdy AI nic nie wyłapała: wtedy w kolumnie zostaje pustka,
// a nie zmyślony powód.
function powodZRozmowy(powodStraty) {
  const tekst = String(powodStraty || '').trim();
  return tekst ? `${tekst} (z rozmowy)` : null;
}

module.exports = { POWODY_STRATY, POWOD_BY_KOD, formatPowod, powodZRozmowy };
