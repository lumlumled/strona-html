// Dokłada do "Log zmian" kolumnę `sms_wyslany` — ślad auto-SMS-a wysłanego po
// nieodebranym połączeniu (docs/plan-auto-sms-nieodebrane.md). Trzymana OSOBNO
// od `opis` świadomie: opis karmi podsumowanie dnia i opisy case'ów w planie,
// treść SMS-a by je zaśmieciła. Wartość = wysłana treść albo "BŁĄD: {powód}"
// przy nieudanej wysyłce; null = SMS nie wychodził (bramka odmówiła / odebrane).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

// Bezpośredni host db.*.supabase.co jest IPv6-only — łączymy się przez pooler
// (patrz add-temperatura-po-rozmowie.js / sync-leady-from-sheet.js).
function pooledUrl() {
  const url = new URL(process.env.DATABASE_URL);
  const ref = url.hostname.match(/^db\.([^.]+)\.supabase\.co$/)?.[1];
  if (!ref) return process.env.DATABASE_URL;
  return `postgresql://postgres.${ref}:${url.password}@aws-0-eu-west-3.pooler.supabase.com:5432/postgres`;
}

async function main() {
  const client = new Client({ connectionString: pooledUrl() });
  await client.connect();

  await client.query(`alter table "Log zmian" add column if not exists sms_wyslany text`);
  console.log('Kolumna sms_wyslany w "Log zmian" (add if not exists).');

  // Kontrola: webhook po wysyłce robi UPDATE po kluczu `id` — upewnij się,
  // że tabela faktycznie ma taki klucz (i wypisz schemat do wglądu).
  const { rows } = await client.query(`
    select column_name, data_type
    from information_schema.columns
    where table_name = 'Log zmian'
    order by ordinal_position
  `);
  console.log('Schemat "Log zmian":', rows.map((r) => `${r.column_name}:${r.data_type}`).join(', '));
  if (!rows.some((r) => r.column_name === 'id')) {
    throw new Error('Tabela "Log zmian" nie ma kolumny id — update śladu SMS po insercie nie zadziała!');
  }

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
