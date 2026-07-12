// Dokłada do "Leady B2C" kolumnę jsonb "marketing_meta" — kontekst pozyskania
// leada z Facebook Lead Ads (platform, kampania/adset/reklama: id + nazwy,
// isOrganic, formId, dateCreated). Zapisuje ją webhook /api/webhooks/lead;
// służy późniejszej analizie marketingowej (grupowanie po kampanii/adsecie,
// spięcie z wydatkami) w panelu analiz. NULL dla leadów spoza FB — nic nie psuje.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  await client.query(`alter table "Leady B2C" add column if not exists "marketing_meta" jsonb`);
  console.log('Kolumna "marketing_meta" (jsonb) dodana do "Leady B2C" (lub już istniała).');

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
