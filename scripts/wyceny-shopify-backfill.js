// Backfill zamówień Shopify do wycen z pliku JSON (wynik zapytania GraphQL
// orders — ten sam kształt co ORDERS_QUERY w wyceny-shopify.js). Używany
// jednorazowo przy migracji (dane pobrane przez MCP); bieżący sync robi
// worker z SHOPIFY_ADMIN_TOKEN.
// Użycie: node scripts/wyceny-shopify-backfill.js <plik.json> [plik2.json...]
const path = require('path');
const fs = require('fs');
const FORM_SERVER = path.join(__dirname, '..', 'apps', 'formularz', 'server');
require(path.join(__dirname, '..', 'node_modules', 'dotenv')).config({ path: path.join(FORM_SERVER, '.env') });
const { createClient } = require(path.join(__dirname, '..', 'node_modules', '@supabase/supabase-js'));
const { orderToRow, upsertOrder, buildSkuIndex } = require(path.join(__dirname, '..', 'apps', 'shared', 'server', 'wyceny-shopify'));

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) throw new Error('Podaj pliki JSON z zamówieniami');
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const skuIndex = await buildSkuIndex(db);
  let created = 0, updated = 0;
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const orders = data.data?.orders?.nodes || data.orders?.nodes || data;
    for (const order of orders) {
      const result = await upsertOrder(db, orderToRow(order, skuIndex));
      if (result.created) created += 1; else updated += 1;
    }
  }
  console.log(`OK — utworzono ${created}, zaktualizowano ${updated}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
