-- Meta wątku: live_chat_url z ManyChat (bezpośredni link do rozmowy —
-- fallback ręczny po zamknięciu okna 24 h), profile_pic itp.
alter table kom_threads add column if not exists meta jsonb;
