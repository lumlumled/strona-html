-- Marketing / Organik (grupa F) — historyczne statystyki social z eksportów
-- Meta/TikTok (rok 07.2025–07.2026). Zasilane skryptem ETL z CSV
-- (FB UTF-16 dzienne, IG per-post, TikTok per-video + dzienne).
-- UWAGA: tabele SĄ JUŻ UTWORZONE na prod 2026-07-13 (przez pg z ETL);
-- ten plik = dokumentacja/reprodukowalność schematu.

-- Dzienne serie per platforma (facebook / tiktok). metrics jsonb, bo każda
-- platforma daje inny zestaw pól (FB: views/interactions/new_followers/visits/
-- link_clicks; TikTok: views/reach/profile_views/likes/shares/comments/
-- leads/website_clicks/phone_clicks/new_followers/lost_followers/total_followers/engaged).
create table if not exists marketing_organic_daily (
  platform    text not null,
  date        date not null,
  metrics     jsonb not null default '{}',
  updated_at  timestamptz default now(),
  primary key (platform, date)
);

-- Per-post / per-video (instagram / tiktok). Kolumny wprost, bo zestaw wspólny.
create table if not exists marketing_organic_posts (
  platform     text not null,
  post_id      text not null,
  account      text,
  url          text,
  title        text,
  published_at timestamptz,
  duration_s   int,
  views        bigint,
  reach        bigint,
  likes        bigint,
  comments     bigint,
  shares       bigint,
  saves        bigint,
  follows      bigint,
  updated_at   timestamptz default now(),
  primary key (platform, post_id)
);

create index if not exists idx_organic_posts_published on marketing_organic_posts (platform, published_at desc);
create index if not exists idx_organic_daily_date on marketing_organic_daily (date);
