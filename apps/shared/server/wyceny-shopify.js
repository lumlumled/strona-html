// ── Sync zamówień ze sklepu Shopify do wycen (panel Sprzedaże) ───────────────
// Zamówienia sklepowe (checkout Shopify, płatność shopify_payments) lądują
// w tabeli wyceny jako source='shopify' (dedupe po shopify_order_id) — panel
// Sprzedaże i statystyki widzą całą sprzedaż w jednym miejscu. Pipeline
// wycen ich NIE dotyka (fulfillment i faktury robi sklep).
//
// Wymaga SHOPIFY_ADMIN_TOKEN (custom app, scope read_orders; token od
// Antoniego). Worker woła syncShopifyOrders przy każdym przebiegu — brak
// tokenu = cichy skip.
const { canonicalize } = require('./wyceny-shopify-canon');

const SHOP = process.env.SHOPIFY_SHOP || 'lumlum-co.myshopify.com';
const API_VERSION = '2025-04';

const ORDERS_QUERY = `query($cursor: String) {
  orders(first: 50, after: $cursor, sortKey: UPDATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name email phone createdAt updatedAt
      displayFinancialStatus displayFulfillmentStatus
      totalPriceSet { shopMoney { amount } }
      shippingAddress { firstName lastName phone address1 address2 city zip countryCodeV2 }
      customer { displayName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } }
      lineItems(first: 25) { nodes {
        title quantity sku
        discountedUnitPriceSet { shopMoney { amount } }
        variant { sku displayName }
      } }
    }
  }
}`;

async function shopifyGraphql(query, variables) {
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!token) return null;
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(body.errors || body).slice(0, 300)}`);
  return body.data;
}

function mapStage(order) {
  if (order.displayFulfillmentStatus === 'FULFILLED') return 'SHIPPED';
  return 'SUBMITTED';
}

// Zamówienie Shopify -> wiersz wyceny (bez id — nadaje go upsert).
function orderToRow(order, skuIndex) {
  const addr = order.shippingAddress || {};
  // Kanonizacja do naszego cennika (nazwa/SKU/zdjęcie, taśmy na metry) —
  // wyceny-shopify-canon.js. Bez dopasowania (np. produkt testowy) zostaje
  // surowa nazwa; flagi _unmatched nie zapisujemy.
  const items = (order.lineItems?.nodes || order.lineItems || []).map((li) => {
    const it = canonicalize({
      name: li.variant?.displayName || li.title,
      sku: li.sku || li.variant?.sku || '',
      quantity: li.quantity || 1,
      unitPrice: li.discountedUnitPriceSet?.shopMoney?.amount,
    }, skuIndex);
    delete it._unmatched;
    return it;
  });
  const phone = order.phone || addr.phone || order.customer?.defaultPhoneNumber?.phoneNumber || '';
  const digits = String(phone).replace(/\D/g, '').replace(/^48/, '');
  const paid = order.displayFinancialStatus === 'PAID';
  return {
    typ: 'ZAMÓWIENIE',
    status: order.displayFulfillmentStatus === 'FULFILLED' ? 'Fulfilled' : 'Open',
    source: 'shopify',
    shopify_order_id: order.id,
    shopify_order_name: order.name,
    form_status: 'SUBMITTED',
    form_submitted_at: order.createdAt,
    imie_nazwisko: order.customer?.displayName || [addr.firstName, addr.lastName].filter(Boolean).join(' ') || null,
    first_name: addr.firstName || null,
    last_name: addr.lastName || null,
    telefon_e164: digits ? `48${digits}` : null,
    telefon_digits: digits || null,
    email: order.email || order.customer?.defaultEmailAddress?.emailAddress || null,
    items,
    // totalPrice zawiera koszt wysyłki — dlatego kwota może być wyższa niż
    // suma pozycji (panel pokaże dopłatę, nie rabat)
    kwota_proponowana_brutto: Number(order.totalPriceSet?.shopMoney?.amount) || null,
    kwota_sprzedazy_brutto: Number(order.totalPriceSet?.shopMoney?.amount) || null,
    payment_method: 'shopify_payments',
    ship_street: addr.address1 || null,
    ship_house_no: addr.address2 || null,
    ship_postcode: addr.zip || null,
    ship_city: addr.city || null,
    ship_country: addr.countryCodeV2 || null,
    process_stage: mapStage(order),
    paid,
    paid_at: paid ? order.createdAt : null,
    opis_zamowienia: `Zamówienie ze sklepu ${order.name}`,
  };
}

async function buildSkuIndex(db) {
  const { data } = await db.from('sku_cennik').select('sku,nazwa,unit,image_url');
  const bySku = new Map();
  const byName = new Map();
  (data || []).forEach((s) => {
    bySku.set(s.sku, s);
    byName.set(s.nazwa.toLowerCase(), s);
  });
  return { bySku, byName };
}

// Upsert po shopify_order_id; nowe dostają id z sekwencji wycen.
async function upsertOrder(db, row) {
  const { data: existing, error } = await db.from('wyceny')
    .select('id').eq('shopify_order_id', row.shopify_order_id).limit(1);
  if (error) throw error;
  if (existing && existing.length) {
    const { error: upErr } = await db.from('wyceny').update({
      status: row.status,
      process_stage: row.process_stage,
      paid: row.paid,
      paid_at: row.paid_at,
      items: row.items,
      kwota_proponowana_brutto: row.kwota_proponowana_brutto,
      kwota_sprzedazy_brutto: row.kwota_sprzedazy_brutto,
      updated_at: new Date().toISOString(),
    }).eq('id', existing[0].id);
    if (upErr) throw upErr;
    return { id: existing[0].id, created: false };
  }
  const { data: idData, error: idErr } = await db.rpc('wyceny_next_id');
  if (idErr) throw idErr;
  const crypto = require('crypto');
  const { error: insErr } = await db.from('wyceny').insert({
    id: idData,
    owner: 'Antoni',
    form_token: crypto.randomBytes(12).toString('base64url'),
    created_at: row.form_submitted_at,
    ...row,
  });
  if (insErr) throw insErr;
  await db.from('wyceny_events').insert({ wycena_id: idData, kind: 'wycena.created', payload: { source: 'shopify', order: row.shopify_order_name } });
  return { id: idData, created: true };
}

// Przyrostowy sync (worker): ostatnie 50 zamówień po updated_at wystarcza
// przy przebiegu co 20 min.
async function syncShopifyOrders(db) {
  if (!process.env.SHOPIFY_ADMIN_TOKEN) return { skipped: 'no-token' };
  const skuIndex = await buildSkuIndex(db);
  const data = await shopifyGraphql(ORDERS_QUERY, { cursor: null });
  let created = 0, updated = 0;
  for (const order of data.orders.nodes) {
    const result = await upsertOrder(db, orderToRow(order, skuIndex));
    if (result.created) created += 1; else updated += 1;
  }
  return { created, updated };
}

module.exports = { syncShopifyOrders, orderToRow, upsertOrder, buildSkuIndex, ORDERS_QUERY };
