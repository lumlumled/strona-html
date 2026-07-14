// Migracja 008: kolumna wyceny.packed_at (krok "spakowane" w Fulfillment).
// Znacznik ustawiany ręcznie przyciskiem "Oznacz spakowane" — paczka fizycznie
// spakowana, czeka na kuriera. Additive/nullable, nic w pipeline tego nie czyta.
// Idempotentna (add column if not exists).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

// Bezpośredni host db.*.supabase.co jest IPv6-only — łączymy się przez pooler
// (patrz add-owner-leady.js / sync-leady-from-sheet.js).
function pooledUrl() {
  const url = new URL(process.env.DATABASE_URL);
  const ref = url.hostname.match(/^db\.([^.]+)\.supabase\.co$/)?.[1];
  if (!ref) return process.env.DATABASE_URL;
  return `postgresql://postgres.${ref}:${url.password}@aws-0-eu-west-3.pooler.supabase.com:5432/postgres`;
}

async function main() {
  const client = new Client({ connectionString: pooledUrl() });
  await client.connect();
  try {
    await client.query('alter table wyceny add column if not exists packed_at timestamptz');
    const { rows } = await client.query(
      "select count(*) filter (where packed_at is not null) as spakowane, count(*) as total from wyceny"
    );
    console.log(`OK: wyceny.packed_at gotowe. Oznaczonych spakowanych: ${rows[0].spakowane} / ${rows[0].total}.`);
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
