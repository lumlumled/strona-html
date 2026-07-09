require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const existsResult = await client.query(`
    select to_regclass('public."Logi automatyzacji"') as reg
  `);
  const alreadyExists = existsResult.rows[0].reg !== null;

  if (alreadyExists) {
    console.log('Tabela "Logi automatyzacji" już istnieje, nic nie robię.');
  } else {
    await client.query(`
      create table "Logi automatyzacji" (
        id bigint generated always as identity primary key,
        czas timestamptz not null default now(),
        automatyzacja text not null,
        status text not null,
        szczegoly jsonb
      )
    `);
    await client.query(`create index on "Logi automatyzacji" (czas)`);
    await client.query(`create index on "Logi automatyzacji" (automatyzacja)`);
    console.log('Utworzono tabelę "Logi automatyzacji" + indeksy na czas i automatyzacja.');
  }

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
