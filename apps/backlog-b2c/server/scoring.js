// Scoring leadów w Backlog B2C (spec: docs/backlog-priorytetyzacja-spec.md,
// aktualizacja 2026-07-22). Czysta logika, bez DB — łatwa do przetestowania.
//
// Dwa reżimy (nie mieszamy w jeden wzór — case jest albo blisko pieniędzy,
// albo w górze lejka):
//  - Reżim A (ma REALNĄ wycenę: koszyk produktów + kwota): wartość × temperatura × termin.
//  - Reżim B (brak wyceny): świeżość + szansa kontaktu (liczba prób).
//
// Wagi to hipoteza startowa — po tygodniu Lorenzo koryguje, potem zamrażamy.

const DZIEN_MS = 24 * 60 * 60 * 1000;

// Kategorie planu dnia, które faktycznie scorujemy i sortujemy po wyniku.
// Reszta (alerty_watchdoga, leady_do_odswiezenia, rozmowy_spoza_bazy,
// dodane_recznie) ma własną semantykę — nie dotykamy jej kolejności.
const SCORED_CATEGORIES = ['nowe', 'wyceny_do_domkniecia', 'reszta_lejka', 'zalegle_feedbacki'];

// Progi tiera (hot/warm/cold → 🔴/🟠/⚪) — startowe, do dostrojenia z Lorenzo.
// Skalują dwa reżimy na jedną oś "jak pilny": świeży lead z dziś (Reżim B = 22)
// wpada w 🟠, gruba gorąca wycena (Reżim A ~90+) w 🔴, martwy ogon w ⚪.
const TIER_HOT = 50;
const TIER_WARM = 22;

// "gorący/średni/zimny" z analizy rozmowy lub dowolny wariant kolumny
// "Temperatura" → kanoniczne GORĄCY/ŚREDNI/ZIMNY. '' gdy nieznane/puste
// (żeby coalesce w RPC nie nadpisał istniejącej wartości pustką).
function normalizeTemperatura(raw) {
  const t = String(raw || '').toLowerCase();
  if (/gor[ąa]c|hot/.test(t)) return 'GORĄCY';
  if (/zimn|cold/.test(t)) return 'ZIMNY';
  if (/[śs]red|letn|norm|warm/.test(t)) return 'ŚREDNI';
  return '';
}

function tempBucket(raw) {
  return normalizeTemperatura(raw); // ta sama normalizacja, osobna nazwa dla czytelności
}

function formatZl(kwota) {
  const n = Math.round(Number(kwota) || 0);
  // Separator tysięcy ręcznie (zwykła spacja) — niezależnie od tego, czy Node
  // ma pełne ICU (toLocaleString('pl-PL') bez ICU zwraca surową liczbę).
  return `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} zł`;
}

// Tolerancyjny parser dat z pól, które w bazie bywają "DD.MM.YYYY",
// "YYYY-MM-DD" albo pełnym ISO. Zwraca lokalną północ danego dnia albo null.
function parseDateish(value) {
  if (!value) return null;
  const s = String(value).trim();
  let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return null;
}

// Zwraca { score, tier, dlaczego[], diament } dla jednego case'a planu dnia.
// Nie mutuje wejścia. `now` = znacznik czasu (ms) — wstrzykiwany, żeby test
// był deterministyczny.
function scoreCase(c, now = Date.now()) {
  const dlaczego = [];
  let score = 0;
  const kwota = Number(c && c.kwota) || 0;
  const temp = tempBucket(c && c.temperatura);
  const maWycene = Boolean(c && c.ma_wycene);

  if (maWycene) {
    // ── Reżim A: blisko pieniędzy ──────────────────────────────────────
    score += 30; // ma realną wycenę
    let wpts = 0;
    if (kwota >= 5000) wpts = 35;
    else if (kwota >= 2000) wpts = 22;
    else if (kwota >= 1000) wpts = 12;
    else if (kwota > 0) wpts = 5;
    score += wpts;
    if (kwota > 0) dlaczego.push(`wycena ${formatZl(kwota)}`);

    if (temp === 'GORĄCY') { score += 18; dlaczego.push('gorący'); }
    else if (temp === 'ŚREDNI') { score += 8; }

    const fb = parseDateish(c && c.data_feedbacku);
    if (fb) {
      const days = Math.floor((now - fb.getTime()) / DZIEN_MS); // dodatnie = przeterminowane
      if (days === 0) { score += 15; dlaczego.push('termin dziś'); }
      else if (days >= 1 && days <= 3) { score += 12; dlaczego.push(`termin −${days}d`); }
      else if (days >= 4 && days <= 7) { score += 6; dlaczego.push(`termin −${days}d`); }
      else if (days > 7) { score += 2; dlaczego.push(`termin −${days}d`); }
      // termin w przyszłości → 0 pkt, bez etykiety
    }
  } else {
    // ── Reżim B: góra lejka ────────────────────────────────────────────
    // Świeżość leada. Rozdzielczość dobowa (pełny plan dnia) — sub-godzinowy
    // boost "<1h/<4h" dokładamy dopiero w real-time (Phase 2).
    const age = parseDateish(c && c.data_dolaczenia);
    if (age) {
      const days = Math.floor((now - age.getTime()) / DZIEN_MS);
      if (days <= 0) { score += 22; dlaczego.push('nowy dziś'); }
      else if (days <= 3) { score += 12; dlaczego.push('świeży lead'); }
      else { score += 6; }
    }
    // Szansa kontaktu: mało prób = dzwoń dalej (wysoko), dużo = odpuść (nisko,
    // kandydat do auto-SMS w Phase 2).
    const proby = Number(c && c.ilosc_telefonow) || 0;
    if (proby >= 6) { score += 3; dlaczego.push(`${proby} prób — do SMS`); }
    else if (proby >= 3) { score += 12; dlaczego.push(`${proby} próby`); }
    else if (proby >= 1) { score += 20; dlaczego.push(`${proby} próba`); }
  }

  const diament = kwota >= 5000;
  let tier = 'cold';
  if (score >= TIER_HOT) tier = 'hot';
  else if (score >= TIER_WARM) tier = 'warm';

  return { score, tier, dlaczego: dlaczego.slice(0, 3), diament };
}

// Dolicza score/tier/dlaczego/diament do case'ów priorytetu i kategorii
// score'owalnych, potem sortuje te kategorie malejąco po score. Nie rusza
// alertów/rozmów spoza bazy (własna semantyka). Zamknięte case'y i tak spadają
// na dół po stronie frontu (resortContainer), więc tu sortujemy czystym score.
function applyScoring(parsed, now = Date.now()) {
  if (!parsed || typeof parsed !== 'object') return;
  const attach = (arr) => {
    if (!Array.isArray(arr)) return;
    arr.forEach((c) => {
      if (!c || typeof c !== 'object') return;
      const s = scoreCase(c, now);
      c.score = s.score;
      c.tier = s.tier;
      c.dlaczego = s.dlaczego;
      c.diament = s.diament;
    });
  };
  attach(parsed.priorytet_dzis);
  const kat = (parsed.kategorie && typeof parsed.kategorie === 'object') ? parsed.kategorie : {};
  SCORED_CATEGORIES.forEach((key) => attach(kat[key]));
  SCORED_CATEGORIES.forEach((key) => {
    if (Array.isArray(kat[key])) {
      kat[key].sort((a, b) => (Number(b && b.score) || 0) - (Number(a && a.score) || 0));
    }
  });
}

module.exports = {
  scoreCase,
  applyScoring,
  normalizeTemperatura,
  tempBucket,
  formatZl,
  parseDateish,
  SCORED_CATEGORIES,
  TIER_HOT,
  TIER_WARM,
};
