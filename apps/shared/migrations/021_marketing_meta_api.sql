-- 021 — Faza 3: Meta Graph API (FB Page + IG Business): żywe metryki per-post + backfill.
-- Rozszerza marketing_organic_posts o bogatsze pola IG (media insights) i proweniencję,
-- dokłada log pobrań. Wszystko ADDYTYWNE i idempotentne. Patrz: project_faza3_meta_api.

-- Per-post (głównie Instagram z Graph API; TikTok zostaje z Apify).
alter table marketing_organic_posts add column if not exists metrics             jsonb not null default '{}'::jsonb; -- pełny surowy zestaw insightów (saved/plays/views/watch_time/retencja…)
alter table marketing_organic_posts add column if not exists source              text;         -- 'meta_api' | 'csv' | 'apify'
alter table marketing_organic_posts add column if not exists fetched_at          timestamptz;  -- ostatni pull z API (świeżość → dane_do)
alter table marketing_organic_posts add column if not exists media_type          text;         -- IG: VIDEO / IMAGE / CAROUSEL_ALBUM
alter table marketing_organic_posts add column if not exists media_product_type  text;         -- IG: FEED / REELS
alter table marketing_organic_posts add column if not exists thumbnail_url       text;         -- IG miniatura (okładka do katalogu)

-- Dzienne serie: proweniencja (FB/IG daily z API vs stary jednorazowy CSV).
alter table marketing_organic_daily add column if not exists source     text;
alter table marketing_organic_daily add column if not exists fetched_at timestamptz;

-- Log pobrań Meta (diagnostyka cotygodniowego crona + backfillu).
create table if not exists marketing_meta_pull_log (
  id           bigserial primary key,
  platform     text not null,       -- 'instagram' | 'facebook'
  kind         text not null,       -- 'backfill' | 'weekly'
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  posts_seen   int,
  posts_upsert int,
  daily_upsert int,
  ok           boolean,
  error        text
);
create index if not exists idx_meta_pull_log_started on marketing_meta_pull_log (started_at desc);

-- supabase-js/PostgREST widzi nowe kolumny/tabele dopiero po reloadzie schematu.
notify pgrst, 'reload schema';
