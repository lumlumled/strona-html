require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const existsResult = await client.query(`select to_regclass('public."Wyceny B2C"') as reg`);
  if (existsResult.rows[0].reg !== null) {
    console.log('Tabela "Wyceny B2C" już istnieje, nic nie tworzę.');
  } else {
    await client.query(`
      create table "Wyceny B2C" (
        id bigint generated always as identity primary key,
        "Data stworzenia" text,
        "Data Feedbacku" text,
        "Komentarz" text,
        "ID" text unique not null,
        "Typ" text,
        "Status" text,
        "Telefon" bigint,
        "Imię" text,
        "Link do formularza" text,
        "Kwota" bigint,
        "Email" text,
        "Partner?" text,
        produkty_json jsonb
      )
    `);
    await client.query(`create index on "Wyceny B2C" ("Telefon")`);
    console.log('Utworzono tabelę "Wyceny B2C" + indeks na Telefon.');
  }

  const seed = {
    dataStworzenia: '26.01.2026',
    id: '#1529',
    typ: 'WYCENA',
    status: 'Open',
    telefon: 48503361672,
    linkFormularza: 'https://lumlum.co/pages/formularz?id=1529',
    kwota: 3220,
    produkty: [
      { name: 'Cyfrowa taśma COB 4000K IP20', SKU: 'LL-TAPE-DIG-COB-4000K-IP20', quantity: 28, unit: 'm', price: '75', VAT: '23' },
      { name: 'Sterownik LumControl', SKU: 'LL-CTRL-LUMCONTROL', quantity: 2, unit: 'szt', price: '350', VAT: '23' },
      { name: 'Zasilacz Mean Well 200W 24V', SKU: 'LL-PSU-MEANWELL-200W-24V', quantity: 1, unit: 'szt', price: '220', VAT: '23' },
      { name: 'Zasilacz 150W 24V', SKU: 'LL-PSU-150W-24V', quantity: 1, unit: 'szt', price: '200', VAT: '23' },
    ],
  };

  const existingRow = await client.query(`select 1 from "Wyceny B2C" where "ID" = $1`, [seed.id]);
  if (existingRow.rowCount > 0) {
    console.log(`Wiersz ${seed.id} już istnieje, nic nie wstawiam.`);
  } else {
    await client.query(
      `insert into "Wyceny B2C" ("Data stworzenia", "ID", "Typ", "Status", "Telefon", "Link do formularza", "Kwota", produkty_json)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [seed.dataStworzenia, seed.id, seed.typ, seed.status, seed.telefon, seed.linkFormularza, seed.kwota, JSON.stringify(seed.produkty)]
    );
    console.log(`Wstawiono wiersz seed ${seed.id}.`);
  }

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
