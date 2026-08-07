-- Atrybucja "skąd klient nas zna" z rozmów telefonicznych (decyzja Antoniego
-- 07.08.2026, po werdykcie Rady AI: atrybucja z ust klienta zamiast zgadywania
-- z agregatów). AI analizujące transkrypcje (webhook Zadarmy, rozmowa ręczna,
-- backfill po Log zmian) wyławia deklarację źródła ("zobaczyłem Was na
-- Facebooku", "obserwuję na Instagramie") oraz opis konkretnego filmu ("ten o
-- ledach na schodach") i dopasowuje opis do bazy rolek
-- (marketing_video_analysis) jako KANDYDATÓW z pewnością — nigdy jako pewnik.
-- Tabela = źródło prawdy analitycznej (per zdarzenie, pod panel /kreacje);
-- kolumna "Skąd nas zna" na Leady B2C / kontakty_organic to tylko
-- denormalizacja do wyświetlenia na karcie leada.
create table if not exists lead_zrodla_poznania (
  id             bigserial primary key,
  telefon        text not null,
  zrodlo_kod     text not null,     -- tiktok|instagram|facebook|youtube|social|google|polecenie|reklama|inne
  obserwuje      boolean default false, -- "obserwuję Was" = stały widz, nie jednorazowe trafienie
  cytat          text,              -- co (możliwie dosłownie) padło w rozmowie — dowód
  film_opis      text,              -- jak klient opisał film (null, gdy nie opisał)
  film_kandydaci jsonb,             -- [{platform,video_id,url,format,pewnosc,dlaczego}] max 3
  film_format    text,              -- slug formatu kreacji z najlepszego dopasowania
  wykryto_via    text not null default 'zadarma', -- zadarma|reczna|backfill
  log_zmian_id   bigint,            -- rozmowa źródłowa ("Log zmian".id), jeśli znana
  created_at     timestamptz default now()
);
create index if not exists idx_zrodla_poznania_telefon on lead_zrodla_poznania (telefon);
create index if not exists idx_zrodla_poznania_kod on lead_zrodla_poznania (zrodlo_kod);
create index if not exists idx_zrodla_poznania_format on lead_zrodla_poznania (film_format);
-- Idempotencja backfillu: jedna detekcja per rozmowa źródłowa.
create unique index if not exists idx_zrodla_poznania_log
  on lead_zrodla_poznania (log_zmian_id) where log_zmian_id is not null;

alter table "Leady B2C" add column if not exists "Skąd nas zna" text;
alter table kontakty_organic add column if not exists skad_nas_zna text;
