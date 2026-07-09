// Dokłada do "Leady B2C" kolumnę "Źródło" — oznacza leady, które webhook
// Zadarmy stworzył automatycznie dla numeru bez dopasowania w bazie (patrz
// /api/webhooks/zadarma i kategoria "rozmowy_spoza_bazy" w /api/cron/umowa-draft).
// NULL dla normalnych leadów (Facebook Lead Ads przez Make) — nic tu nie zmienia.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  await client.query(`alter table "Leady B2C" add column if not exists "Źródło" text`);
  console.log('Kolumna "Źródło" dodana do "Leady B2C" (lub już istniała).');

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
