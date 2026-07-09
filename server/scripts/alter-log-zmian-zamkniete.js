// Dokłada do "Log zmian" kolumnę na wynik automatycznej oceny GPT z webhooka
// Zadarmy: czy temat jest "zaopiekowany na dziś" (nie trzeba nic więcej robić
// z tym case'em dzisiaj) — patrz analyzeCall/zamkniete_dzis w server.js.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  await client.query(`
    alter table "Log zmian"
      add column if not exists zamkniete_dzis boolean
  `);
  console.log('Kolumna zamkniete_dzis dodana do "Log zmian" (lub już istniała).');

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
