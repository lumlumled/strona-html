-- Wyklucz nadawcę z alarmu "temat ucieka" (przycisk "wyklucz maila" w hubie).
-- Flaga na kliencie komunikatora: jego obietnice przestają wpadać do
-- /api/watchdog/alerty. Nie rusza inboxa/komunikatora - dotyczy TYLKO alarmu.
-- Uzupełnia startową blokadę automatów (SENDER_DENYLIST w watchdog-dispatcher.js)
-- o ręczne, trwałe wykluczenia długiego ogona (faktury, boty, pomyłki).
alter table kom_customers
  add column if not exists alerts_excluded boolean not null default false;
