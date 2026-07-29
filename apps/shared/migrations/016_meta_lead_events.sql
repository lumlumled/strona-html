-- ── Meta CAPI: ślad zdarzeń na poziomie LEADA ───────────────────────────────
-- Decyzja Antoniego 2026-07-29: kampania Lead Ads (Conversion Leads) pokazuje 0,
-- bo jedyny wczesny sygnał jakości dosyłany do Meta to "Wycena wysłana" — a ten
-- pada głęboko w lejku i rzadko. Dokładamy DUŻO wcześniejsze, częste zdarzenie
-- "Kontakt jakościowy" (odebrana rozmowa, która NIE skończyła się odmową/złym
-- numerem), pod które kampania może się realnie optymalizować.
--
-- Dedup istniejący (wyceny_events) jest keyowany na wycenę — a "Kontakt
-- jakościowy" pada ZANIM w ogóle jest wycena. Dlatego osobny, lekki ślad na
-- poziomie leada: raz na leada na dany etap Meta. `unique(lead_id, kind)` daje
-- twardą idempotencję nawet przy wyścigu dwóch webhooków.
create table if not exists meta_lead_events (
  id bigserial primary key,
  lead_id bigint not null,                   -- "Leady B2C"."ID Leada"
  kind text not null,                        -- np. meta.kontakt_jakosciowy
  payload jsonb,
  created_at timestamptz not null default now(),
  unique (lead_id, kind)
);

create index if not exists meta_lead_events_lead_idx on meta_lead_events (lead_id, kind);
