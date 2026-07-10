// Jednorazowe czyszczenie "Link do formularza" w Leady B2C i Wyceny B2C —
// automatyzacje Make budowały URL z surowego ID wyceny (format "#1852") albo
// z artefaktem escapowania ("''1683"), przez co linki wyglądają jak
// "...formularz?id=#1852" / "...formularz?id=''1683" i nie działają po
// kliknięciu. Usuwamy znaki '#' i "'" z wartości. Front (apps/crm) i tak
// normalizuje linki przy renderowaniu (nowe brudne wpisy z Make nie zepsują
// widoku), ale dane w bazie też mają być czyste.
//
// Idempotentny — drugi przebieg nic nie znajdzie. Triggery Log zmian nie
// reagują na tę kolumnę, więc nie potrzeba flagi bypass.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

async function cleanTable(client, table) {
  const { rows } = await client.query(
    `update "${table}"
     set "Link do formularza" = replace(replace("Link do formularza", '#', ''), '''', '')
     where "Link do formularza" ~ '[#'']'
     returning "Link do formularza"`
  );
  console.log(`${table}: wyczyszczono ${rows.length} linków.`);
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await cleanTable(client, 'Leady B2C');
  await cleanTable(client, 'Wyceny B2C');
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
