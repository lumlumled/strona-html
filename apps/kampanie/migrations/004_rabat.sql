-- Rabat czasowy kampanii (2026-07-15): {"typ":"procent"|"kwota","wartosc":15,
-- "wazny_do":"YYYY-MM-DD"} albo null. Pole na WYCENIE jest kwotowe
-- (rabat24h_kwota + rabat24h_wazny_do), więc procent przeliczamy na złotówki
-- per wycena w momencie WYSYŁKI wiadomości (worker) - karta wyceny i formularz
-- kliencki pokazują wtedy spójnie "Rabat czasowy -X zł" przez cenaFinalna.
alter table kampanie
  add column if not exists rabat jsonb;
