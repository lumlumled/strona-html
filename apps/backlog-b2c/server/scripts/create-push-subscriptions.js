// Tworzy tabelę `push_subscriptions` — urządzenia zapisane na powiadomienia
// Web Push (docs/plan-powiadomienia-push.md). Jeden user (app_users) może
// mieć wiele urządzeń; endpoint jest unikalny globalnie (przeglądarka wydaje
// jeden na instalację). Wiersz kasujemy, gdy push service odpowie 404/410
// (subskrypcja wygasła/cofnięta) — patrz apps/shared/server/push.js.
// Skrypt żyje tu obok create-app-users.js (ta sama baza i wzorzec pooledUrl).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

function pooledUrl() {
  const url = new URL(process.env.DATABASE_URL);
  const ref = url.hostname.match(/^db\.([^.]+)\.supabase\.co$/)?.[1];
  if (!ref) return process.env.DATABASE_URL;
  return `postgresql://postgres.${ref}:${url.password}@aws-0-eu-west-3.pooler.supabase.com:5432/postgres`;
}

async function main() {
  const client = new Client({ connectionString: pooledUrl() });
  await client.connect();

  await client.query(`
    create table if not exists push_subscriptions (
      id serial primary key,
      user_id integer not null references app_users(id) on delete cascade,
      endpoint text not null unique,
      p256dh text not null,
      auth text not null,
      user_agent text,
      created_at timestamptz not null default now(),
      last_used_at timestamptz
    );
    create index if not exists push_subscriptions_user_idx on push_subscriptions(user_id);
  `);
  console.log('Tabela push_subscriptions utworzona (lub już istniała).');

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
