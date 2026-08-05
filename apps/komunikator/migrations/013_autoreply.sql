-- Autoresponder: kolejka decyzji + log podglądu (docs/plan-auto-odpowiedzi-komentarze.md).
-- Webhook (tani) tworzy wiersz 'queued' z send_after (opóźnienie 2-15 min anty-bot).
-- Worker (cron) generuje treść i albo WYSYŁA (gdy włącznik ON), albo oznacza
-- 'held' = "wysłałby" (podgląd na sucho, gdy OFF). Włącznik: kom_settings.auto_send_enabled.
create table if not exists kom_autoreply (
  id             uuid primary key default gen_random_uuid(),
  thread_id      uuid not null references kom_threads(id),
  in_message_id  uuid references kom_messages(id),
  channel        text,
  kind           text,                    -- 'dm' | 'comment'
  verdict        text not null default 'send',
  reason         text,
  confidence     int,
  generated_text text,
  suggestion_id  uuid references kom_suggestions(id),
  send_after     timestamptz not null,
  status         text not null default 'queued'
                 check (status in ('queued','held','sent','skipped','cancelled','failed')),
  sent_at        timestamptz,
  error          text,
  created_at     timestamptz not null default now()
);
create index if not exists kom_autoreply_due on kom_autoreply (status, send_after);
create index if not exists kom_autoreply_thread on kom_autoreply (thread_id);
create index if not exists kom_autoreply_created on kom_autoreply (created_at desc);
