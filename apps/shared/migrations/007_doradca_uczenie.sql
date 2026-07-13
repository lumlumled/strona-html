-- Uczenie AI-doradcy: rozszerzenie pamięci (005_doradca_memory.sql) o TRWAŁĄ
-- WIEDZĘ/preferencje wyciąganą z rozmów ("uczy się na podstawie odpowiedzi") +
-- licznik potwierdzeń (ten sam fakt wychodzący wielokrotnie = pewniejszy).
--
-- 005 miał kind ∈ {ustalenie, obietnica, odkladane}. Dokładamy 'wiedza':
--   wiedza — trwały fakt/preferencja o Antonim lub firmie, którego doradca ma
--            używać w kolejnych rozmowach zamiast dopytywać (np. "nie chce
--            podnosić cen", "handlowiec = Lorenzo", "woli ruchy asymetryczne").

alter table doradca_memory drop constraint if exists doradca_memory_kind_check;
alter table doradca_memory
  add constraint doradca_memory_kind_check
  check (kind in ('ustalenie','obietnica','odkladane','wiedza'));

-- Ile razy ten wpis wypłynął z rozmów — reinforcement; przy dedupe bumpujemy
-- zamiast tworzyć duplikat.
alter table doradca_memory
  add column if not exists potwierdzenia int not null default 1;

-- Ostatni raz, gdy fakt się potwierdził (świeżość — stare, niepotwierdzane
-- fakty można z czasem wygaszać). Domyślnie = created_at dla istniejących.
alter table doradca_memory
  add column if not exists last_seen_at timestamptz;
update doradca_memory set last_seen_at = coalesce(last_seen_at, created_at) where last_seen_at is null;
