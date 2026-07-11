-- Dzienny snapshot statystyk filmików TikTok (z porannego listingu profilu,
-- decyzja Antoniego 2026-07-11: "statystyki raz dziennie wystarczy").
-- Bez UI na razie — dane zbierają się pod przyszły panel raportowy.
-- Rejestr pełni też rolę źródła "świeżych filmików" (published_at ≥ now-48h)
-- dla godzinowego skanu komentarzy.
create table if not exists kom_tiktok_stats (
  video_id     text not null,
  date         date not null,
  url          text,
  published_at timestamptz,
  plays        integer,
  likes        integer,
  comments     integer,
  shares       integer,
  saves        integer,
  captured_at  timestamptz not null default now(),
  primary key (video_id, date)
);
