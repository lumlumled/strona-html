// Odpala migracje SQL Komunikatora na Supabase przez pooler (host db.* jest
// IPv6-only — patrz apps/backlog-b2c/server/scripts/sync-leady-from-sheet.js).
// Użycie: node migrations/run.js [plik.sql...]  (bez argumentów: wszystkie po kolei)
const path = require('path');
const fs = require('fs');
require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', 'server', '.env'),
});
const { Client } = require(path.join(__dirname, '..', 'server', 'node_modules', 'pg'));

function pooledUrl() {
  const url = new URL(process.env.DATABASE_URL);
  const ref = url.hostname.split('.')[1] === 'supabase' ? null : url.hostname.split('.')[0].replace(/^db\./, '');
  const projectRef = url.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/)?.[1] || ref;
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
