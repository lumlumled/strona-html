-- ── Powód stracenia (ręczne domknięcie nierokującego tematu) ────────────────
-- Decyzja Antoniego 2026-07-23: AI celowo NIE zamyka leada, który gra na
-- zwłokę ("muszę się jeszcze zastanowić", "oddzwonię") — patrz ZASADY STATUSU
-- w call-analysis.js. To handlowiec słyszy po kliencie, że temat jest martwy,
-- więc musi mieć własne wejście: status "Stracony" + POWÓD, żeby po miesiącach
-- dało się odpowiedzieć "z czego tracimy" (cena vs bujanie vs konkurencja).
--
-- Powód zapisujemy w kolumnie (do liczenia) ORAZ jako wpis w "Historia rozmów"
-- (do czytania w osi czasu karty) — jedno nie zastępuje drugiego.

alter table "Leady B2C" add column if not exists "Powód stracenia" text;

-- Ta sama informacja na wycenie: wycena straconego leada idzie na 'Stracone'
-- (wyceny-sync.js), ale bez powodu wyglądała jak zamknięta "z automatu".
alter table wyceny add column if not exists powod_straty text;

-- Numer bez leada, znany tylko z rozmowy (POST /api/rozmowy/reczna kieruje
-- wycenowe/nieznane telefony właśnie tutaj) — też da się domknąć ręcznie.
alter table kontakty_organic add column if not exists powod_straty text;

-- RPC ręcznego domknięcia. Dlaczego RPC, a nie zwykły .update():
--   • set_config('app.bypass_log_zmian') wyłącza trigger trg_log_zmian_from_leady,
--     bo endpoint wstawia do "Log zmian" własny, bogatszy wiersz (z powodem w
--     `opis` i handlowcem) — bez tego jedno domknięcie logowałoby się DWA razy
--     i psuło statystyki zmian statusu;
--   • wszystko leci jedną transakcją, więc nie ma stanu pośredniego
--     "Stracony bez powodu".
-- Czyszczenie feedbacku/akcji jest częścią domknięcia: temat ma zniknąć z planu
-- dnia i z watchdoga (trigger trg_feedback_watch_mirror gasi watcha leada
-- właśnie po "Deal stage" = 'Stracony').
create or replace function app_lead_stracony(
  p_id_leada bigint,
  p_powod text,
  p_historia text default null
) returns void language plpgsql as $$
begin
  perform set_config('app.bypass_log_zmian', 'on', true);
  update "Leady B2C" set
    "Deal stage" = 'Stracony',
    "Powód stracenia" = p_powod,
    "Historia rozmów" = coalesce(p_historia, "Historia rozmów"),
    "Data Feedbacku" = null,
    "Godzina Feedbacku" = null,
    "Najbliższa akcja" = null,
    "Najbliższa akcja termin" = null,
    "Najbliższa akcja owner" = null
  where "ID Leada" = p_id_leada;
end;
$$;
