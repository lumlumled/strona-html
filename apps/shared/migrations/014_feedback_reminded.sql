-- Punktualne przypomnienie o umówionym feedbacku (osobne od alertu watchdoga).
-- Gdy klient sam ustali termin (np. odpisze SMS-em "proszę o telefon dziś 16:00"),
-- chcemy pingnąć ownera DOKŁADNIE o tej godzinie ("zadzwoń teraz"), niezależnie
-- od późniejszego "temat ucieka" watchdoga (ten leci co 30 min, gdy termin już
-- minął). Żeby dedykowany cron (co ~5 min) nie przypominał w kółko, znaczymy
-- wysłane przypomnienie osobną kolumną reminded_at — celowo NIE reused alerted_at
-- watchdoga, żeby oba mechanizmy działały niezależnie na tym samym watchu.
alter table feedback_watch add column if not exists reminded_at timestamptz;

-- Cron bierze świeżo wymagalne watche (due_at w krótkim oknie wstecz) i tylko te
-- bez reminded_at — indeks trzyma to zapytanie tanie mimo częstego odpytywania.
create index if not exists feedback_watch_reminder_idx
  on feedback_watch (due_at)
  where resolved_at is null and reminded_at is null;
