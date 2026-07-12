-- Watchdog "temat ucieka" — jedna tabela terminów feedbacku per obiekt
-- (docs/plan-watchdog-feedback.md §4). Wyceny i leady; obietnice z wiadomości
-- żyją w kom_commitments (unia w dispatcherze), celowo NIE tutaj.
--
-- Cykl życia wiersza: open (resolved_at is null) -> alerted (alerted_at) ->
-- resolved (activity/done/cancelled/superseded). Nowy termin dla obiektu
-- superseduje stary otwarty watch — max jeden otwarty per obiekt (unikalny
-- indeks częściowy).

create table if not exists feedback_watch (
  id bigserial primary key,
  object_type text not null check (object_type in ('wycena','lead')),
  object_id text not null,                  -- wyceny.id (jako text) / "ID Leada"
  owner text,                               -- app_users.name (Antoni/Lorenzo)
  due_at timestamptz not null,              -- termin feedbacku
  reason text,                              -- przesłanka z rozmowy albo uzasadnienie AI
  set_by text not null check (set_by in ('ai','human')),
  visible boolean not null default false,   -- true = jawna data w panelu; false = cichy watchdog
  source text,                              -- 'rozmowa'|'notatka'|'edytor'|'mirror_lead'|'ai_temperatura'
  backlog_target text not null default 'b2c' check (backlog_target in ('b2c','b2b')),
  baseline_at timestamptz not null default now(),  -- aktywność PO tym momencie = temat żyje
  alert_text text,                          -- wygenerowany alert (null = jeszcze nie alertowano)
  alerted_at timestamptz,
  resolved_at timestamptz,
  resolution text check (resolution in ('activity','done','cancelled','superseded')),
  created_at timestamptz not null default now()
);

create unique index if not exists feedback_watch_open_uq
  on feedback_watch (object_type, object_id) where resolved_at is null;
create index if not exists feedback_watch_due
  on feedback_watch (due_at) where resolved_at is null;
