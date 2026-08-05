-- Follow-up obietnic klienta (docs/plan-auto-odpowiedzi-komentarze.md, v1).
-- Klient obiecał akcję ("zmierzę w przyszłym tygodniu", kom_commitments
-- owner='klient'), termin minął a on milczy -> automat przypomina Twoim stylem.
-- Osobny outbox od autorespondera (kom_autoreply), ale ten SAM włącznik
-- (kom_settings.auto_send_enabled), ta sama bramka okna Meta (computeSendState)
-- i ten sam worker (/api/cron/outbox). OFF = podgląd 'held' ("wysłałby").
--
-- purpose:
--   ack    - krótkie "Jasne, czekamy 😊" od razu po obietnicy (bez prośby o numer),
--   nudge  - przypomnienie rano po terminie ("czy udało się pomierzyć?"),
--   nudge2 - drugie przypomnienie +7 dni (zwykle poza oknem 7 dni -> 'skipped',
--            zadziała realnie dopiero z szablonami Meta w v2).
create table if not exists kom_followup (
  id uuid primary key default gen_random_uuid(),
  commitment_id uuid references kom_commitments(id),
  thread_id uuid references kom_threads(id),
  customer_id uuid,
  channel text,
  purpose text not null check (purpose in ('ack','nudge','nudge2')),
  stage int not null default 0,
  generated_text text,
  send_after timestamptz not null,
  status text not null default 'queued'
    check (status in ('queued','held','sent','skipped','cancelled','failed')),
  reason text,
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists kom_followup_due_idx on kom_followup(status, send_after);
create index if not exists kom_followup_commitment_idx on kom_followup(commitment_id);
