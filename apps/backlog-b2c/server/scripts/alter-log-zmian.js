// Dokłada do "Log zmian" kolumny na dziennik aktywności handlowca: kierunek
// połączenia, pełna transkrypcja (dziś liczona w webhooku i gubiona po
// streszczeniu), snapshoty notatek/daty feedbacku przed i po (analogicznie do
// istniejących status_przed/status_po), oraz sip/handlowiec (na razie
// niewypełniane przez lookup — patrz plan, sekcja "Do zrobienia później").
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  await client.query(`
    alter table "Log zmian"
      add column if not exists kierunek text,
      add column if not exists sip text,
      add column if not exists handlowiec text,
      add column if not exists transkrypcja text,
      add column if not exists opis_przed text,
      add column if not exists opis_po text,
      add column if not exists data_feedbacku_przed text,
      add column if not exists data_feedbacku_po text
  `);
  console.log('Kolumny dziennika aktywności dodane do "Log zmian" (lub już istniały).');

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
