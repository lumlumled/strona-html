-- Triage: selekcja AI tego, co trafia do głównego widoku panelu.
-- Polaryzacja per typ (decyzja Antoniego 2026-07-11):
--   komentarz → domyślnie 'archive', 'inbox' TYLKO przy jasnych sygnałach zakupowych;
--   DM/e-mail → domyślnie 'inbox', 'archive' tylko przy jasnym spamie;
--   'notification' = automaty wymagające uwagi (osobna zakładka).
-- kom_messages.triage NULL = jeszcze nieoklasyfikowane (sweep w cronie łapie
-- zaległości, np. gdy LLM nie zdążył w limicie czasu webhooka).

alter table kom_threads add column if not exists triage text not null default 'inbox'
  check (triage in ('inbox','notification','archive'));
alter table kom_threads add column if not exists triage_reason text;

alter table kom_messages add column if not exists triage text
  check (triage in ('inbox','notification','archive'));

-- Reguły "nie chcę widzieć podobnych": twarde wyciszenie nadawcy
-- (sender_type+sender_value) + treść przykładu jako wskazówka dla
-- klasyfikatora ("wiadomości podobne do tych → archive").
create table if not exists kom_triage_rules (
  id           uuid primary key default gen_random_uuid(),
  action       text not null default 'archive' check (action in ('archive','notification')),
  sender_type  text check (sender_type in ('fb','ig','wa','tt','phone','email')),
  sender_value text,
  example_text text,
  note         text,
  created_at   timestamptz not null default now()
);
create index if not exists kom_triage_rules_sender_idx on kom_triage_rules (sender_type, sender_value);

-- Zaległe wiadomości wychodzące/wewnętrzne nie podlegają klasyfikacji.
update kom_messages set triage = 'inbox' where direction in ('out','internal') and triage is null;
