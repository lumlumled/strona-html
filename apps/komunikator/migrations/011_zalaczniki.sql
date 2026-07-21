-- Załączniki wiadomości (zdjęcia/wideo/audio/pliki z Messengera, IG i Gmaila).
-- Dotąd leżały tylko jako surowe URL-e w kom_messages.meta.attachments, a linki
-- CDN Mety wygasają po paru dniach — stąd trwała kopia w Supabase Storage
-- (bucket kom-media) + analiza AI (opis zdjęcia/rzutu technicznego, transkrypcja
-- filmu), którą panel pokazuje przy załączniku, a sugestie dostają w kontekście.
create table if not exists kom_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references kom_messages(id) on delete cascade,
  thread_id uuid not null references kom_threads(id) on delete cascade,
  position int not null default 0,
  type text not null default 'file',           -- image/video/audio/file/sticker/fallback
  mime text,
  original_url text,                            -- URL źródłowy (CDN Mety — wygasa)
  source jsonb,                                 -- np. {"gmail":{mailbox,gmailMessageId,attachmentId}}
  filename text,
  title text,                                   -- tytuł share'a (reel/link) z payloadu
  storage_path text,                            -- ścieżka w buckecie kom-media po pobraniu
  size_bytes bigint,
  status text not null default 'pending'
    check (status in ('pending','fetching','stored','expired','failed','skipped')),
  fetch_attempts int not null default 0,
  fetch_error text,
  ai_status text not null default 'pending'
    check (ai_status in ('pending','running','done','failed','skipped')),
  ai_attempts int not null default 0,
  ai_summary text,                              -- krótki opis do panelu i promptów
  ai_data jsonb,                                -- pełna analiza (fakty, wymiary, transkrypcja, niepewności)
  ai_model text,
  ai_error text,
  ai_corrected boolean not null default false,  -- opis poprawiony ręcznie w panelu
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists kom_attachments_msg_pos on kom_attachments(message_id, position);
create index if not exists kom_attachments_thread on kom_attachments(thread_id);
create index if not exists kom_attachments_fetch_todo on kom_attachments(created_at)
  where status in ('pending','fetching');
create index if not exists kom_attachments_ai_todo on kom_attachments(created_at)
  where ai_status in ('pending','running');
