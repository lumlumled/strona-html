// Tworzy tabelę `app_users` (indywidualne konta narzędzi lumlum.dev — patrz
// apps/shared/server/auth.js) i seeduje konto główne Antoniego jako admina.
// Idempotentny: istniejąca tabela/konto nie są nadpisywane. Startowe hasło
// admina = obecne SITE_PASSWORD (do zmiany po zalogowaniu w panelu Pozwolenia),
// chyba że podasz inne: node create-app-users.js --admin-password 'xyz'
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');
const { hashPassword } = require('../../../shared/server/auth');

const ADMIN_EMAIL = 'antoni.chodurski@gmail.com';
const ADMIN_NAME = 'Antoni';

// Bezpośredni host db.*.supabase.co jest IPv6-only — łączymy się przez pooler
// (patrz sync-leady-from-sheet.js).
function pooledUrl() {
  const url = new URL(process.env.DATABASE_URL);
  const ref = url.hostname.match(/^db\.([^.]+)\.supabase\.co$/)?.[1];
  if (!ref) return process.env.DATABASE_URL;
  return `postgresql://postgres.${ref}:${url.password}@aws-0-eu-west-3.pooler.supabase.com:5432/postgres`;
}

async function main() {
  const argIdx = process.argv.indexOf('--admin-password');
  const adminPassword = argIdx !== -1 ? process.argv[argIdx + 1] : process.env.SITE_PASSWORD;
  if (!adminPassword) {
    throw new Error('Brak hasła startowego admina (SITE_PASSWORD w .env albo --admin-password)');
  }

  const client = new Client({ connectionString: pooledUrl() });
  await client.connect();

  await client.query(`
    create table if not exists app_users (
      id serial primary key,
      email text not null unique,
      name text not null,
      password_hash text not null,
      role text not null default 'user',
      permissions jsonb not null default '{}'::jsonb,
      active boolean not null default true,
      created_at timestamptz not null default now()
    )
  `);
  console.log('Tabela app_users gotowa (utworzona lub już istniała).');

  const { rows } = await client.query('select id, role from app_users where lower(email) = lower($1)', [ADMIN_EMAIL]);
  if (rows.length) {
    console.log(`Konto ${ADMIN_EMAIL} już istnieje (id=${rows[0].id}, role=${rows[0].role}) — bez zmian.`);
  } else {
    const hash = hashPassword(adminPassword);
    const insert = await client.query(
      `insert into app_users (email, name, password_hash, role, permissions)
       values ($1, $2, $3, 'admin', '{}'::jsonb) returning id`,
      [ADMIN_EMAIL, ADMIN_NAME, hash]
    );
    console.log(`Utworzono konto admina ${ADMIN_EMAIL} (id=${insert.rows[0].id}). Hasło startowe = ${argIdx !== -1 ? 'podane w --admin-password' : 'obecne SITE_PASSWORD'}.`);
  }

  await client.end();
}

main().catch((err) => {
  console.error('Błąd migracji app_users:', err.message);
  process.exit(1);
});
