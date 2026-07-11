// Kolumna "Owner" w "Leady B2C" — właściciel leada (patrz
// docs/plan-wlasnosc-zasobow.md). Wartość = app_users.name ('Lorenzo',
// 'Antoni'…), spójnie z konwencją "Najbliższa akcja owner"/DEFAULT_HANDLOWIEC.
// DEFAULT na kolumnie = JEDYNE miejsce konfiguracji domyślnego ownera nowych
// leadów — obejmuje każdą ścieżkę insertu (webhook Zadarma, Make piszący
// wprost do bazy, przyszłe panele). Zmiana domyślnego handlowca (np. na
// Krzyśka) = `alter table only ... alter column "Owner" set default 'Krzysiek'`.
// Idempotentny; migracja ustawia Lorenzo TYLKO tam, gdzie Owner jest pusty.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

const DEFAULT_OWNER = 'Lorenzo';

// Bezpośredni host db.*.supabase.co jest IPv6-only — łączymy się przez pooler
// (patrz sync-leady-from-sheet.js).
function pooledUrl() {
  const url = new URL(process.env.DATABASE_URL);
  const ref = url.hostname.match(/^db\.([^.]+)\.supabase\.co$/)?.[1];
  if (!ref) return process.env.DATABASE_URL;
  return `postgresql://postgres.${ref}:${url.password}@aws-0-eu-west-3.pooler.supabase.com:5432/postgres`;
}

async function main() {
  const client = new Client({ connectionString: pooledUrl() });
  await client.connect();
  try {
    await client.query(
      `alter table "Leady B2C" add column if not exists "Owner" text default '${DEFAULT_OWNER}'`
    );
    const { rowCount } = await client.query(
      `update "Leady B2C" set "Owner" = $1 where "Owner" is null or btrim("Owner") = ''`,
      [DEFAULT_OWNER]
    );
    const { rows } = await client.query(
      `select "Owner", count(*) from "Leady B2C" group by "Owner" order by count(*) desc`
    );
    console.log(`Zmigrowano ${rowCount} leadów na Owner='${DEFAULT_OWNER}'. Rozkład:`);
    rows.forEach((r) => console.log(`  ${r.Owner ?? '(null)'}: ${r.count}`));

    const users = await client.query(`select id, email, name, role, active from app_users order by id`);
    console.log('app_users:');
    users.rows.forEach((u) => console.log(`  #${u.id} ${u.name} <${u.email}> ${u.role}${u.active ? '' : ' (nieaktywny)'}`));
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
