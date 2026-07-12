// Reklasyfikacja: rekordy błędnie oznaczone jako ZAMÓWIENIE (Antoni wpisywał
// z palca "zamówienie", a klient nie kupował) wracają do WYCEN. Decyzja
// Antoniego 2026-07-13:
//   - REALNE zamówienie = ma tracking_number I fakturę (pdf) I label I
//     status != open. ALE ta reguła nie łapie sprzedaży spoza naszego
//     pipeline'u, więc CHRONIMY:
//       * Shopify (source='shopify') — realizowane w sklepie,
//       * historię 2025 (id 1000-1063) — zaimportowaną do statystyk.
//   - Z reszty (import CRM) demotujemy TYLKO te bez ŻADNEGO sygnału
//     realizacji (brak tracking, brak label, brak faktury-pdf). Rekordy z
//     jakimkolwiek sygnałem (częściowo zrealizowane) ZOSTAJĄ sprzedażą.
// Demotowanym zdejmujemy fałszywy process_stage=DELIVERED (bulk-set kiedyś)
// -> FORM_SENT, żeby wycena nie pokazywała "Doręczona".
//
// Bezpieczeństwo: DOMYŚLNIE dry-run. Zapis dopiero z flagą --apply.
const path = require('path');
const FORM_SERVER = path.join(__dirname, '..', 'apps', 'formularz', 'server');
require(path.join(__dirname, '..', 'node_modules', 'dotenv')).config({ path: path.join(FORM_SERVER, '.env') });
const { createClient } = require(path.join(__dirname, '..', 'node_modules', '@supabase/supabase-js'));

const APPLY = process.argv.includes('--apply');
const has = (v) => v !== null && v !== undefined && String(v).trim() !== '';
const isHist2025 = (r) => r.id >= 1000 && r.id <= 1063;

async function main() {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: rows, error } = await db.from('wyceny')
    .select('id,source,status,process_stage,shopify_order_id,kwota_sprzedazy_brutto,kwota_proponowana_brutto,owner,imie_nazwisko')
    .eq('typ', 'ZAMÓWIENIE');
  if (error) throw error;
  const ids = rows.map((r) => r.id);
  const [{ data: sh }, { data: inv }] = await Promise.all([
    db.from('wyceny_shipments').select('wycena_id,tracking_number,label_url').in('wycena_id', ids),
    db.from('wyceny_invoices').select('wycena_id,pdf_url').in('wycena_id', ids),
  ]);
  const sig = new Set();
  for (const s of (sh || [])) { if (has(s.tracking_number) || has(s.label_url)) sig.add(s.wycena_id); }
  for (const i of (inv || [])) { if (has(i.pdf_url)) sig.add(i.wycena_id); }

  // DEMOTE = ZAMÓWIENIE bez żadnego sygnału realizacji, poza Shopify i historią 2025.
  const demote = rows.filter((r) =>
    r.source !== 'shopify' && !has(r.shopify_order_id) && !isHist2025(r) && !sig.has(r.id));
  const demoteIds = demote.map((r) => r.id);
  const kw = (r) => Number(r.kwota_sprzedazy_brutto ?? r.kwota_proponowana_brutto ?? 0);
  const suma = Math.round(demote.reduce((a, r) => a + kw(r), 0));

  console.log(`ZAMÓWIENIA: ${rows.length}`);
  console.log(`DEMOTE do WYCEN (bez sygnału, poza Shopify/historią): ${demote.length} (suma ${suma} zł)`);
  console.log('Statusy demotowanych:', JSON.stringify(demote.reduce((a, r) => { a[r.status || '-'] = (a[r.status || '-'] || 0) + 1; return a; }, {})));
  demote.sort((a, b) => a.id - b.id).forEach((r) => {
    console.log(`  #${r.id} status=${String(r.status || '-').padEnd(20)} own=${String(r.owner || '-').padEnd(8)} ${String(r.imie_nazwisko || '-').slice(0, 26).padEnd(26)} ${kw(r)} zł`);
  });

  if (!APPLY) {
    console.log('\n[dry-run] Nic nie zapisano. Uruchom z --apply, żeby zapisać do prod.');
    return;
  }

  let updated = 0;
  for (let i = 0; i < demoteIds.length; i += 200) {
    const chunk = demoteIds.slice(i, i + 200);
    const { error: uErr } = await db.from('wyceny')
      .update({ typ: 'WYCENA', process_stage: 'FORM_SENT', updated_at: new Date().toISOString() })
      .in('id', chunk);
    if (uErr) throw uErr;
    updated += chunk.length;
  }
  console.log(`\n[apply] Przeniesiono do WYCEN: ${updated} (typ=WYCENA, process_stage=FORM_SENT).`);
}

main().catch((err) => { console.error(err); process.exit(1); });
