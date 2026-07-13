-- Token OAuth Furgonetki (grant password + refresh). Furgonetka ROTUJE
-- refresh_token przy każdym użyciu (single-use), a serverless nie trzyma
-- pamięci między wywołaniami → najświeższy access+refresh musi żyć w bazie.
-- Jeden wiersz (id=1). Bootstrap (jednorazowo, hasło) zasiewa wiersz; runtime
-- odświeża i nadpisuje. NIGDY nie wychodzi poza serwer (jak koszty w sku_cennik).
create table if not exists furgonetka_oauth (
  id integer primary key default 1,
  access_token text,
  refresh_token text,
  access_expires_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint furgonetka_oauth_singleton check (id = 1)
);
