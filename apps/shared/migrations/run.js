// Odpala migracje SQL Bazy Wiedzy (kb_*) na Supabase przez pooler — kopia
// wzorca apps/komunikator/migrations/run.js (db host jest IPv6-only).
// Zależności i .env pożyczamy z serwera Komunikatora (wspólna baza).
// Użycie: node apps/shared/migrations/run.js [plik.sql...]
const path = require('path');
const fs = require('fs');
const KOM_SERVER = path.join(__dirname, '..', '..', 'komunikator', 'server');
require(path.join(KOM_SERVER, 'node_modules', 'dotenv')).config({
  path: path.join(KOM_SERVER, '.env'),
});
const { Client } = require(path.join(KOM_SERVER, 'node_modules', 'pg'));

function pooledUrl() {
  const url = new URL(process.env.DATABASE_URL);
  const projectRef = url.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/)?.[1];
  if (!projectRef) return process.env.DATABASE_URL;
  return `postgresql://postgres.${projectRef}:${url.password}@aws-0-eu-west-3.pooler.supabase.com:5432/postgres`;
}

async function main() {
  const files = process.argv.slice(2).length
    ? process.argv.slice(2)
    : fs.readdirSync(__dirname).filter((f) => f.endsWith('.sql')).sort();
  const client = new Client({ connectionString: pooledUrl() });
  await client.connect();
  try {
    for (const file of files) {
      const sql = fs.readFileSync(path.join(__dirname, path.basename(file)), 'utf8');
      console.log(`→ ${file}`);
      await client.query(sql);
    }
    console.log('OK');
  } finally {
    await client.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
