// Tworzy tabelę `kontakty_organic` — kubełek na rozmowy z osobami SPOZA
// Leady B2C (docs/plan-kontakt-karta-leada.md, szybkie dodawanie rozmowy).
// Decyzja Antoniego 2026-07-14: ktoś dzwoni "z ulicy" (organic), rozmowa
// jest zapisywana i analizowana jak u leada, ale NIE zaśmieca Leady B2C —
// trafia tu, ze źródłem (domyślnie 'organic'). Promocja do leada = temat v2.
//
// Kolumny celowo lustrzane wobec pól leada, które zasila analiza rozmowy
// (status/ocena_ai/historia/najbliższa akcja) — ta sama analiza, inny kubełek.
// `telefon` = same cyfry (jak Log zmian.telefon), unikalny: jeden numer =
// jeden kontakt organic.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

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

  await client.query(`
    create table if not exists kontakty_organic (
      id bigint generated always as identity primary key,
      telefon text not null unique,
      imie text,
      zrodlo text not null default 'organic',
      status text,
      ocena_ai text,
      historia_rozmow text,
      tresc_rozmowy text,
      najblizsza_akcja text,
      najblizsza_akcja_termin text,
      najblizsza_akcja_owner text,
      ilosc_rozmow int not null default 0,
      ostatni_kontakt text,
      owner text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
  console.log('Tabela kontakty_organic utworzona (lub już istniała).');

  await client.end();
}

main().catch((err) => {
  console.error('Błąd migracji:', err);
  process.exit(1);
});
