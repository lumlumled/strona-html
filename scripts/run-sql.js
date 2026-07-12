// Uruchomienie pliku SQL na bazie Supabase (pooler — host db.* jest IPv6-only).
// Wzorzec połączenia jak w scripts/wyceny-import.js.
// Użycie: node scripts/run-sql.js <plik.sql>
const path = require('path');
const fs = require('fs');
const KOM_SERVER = path.join(__dirname, '..', 'apps', 'komunikator', 'server');
require(path.join(KOM_SERVER, 'node_modules', 'dotenv')).config({ path: path.join(KOM_SERVER, '.env') });
const { Client } = require(path.join(KOM_SERVER, 'node_modules', 'pg'));

function pooledUrl() {
  const url = new URL(process.env.DATABASE_URL);
  const projectRef = url.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/)?.[1];
  if (!projectRef) return process.env.DATABASE_URL;
  return `postgresql://postgres.${projectRef}:${url.password}@aws-0-eu-west-3.pooler.supabase.com:5432/postgres`;
}

async function main() {
  const file = process.argv[2];
  if (!file) { console.error('Użycie: node scripts/run-sql.js <plik.sql>'); process.exit(1); }
  const sql = fs.readFileSync(path.resolve(file), 'utf8');
  const client = new Client({ connectionString: pooledUrl() });
  await client.connect();
  try {
    await client.query(sql);
    console.log(`OK: ${file}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
