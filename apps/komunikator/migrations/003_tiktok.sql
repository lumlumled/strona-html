-- TikTok jako kanał komentarzowy Komunikatora (read-only).
-- DM-y i komentarze TikToka nie mają oficjalnego API dla firm z EOG
-- (blokada TikToka), więc komentarze wchodzą przez scraper publicznych
-- danych (Apify, cron) — patrz server/ingest/tiktok.js. Odpowiedź: ręcznie
-- w aplikacji + przycisk "Wysłane ręcznie" w panelu.
alter table kom_threads drop constraint kom_threads_channel_check;
alter table kom_threads add constraint kom_threads_channel_check
  check (channel in ('messenger','instagram','whatsapp','phone','email','note','tiktok'));

alter table kom_customer_identities drop constraint kom_customer_identities_type_check;
alter table kom_customer_identities add constraint kom_customer_identities_type_check
  check (type in ('fb','ig','wa','tt','phone','email'));
