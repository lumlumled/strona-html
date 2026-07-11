-- Ustawienia serwera trzymane w bazie (nie w env), bo zmieniają się w runtime:
-- tokeny OAuth Gmaila (refresh token po autoryzacji, odświeżany access token),
-- znaczniki ostatniej synchronizacji itp.
create table if not exists kom_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
