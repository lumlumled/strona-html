// Import katalogu SKU do Bazy Wiedzy (kb_facts) z CSV arkusza
// "CRM LumLum 2.0 - SKU". Idempotentny: przed wstawieniem usuwa fakty
// z poprzedniego importu (source_ref->>kind = 'sku_csv').
//
// Na każdy produkt powstają maks. 2 fakty:
//   public — nazwa, SKU, kategoria, cena brutto, VAT, waga, link do zdjęcia
//            (to samo widzi klient na sklepie; zasila wyceny i sugestie)
//   owner  — koszt zakupu netto, sprzedaż netto, marża (NIGDY dla team)
//
// Użycie: node scripts/kb-import-sku.js "/ścieżka/do/SKU.csv"
const path = require('path');
const fs = require('fs');
const KOM_SERVER = path.join(__dirname, '..', 'apps', 'komunikator', 'server');
require(path.join(KOM_SERVER, 'node_modules', 'dotenv')).config({ path: path.join(KOM_SERVER, '.env') });
const { createClient } = require(path.join(KOM_SERVER, 'node_modules', '@supabase/supabase-js'));
const knowledge = require(path.join(__dirname, '..', 'apps', 'shared', 'server', 'knowledge.js'));

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) throw new Error('Podaj ścieżkę do CSV z SKU');
  const raw = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsv(raw).slice(1); // bez nagłówka
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Poprzedni import precz (odświeżenie cennika = nowy stan katalogu).
  const { error: delErr } = await db.from('kb_facts').delete().filter('source_ref->>kind', 'eq', 'sku_csv');
  if (delErr) throw delErr;

  const { data: docRows, error: docErr } = await db
    .from('kb_documents')
    .insert({ name: `SKU CSV import ${new Date().toISOString().slice(0, 10)}`, visibility: 'owner', raw })
    .select('id');
  if (docErr) throw docErr;
  const documentId = docRows[0].id;

  let category = '';
  let created = 0;
  for (const r of rows) {
    const [name, sku, price, tax, unit, weight, purchaseNet, saleNet, marginZl, marginPct, photo] = r.map((c) => c.trim());
    if (!sku) { category = name; continue; }

    const publicParts = [
      `${name} (SKU ${sku}), kategoria: ${category}.`,
      price && Number(price) > 0 ? `Cena: ${price} zł brutto za ${unit || 'szt.'} (VAT ${tax || '23'}%).` : 'Cena: 0 zł (pozycja dodawana do zestawów bez dopłaty).',
      weight ? `Waga: ${weight} kg.` : '',
      photo ? `Zdjęcie produktu: ${photo}` : '',
    ].filter(Boolean);
    await knowledge.proposeFact(db, {
      title: `Produkt: ${name} — cena i dane`,
      content: publicParts.join(' '),
      tags: ['cennik', 'produkt', category.toLowerCase()].filter(Boolean),
      visibility: 'public',
      status: 'active',
      source: 'import',
      sourceRef: { kind: 'sku_csv', document_id: documentId, sku },
      createdBy: 'import:antoni',
    });
    created += 1;

    if (purchaseNet || marginZl) {
      const ownerParts = [
        `${name} (SKU ${sku}):`,
        purchaseNet ? `koszt zakupu netto ${purchaseNet} zł,` : '',
        saleNet ? `sprzedaż netto ${saleNet} zł,` : '',
        marginZl ? `marża netto ${marginZl} zł` : '',
        marginPct ? `(${marginPct}).` : '.',
      ].filter(Boolean);
      await knowledge.proposeFact(db, {
        title: `Marża i koszt zakupu: ${name}`,
        content: ownerParts.join(' '),
        tags: ['marze', 'koszty', category.toLowerCase()].filter(Boolean),
        visibility: 'owner',
        status: 'active',
        source: 'import',
        sourceRef: { kind: 'sku_csv', document_id: documentId, sku },
        createdBy: 'import:antoni',
      });
      created += 1;
    }
  }
  console.log(`OK — dokument ${documentId}, faktów: ${created}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
