-- Historia czatów AI-doradcy Fable (apps/doradca). Dotąd był JEDEN wątek w
-- localStorage (doradca_watek_v1) — bez rozdzielenia rozmów i bez synchronizacji
-- między urządzeniami. Ta tabela daje osobne, nazwane rozmowy per owner,
-- widoczne na telefonie i na kompie (source of truth = Supabase).
--
-- Trzyma też per-rozmowa: ostatnio wybrany MODEL (klucz UI) i DODATKOWY KONTEKST
-- (wklejony/wgrany tekst — np. marże, cennik, CSV z Excela), żeby doradca miał
-- go pod ręką przy każdej turze tej konkretnej rozmowy.

create table if not exists doradca_chaty (
  id bigserial primary key,
  owner text,                                   -- app_users.name (domyślnie Antoni)
  tytul text,                                   -- z pierwszej wiadomości (edytowalny)
  messages jsonb not null default '[]'::jsonb,  -- [{role:'user'|'assistant', content}]
  model text,                                   -- ostatnio wybrany model (klucz UI: 'fable-5'|'opus-4-8'|...)
  kontekst text,                                -- dodatkowy kontekst (wklejony/wgrany)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Lista „ostatnie rozmowy" per owner (sidebar historii).
create index if not exists doradca_chaty_owner_idx
  on doradca_chaty (owner, updated_at desc);
