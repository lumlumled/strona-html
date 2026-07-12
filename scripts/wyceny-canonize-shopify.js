// Backfill: kanonizacja pozycji w istniejących zamówieniach Shopify
// (source='shopify') do naszego cennika — nazwa, SKU, zdjęcie, jednostka,
// a dla taśm przeliczenie na metry. Logika w apps/shared/server/
// wyceny-shopify-canon.js (ta sama, której używa sync na bieżąco).
//
// Bezpiecznie: DOMYŚLNIE dry-run (pokazuje mapowanie, nic nie zapisuje).
// Zapis dopiero z --apply. Rusza WYŁĄCZNIE kolumnę items; kwoty sprzedaży
// (kwota_*_brutto = totalPrice z Shopify) zostają nietknięte.
//   node scripts/wyceny-canonize-shopify.js            # podgląd
//   node scripts/wyceny-canonize-shopify.js --apply     # zapis
const path = require('path');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'node_modules', 'dotenv')).config({ path: path.join(ROOT, 'apps', 'formularz', 'server', '.env') });
const { createClient } = require(path.join(ROOT, 'node_modules', '@supabase/supabase-js'));
const { canonicalize } = require(path.join(ROOT, 'apps', 'shared', 'server', 'wyceny-shopify-canon'));

const APPLY = process.argv.includes('--apply');

async function buildSkuIndex(db) {
  const { data } = await db.from('sku_cennik').select('sku,nazwa,unit,image_url');
  const bySku = new Map(), byName = new Map();
  (data || []).forEach((s) => { bySku.set(s.sku, s); byName.set(s.nazwa.toLowerCase(), s); });
  return { bySku, byName };
}

async function main() {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const index = await buildSkuIndex(db);
  const { data: orders } = await db.from('wyceny').select('id,items').eq('source', 'shopify');

  const mapping = new Map(); // rawName -> {canon, count, unmatched}
  const unmatched = new Set();
  let ordersChanged = 0;

  for (const o of orders) {
    const before = o.items || [];
    const after = before.map((it) => {
      const canon = canonicalize({ name: it.name, sku: it.SKU, quantity: it.quantity, unitPrice: it.price }, index);
      const key = it.name || '(brak)';
      const e = mapping.get(key) || { canon: canon._unmatched ? '(brak — zostaje)' : canon.name, count: 0 };
      e.count += 1; mapping.set(key, e);
      if (canon._unmatched) unmatched.add(key);
      delete canon._unmatched;
      return canon;
    });
    if (JSON.stringify(after) !== JSON.stringify(before)) ordersChanged += 1;
    o._after = after;
  }

  console.log(`=== MAPOWANIE NAZW (${mapping.size}) — [ilość] "Shopify" -> "nasze" ===`);
  [...mapping.entries()].sort((a, b) => b[1].count - a[1].count).forEach(([raw, e]) => {
    const flag = unmatched.has(raw) ? ' ⚠️ BEZ DOPASOWANIA' : '';
    console.log(`  [${String(e.count).padStart(3)}] "${raw}"\n         -> "${e.canon}"${flag}`);
  });
  console.log(`\nZamówień do zmiany: ${ordersChanged}/${orders.length}`);
  if (unmatched.size) console.log(`Bez dopasowania (${unmatched.size}): ${[...unmatched].join(' | ')}`);

  if (!APPLY) { console.log('\n[dry-run] Nic nie zapisano. Uruchom z --apply.'); return; }

  let done = 0;
  for (const o of orders) {
    if (JSON.stringify(o._after) === JSON.stringify(o.items || [])) continue;
    const { error } = await db.from('wyceny').update({ items: o._after, updated_at: new Date().toISOString() }).eq('id', o.id);
    if (error) throw error;
    done += 1;
  }
  console.log(`\n[apply] Skanonizowano pozycje w ${done} zamówieniach.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
