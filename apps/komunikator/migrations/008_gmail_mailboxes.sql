-- Skrzynki e-mail per użytkownik (multi-user Gmail).
-- Każdy użytkownik hubu może mieć podłączoną własną skrzynkę: kontakt@lumlum.co
-- należy do Antoniego, przyszła skrzynka Lorenza do Lorenza. Wątek e-mail
-- pamięta w meta.gmail.mailbox, z której skrzynki przyszedł, i przez nią
-- wychodzi odpowiedź. app_user_id otwiera drogę do widoków per user
-- (Komunikator, CRM, Backlog B2C) bez zmian schematu.
create table if not exists kom_mailboxes (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'gmail',
  email text not null unique,
  app_user_id bigint references app_users(id),
  tokens jsonb not null default '{}'::jsonb, -- refresh_token, access_token, expires_at
  watch jsonb,                               -- stan users.watch (push Pub/Sub)
  active boolean not null default true,
  connected_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Przenieś dotychczasowe pojedyncze połączenie (kom_settings 'gmail_oauth').
-- Przypisanie: app_user o tym samym adresie, a gdy go nie ma - admin (Antoni).
-- Stary wiersz w kom_settings zostaje jako zapas; kod czyta już tylko tę tabelę.
insert into kom_mailboxes (email, tokens, watch, connected_at, app_user_id)
select
  lower(value->>'email'),
  jsonb_strip_nulls(jsonb_build_object(
    'refresh_token', value->'refresh_token',
    'access_token', value->'access_token',
    'expires_at', value->'expires_at'
  )),
  value->'watch',
  nullif(value->>'connected_at', '')::timestamptz,
  coalesce(
    (select id from app_users where lower(email) = lower(value->>'email') limit 1),
    (select id from app_users where role = 'admin' order by id limit 1)
  )
from kom_settings
where key = 'gmail_oauth' and value ? 'refresh_token'
on conflict (email) do nothing;
