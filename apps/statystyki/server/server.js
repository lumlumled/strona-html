// Panel Statystyki — API dla wewnętrznego AI-doradcy (PLACEHOLDER).
//
// Cel: JEDNO miejsce, z którego asystent AI (Fable) zaciąga gotowe
// statystyki firmy, zamiast przeszukiwać cały system. Kontrakt (kształt
// JSON) jest FINALNY — asystent można budować już teraz. Realne zapytania
// do bazy wpina się w buildzie v1 (segmenty Sprzedaż + Outreach); do tego
// czasu endpoint zwraca szkielet z wartościami `null` i `_status:"placeholder"`.
//
// Mapowanie każdego pola na źródło (tabela/kolumna): docs/statystyki-panel-spec.md.
// Endpoint MASZYNOWY: autoryzacja tokenem (Bearer / ?token=), bez sesji-cookie.
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// --- Autoryzacja tokenem ---
// AI-doradca woła z `Authorization: Bearer <STATS_API_TOKEN>` albo `?token=`.
// Dopóki STATS_API_TOKEN nie jest ustawiony w env → 503 (świadomie: nie
// wystawiamy danych bez tokena). Ustaw sekret w env i podaj go asystentowi.
function requireToken(req, res, next) {
  const expected = process.env.STATS_API_TOKEN;
  if (!expected) return res.status(503).json({ error: 'STATS_API_TOKEN nie ustawiony — endpoint wyłączony' });
  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const token = bearer || req.query.token;
  if (token !== expected) return res.status(401).json({ error: 'Nieprawidłowy token' });
  next();
}

// Szkielet snapshotu — POLA FINALNE, wartości do wpięcia w buildzie.
// Komentarz przy każdym polu = skąd się je liczy (patrz spec).
function emptySnapshot() {
  return {
    _status: 'placeholder',
    _note: 'Kontrakt pól jest finalny; realne zapytania do wpięcia w buildzie v1. Źródła pól: docs/statystyki-panel-spec.md.',
    generated_at: new Date().toISOString(),
    sprzedaz: {
      close_rate_30d: null,                                   // kohortowo: z wycen typ=WYCENA (30d wstecz) ile ma ZAMÓWIENIE/paid w 30 dni
      sprzedaz_mies: { count: null, suma: null },             // wyceny typ=ZAMÓWIENIE, bieżący miesiąc (Europe/Warsaw)
      aov: null,                                              // suma / count zamówień w oknie
      pipeline_otwarty: { count: null, suma: null, sredni_wiek_dni: null }, // typ=WYCENA, status Open/Waiting for payment
    },
    outreach: {
      telefony_dzis: null,                                    // Log zmian, zrodlo=zadarma_webhook, data_zmiany=dziś
      telefony_tydzien: null,                                 // j.w., ostatnie 7 dni
      pct_dodzwonien: null,                                   // 1 − (disposition='no_answer' / wszystkie telefony)
      speed_to_lead_med_min: null,                            // mediana: event 'Nowy' (Log zmian) → 1. tel wychodzący
      leady_nietkniete: null,                                 // leady status Nowy/Nie odebrał z 0 wpisów telefonicznych
      martwe_wyceny_tkniete_7d: null,                         // otwarte wyceny >14 dni, które dostały kontakt w 7 dni
    },
    alerty: [],                                               // gotowe zdania dla doradcy, np. "268 000 zł leży w otwartych wycenach…"
  };
}

// GŁÓWNY endpoint dla AI: kompletny snapshot firmy w jednym strzale.
app.get('/api/stats/snapshot', requireToken, (req, res) => res.json(emptySnapshot()));

// Aliasy segmentowe (opcjonalne — gdyby asystent chciał tylko część).
app.get('/api/stats/sprzedaz', requireToken, (req, res) => {
  res.json({ _status: 'placeholder', generated_at: new Date().toISOString(), ...emptySnapshot().sprzedaz });
});
app.get('/api/stats/outreach', requireToken, (req, res) => {
  res.json({ _status: 'placeholder', generated_at: new Date().toISOString(), ...emptySnapshot().outreach });
});

// Health-check bez tokena — do sprawdzenia, czy funkcja żyje po deployu.
app.get('/api/stats/health', (req, res) => {
  res.json({ ok: true, panel: 'statystyki', token_set: Boolean(process.env.STATS_API_TOKEN), ts: new Date().toISOString() });
});

const PORT = process.env.PORT || 3010;
if (require.main === module) {
  app.listen(PORT, () => console.log(`API Statystyki (placeholder) działa na http://localhost:${PORT}`));
}

module.exports = app;
