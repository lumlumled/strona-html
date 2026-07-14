// Znacznik "rozmowa w analizie" — webhook Zadarmy wstawia wiersz na czas
// transkrypcji+analizy GPT (odebrane połączenie), panel pokazuje przy tym
// case'ie kręcące się kółko, żeby handlowiec zaraz po odłożeniu słuchawki
// widział, że coś się dzieje (bez zgadywania, czy webhook złapał). Wiersz
// kasuje się po zakończeniu analizy; stale-guard w odczycie ignoruje wpisy
// starsze niż okno analizy (gdyby webhook padł przed usunięciem).
//
// Klucz = telefon (9-cyfrowy/„48…", jak w Log zmian) — jedna rozmowa na numer
// naraz w praktyce wystarcza. Upsert po telefonie odświeża started_at.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query(`
    create table if not exists rozmowy_w_toku (
      telefon text primary key,
      kierunek text,
      started_at timestamptz not null default now()
    );
  `);
  console.log('Tabela rozmowy_w_toku gotowa.');
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
