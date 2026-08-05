-- Nowy wątek rodzi się CICHO ('waiting'), nie jako karta "Do odpisania".
-- Default 'attention' był bombą: każdy attachThread bez jawnego statusu
-- (conversation.started z Zernio, wątek SMS z kontakt-send) produkował
-- wieczną kartę "(brak treści)" — 2026-08-04 podpięcie WhatsAppa zrobiło
-- tak 72 puste karty naraz. 'attention' ustawiają wyłącznie ingesty po
-- realnej wiadomości przychodzącej.
alter table kom_threads alter column status set default 'waiting';

-- Sprzątanie po bombie: wątki 'attention' bez ŻADNEJ realnej wiadomości od
-- klienta (puste z conversation.started, out-only SMS, atrapy "Rozpocznij")
-- schodzą na 'waiting'. Wrócą, gdy klient napisze coś naprawdę.
update kom_threads t set status = 'waiting'
where t.status = 'attention'
  and not exists (
    select 1 from kom_messages m
    where m.thread_id = t.id
      and m.direction = 'in'
      and nullif(btrim(m.body), '') is not null
      and lower(btrim(m.body)) not in
        ('[pusta wiadomość]', '[pusty komentarz]', 'rozpocznij', 'get started', 'getstarted', 'start', 'zaczynamy')
  );
