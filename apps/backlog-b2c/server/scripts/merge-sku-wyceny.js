// Backfill: scalanie pozycji o tym samym SKU w istniejących wycenach.
// Odpowiednik front-endowego mergeBySku (apps/shared/wycena-editor.js) — te
// same SKU rozbite na osobne wiersze łączymy w jeden × suma ilości. Suma
// pozycji Σ(price×quantity) się NIE zmienia (ta sama cena per SKU), więc
// kwota/rabat/faktury pozostają nietknięte. Pozycje bez SKU (spoza oferty)
// zostają osobno.
//
// Domyślnie DRY-RUN (tylko raport). Z flagą --apply zapisuje, po uprzednim
// zrzucie oryginalnych items do backup-items-merge-sku-*.json (odwracalne).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// Host db.*.supabase.co jest IPv6-only — łączymy się przez pooler.
function pooledUrl() {
  const url = new URL(process.env.DATABASE_URL);
  const ref = url.hostname.match(/^db\.([^.]+)\.supabase\.co$/)?.[1];
  if (!ref) return process.env.DATABASE_URL;
  return `postgresql://postgres.${ref}:${url.password}@aws-0-eu-west-3.pooler.supabase.com:5432/postgres`;
}

function money(v) {
  const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function mergeBySku(list) {
  const out = [];
  const byKey = new Map();
  (list || []).forEach((raw) => {
    const p = { ...raw };
    const sku = String(p.SKU || p.sku || '').trim();
    // Klucz = SKU + cena. Ten sam produkt w dwóch różnych cenach (np. druga
    // partia z rabatem) NIE jest łączony — inaczej suma pozycji by się zmieniła.
    const key = sku ? `${sku}|${money(p.price)}` : '';
    if (key && byKey.has(key)) {
      const ex = byKey.get(key);
      ex.quantity = (money(ex.quantity) || 0) + (money(p.quantity) || 0);
      return;
    }
    if (key) byKey.set(key, p);
    out.push(p);
  });
  return out;
}

const sumaPoz = (arr) => (arr || []).reduce((a, p) => a + money(p.price) * (money(p.quantity) || 0), 0);
const APPLY = process.argv.includes('--apply');

async function main() {
  const client = new Client({ connectionString: pooledUrl() });
  await client.connect();
  try {
    const { rows } = await client.query('select id, status, process_stage, items from wyceny');

    const changed = [];
    for (const r of rows) {
      const items = Array.isArray(r.items) ? r.items : [];
      if (items.length < 2) continue;
      const merged = mergeBySku(items);
      if (merged.length < items.length) {
        changed.push({ id: r.id, status: r.status, before: items, after: merged });
      }
    }

    console.log(`Wyceny ogółem:                 ${rows.length}`);
    console.log(`Do scalenia (duplikaty SKU):   ${changed.length}`);

    const byStatus = {};
    changed.forEach((c) => { byStatus[c.status] = (byStatus[c.status] || 0) + 1; });
    console.log('Wg statusu:', JSON.stringify(byStatus));

    // Kontrola bezpieczeństwa: suma pozycji NIE może się zmienić.
    let mismatch = 0;
    changed.forEach((c) => {
      if (Math.abs(sumaPoz(c.before) - sumaPoz(c.after)) > 0.005) {
        mismatch++;
        console.log(`  ⚠ #${c.id}: suma pozycji ${sumaPoz(c.before).toFixed(2)} -> ${sumaPoz(c.after).toFixed(2)}`);
      }
    });
    console.log(`Rozjazd sumy pozycji:          ${mismatch} (musi być 0)`);

    console.log('\nPrzykłady (max 10):');
    changed.slice(0, 10).forEach((c) => {
      console.log(`  #${c.id} [${c.status}]  ${c.before.length} -> ${c.after.length} poz.`);
    });

    if (mismatch > 0) {
      console.log('\nPRZERWANO: wykryto rozjazd sumy pozycji. Nic nie zapisano.');
      process.exitCode = 1;
      return;
    }

    if (!APPLY) {
      console.log('\nDRY-RUN — nic nie zapisano. Uruchom z --apply, aby scalić.');
      return;
    }

    if (changed.length) {
      const backupPath = path.join(__dirname, `backup-items-merge-sku-${changed.length}.json`);
      fs.writeFileSync(backupPath, JSON.stringify(changed.map((c) => ({ id: c.id, before: c.before })), null, 2));
      console.log(`\nBackup oryginalnych items: ${backupPath}`);
    }

    let done = 0;
    for (const c of changed) {
      await client.query('update wyceny set items = $1::jsonb where id = $2', [JSON.stringify(c.after), c.id]);
      done++;
    }
    console.log(`Zapisano: ${done} wycen scalonych.`);
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
