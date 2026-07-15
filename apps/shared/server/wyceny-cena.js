// ── Jedno źródło prawdy: "cena, którą klient realnie płaci" ───────────────────
// Rabat czasowy (rabat24h_kwota) OBNIŻA cenę ostateczną — nie jest już samym
// banerem. Zasady (decyzja Antoniego 2026-07-15, case #1809 Łukasz Mikoś: było
// 3200 mimo rabatu do 2850):
//
//   1. Jeśli kwota_sprzedazy_brutto jest zapisana → to jest cena (zamrożona przy
//      złożeniu zamówienia albo ustawiona ręcznie). Wygrywa nad wszystkim.
//   2. Inaczej: kwota_proponowana_brutto − rabat czasowy. Rabat odejmujemy
//      NIEZALEŻNIE od tego, czy licznik "ważny do" już minął — skoro rabat był
//      dany i klient z niego skorzystał, to JEST cena (termin steruje tylko
//      banerem "ważny do / wygasł", nie ceną).
//   3. Bez kwoty proponowanej zwracamy to, co było (null) — wołający guardują.
//
// Moduł jest czysty (bez zależności) — używają go i endpointy panelu, i pipeline
// faktur, i statystyki, żeby liczba NIGDY się nie rozjechała. Patrz notatka
// pamięci project_rabat_czasowy_cena.

function num(v) {
  const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

// Kwota rabatu czasowego (≥ 0), 0 gdy brak. Bez patrzenia na termin.
function rabat24hKwota(wycena) {
  return wycena && wycena.rabat24h_kwota ? num(wycena.rabat24h_kwota) : 0;
}

// Czy rabat czasowy jest JESZCZE ważny (termin w przyszłości) — do banera i do
// zamrożenia ceny przy złożeniu zamówienia (klient złożył przy żywej ofercie).
function rabat24hAktywny(wycena) {
  return Boolean(
    wycena && wycena.rabat24h_kwota && wycena.rabat24h_wazny_do
    && new Date(wycena.rabat24h_wazny_do).getTime() > Date.now()
  );
}

// Cena, którą klient realnie płaci. Zob. zasady u góry pliku.
function cenaFinalna(wycena) {
  if (!wycena) return null;
  if (wycena.kwota_sprzedazy_brutto != null && String(wycena.kwota_sprzedazy_brutto) !== '') {
    return num(wycena.kwota_sprzedazy_brutto);
  }
  if (wycena.kwota_proponowana_brutto == null || String(wycena.kwota_proponowana_brutto) === '') {
    return wycena.kwota_proponowana_brutto ?? null;
  }
  return Math.round((num(wycena.kwota_proponowana_brutto) - rabat24hKwota(wycena)) * 100) / 100;
}

module.exports = { cenaFinalna, rabat24hKwota, rabat24hAktywny, num };
