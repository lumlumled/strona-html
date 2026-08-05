-- Automat wyceny z wątku pisanego (WhatsApp/Messenger/IG) — decyzja Antoniego
-- 2026-08-05 ("pełny automat"). Gdy w rozmowie padną KONKRETNE produkty+ilości,
-- orchestrator (apps/komunikator/server/wycena-orchestrator.js) tworzy realnego
-- leada (jeśli go nie ma) + szkic wyceny dopasowany do numeru/maila + draft
-- odpowiedzi. Marker auto_wycena_id na wątku = "już zrobione": dedup (nie
-- mnożymy szkiców) i brak reprocessowania w kółko. Szczegóły (link, pozycje,
-- draft, auto_wycena_checked_at) trzymamy w kom_threads.meta.auto_wycena.
alter table kom_threads add column if not exists auto_wycena_id bigint;

-- Sweep crona szuka wątków z intencją wyceny, które jeszcze nie mają auto-wyceny
-- — wąski indeks dokładnie pod ten warunek.
create index if not exists kom_threads_auto_wycena_todo on kom_threads(last_message_at)
  where wycena_intent = true and auto_wycena_id is null;
