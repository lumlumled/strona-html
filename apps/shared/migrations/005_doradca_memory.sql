-- Pamięć AI-doradcy Fable (docs/statystyki-doradca-build-guardrails.md §5 pkt
-- "Pamięć" + fable §9 pkt 6 "Co pomijasz"). SCHEMAT ZAPROJEKTOWANY OD RAZU;
-- proaktywność (cron „plan na dziś" + tygodniowe „Co pomijasz" → push) to
-- DOKŁADKA po v0 — TU nie ma jeszcze cronu ani triggerów, tylko tabela.
--
-- Trzy rodzaje wpisów, których doradca potrzebuje do accountability:
--   ustalenie  — co ustaliliśmy (decyzja/kierunek)
--   obietnica  — co Antoni obiecał zrobić (z terminem) → rytuał dzienny dopytuje
--   odkladane  — rzecz świadomie odkładana → tygodniowe „Co pomijasz"
--
-- Cykl życia: open (resolved_at is null) -> resolved (done/dropped/superseded).

create table if not exists doradca_memory (
  id bigserial primary key,
  owner text,                               -- app_users.name (domyślnie Antoni)
  kind text not null check (kind in ('ustalenie','obietnica','odkladane')),
  tekst text not null,                      -- treść ustalenia/obietnicy/odkładanej rzeczy
  due_at timestamptz,                       -- termin (dla obietnic; null = bez terminu)
  status text not null default 'open' check (status in ('open','done','dropped','superseded')),
  source text,                              -- 'czat'|'rytual_dzienny'|'rytual_tygodniowy'|'ai'
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Szybkie „co otwarte dla Antoniego" (rytuał dzienny/tygodniowy).
create index if not exists doradca_memory_open_idx
  on doradca_memory (owner, kind, due_at) where status = 'open';
