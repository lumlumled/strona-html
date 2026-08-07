-- ── Lead "Sprzedane" po opłaconej/zrealizowanej wycenie ─────────────────────
-- Problem (lead 438 Adam Van Bendler, 2026-08-07): zamówienie #1996 opłacone
-- i wysłane, a lead dalej wisiał jako "Wycena wysłana". Płatność wysyłała
-- event "Sprzedane" do Meta CAPI, ale nigdy nie dotykała "Deal stage" — CRM
-- nie wiedział o sprzedaży. To brakująca połówka symetrii z migracji 013:
-- strata domyka w obie strony, sprzedaż nie domykała w żadną.
--
-- RPC z tych samych powodów co app_lead_stracony (013):
--   • set_config('app.bypass_log_zmian') wyłącza trigger trg_log_zmian_from_leady,
--     bo wołający wstawia do "Log zmian" własny, bogatszy wiersz (numer
--     zamówienia i kwota w opisie) — bez bypassu jedna sprzedaż logowałaby
--     się dwa razy;
--   • jedna transakcja: status + historia + czyszczenie feedbacku/akcji razem.
-- Czyszczenie feedbacku/akcji jak przy stracie: temat domknięty ma zniknąć
-- z planu dnia (posprzedażowy follow-up to nowa, świadoma akcja handlowca,
-- nie resztka planu dzwonienia). Watcha leada gasi istniejący trigger
-- trg_feedback_watch_mirror (migracja 004) po samym "Deal stage" = 'Sprzedane'.
create or replace function app_lead_sprzedany(
  p_id_leada bigint,
  p_historia text default null
) returns void language plpgsql as $$
begin
  perform set_config('app.bypass_log_zmian', 'on', true);
  update "Leady B2C" set
    "Deal stage" = 'Sprzedane',
    "Historia rozmów" = coalesce(p_historia, "Historia rozmów"),
    "Data Feedbacku" = null,
    "Godzina Feedbacku" = null,
    "Najbliższa akcja" = null,
    "Najbliższa akcja termin" = null,
    "Najbliższa akcja owner" = null
  where "ID Leada" = p_id_leada;
end;
$$;
