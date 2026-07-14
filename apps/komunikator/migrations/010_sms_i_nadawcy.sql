-- SMS jako kanał Komunikatora + wysyłka z karty leada (docs/plan-kontakt-
-- karta-leada.md, Etapy 3-4). Wątek SMS: jeden per klient,
-- external_thread_id = telefon 48XXXXXXXXX; wysyłka przez API Zadarmy.
alter table kom_threads drop constraint kom_threads_channel_check;
alter table kom_threads add constraint kom_threads_channel_check
  check (channel in ('messenger','instagram','whatsapp','phone','email','note','tiktok','sms'));

-- sent_by: dotąd twardo ('customer','antoni','ai_auto') — multi-user
-- (Lorenzo i kolejni) wysyła z karty leada pod własnym nazwiskiem
-- (app_users.name). Zamiast dopisywać nazwiska do CHECK-a przy każdym
-- nowym koncie, zdejmujemy constraint: wartość i tak nadaje wyłącznie
-- serwer (customer/ai_auto/nazwa zalogowanego użytkownika).
alter table kom_messages drop constraint kom_messages_sent_by_check;
