-- Baza filmu: TREŚĆ i FORMAT każdej rolki (transkrypcja + analiza wizualna Opus).
-- Wzbogaca marketing_organic_posts (metryki z eksportów/scrape'a) o to, CO na
-- filmie się działo — pod atrybucję "który FORMAT sprzedaje", nie która rolka
-- miała fart. Klucz (platform, video_id) spina się z
-- marketing_organic_posts(platform,post_id) i kom_tiktok_stats(video_id).
-- Zasilane skryptem scripts/tiktok-video-base.js. Wzorzec stanu/idempotencji
-- jak kom_attachments (status + error + model_*).
create table if not exists marketing_video_analysis (
  platform          text not null default 'tiktok',
  video_id          text not null,
  url               text,
  caption           text,            -- opis rolki z platformy
  published_at      timestamptz,
  duration_s        int,
  -- transkrypcja
  transcript        text,
  transcript_src    text,            -- 'whisper' | 'tiktok_subs'
  hook              text,            -- pierwsze ~3 s / pierwsze zdanie (do atrybucji)
  model_transcribe  text,
  -- analiza wizualna (Opus po klatkach) — sygnaly formatu w visual jsonb:
  -- {summary,setting,person_on_screen,person_action,product_in_hand,overlay_graphic,
  --  drawn_annotation,before_after,screen_recording,effect_shown,shot_type,
  --  on_screen_text[],beats[],format_guess}
  visual            jsonb,
  frames_n          int,
  model_visual      text,
  -- format (Faza 2 — z taksonomii Antoniego)
  format            text,
  format_source     text,            -- 'manual' | 'auto' | 'auto_confirmed'
  format_conf       real,
  -- stan pipeline'u
  status            text not null default 'pending',  -- pending|enumerated|done|error
  error             text,
  updated_at        timestamptz default now(),
  primary key (platform, video_id)
);
create index if not exists idx_video_analysis_format on marketing_video_analysis (platform, format);
create index if not exists idx_video_analysis_status on marketing_video_analysis (platform, status);
create index if not exists idx_video_analysis_published on marketing_video_analysis (platform, published_at desc);
