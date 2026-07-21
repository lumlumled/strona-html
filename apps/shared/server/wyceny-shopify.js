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
      id name email phone createdAt updatedAt tags
      displayFinancialStatus displayFulfillmentStatus
      paymentGatewayNames
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

// Tag "S<numer>" na zamówieniu w Shopify — znacznik "przeprocesowane u nas"
// + czytelna referencja na liście zamówień. Wymaga scope write_orders.
const TAGS_ADD_MUTATION = `mutation($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) { userErrors { message } }
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

// Zamówienie zrealizowane w SKLEPIE (historycznie) -> SHIPPED jak dotąd.
// Niezrealizowane -> SHOP_CONFIRM: czeka w panelu Fulfillment na ręczne
// potwierdzenie danych (adres/telefon z Shopify bywa niedookreślony), dopiero
// potem realizujSklep robi FV inFakt + kuriera InPost.
function mapStage(order) {
  if (order.displayFulfillmentStatus === 'FULFILLED') return 'SHIPPED';
  return 'SHOP_CONFIRM';
}

// Najlepszy strzał w rozbicie adresu Shopify (address1/address2) na nasze pola
// ulica / nr domu / nr lokalu — Antoni poprawia w formularzu potwierdzenia.
// "Kwiatowa 12/5" -> {Kwiatowa, 12, 5}; "Kwiatowa 12A" -> {Kwiatowa, 12A, -};
// address2 typu "m. 5" / "5" -> nr lokalu.
function parseAdres(addr) {
  const a1 = String(addr.address1 || '').trim();
  const a2 = String(addr.address2 || '').trim();
  let street = a1 || null;
  let house = null;
  let flat = null;
  const m = a1.match(/^(.+?)[,\s]+(\d+[a-zA-Z]?)(?:\s*\/\s*(\d+[a-zA-Z]?))?$/);
  if (m) {
    street = m[1].replace(/,\s*$/, '').trim();
    house = m[2];
    flat = m[3] || null;
  }
  if (a2) {
    const zPrefiksem = a2.match(/^(?:m\.?|lok\.?|lokal|mieszkanie)\s*(\d+[a-zA-Z]?)$/i);
    const goly = a2.match(/^(\d+[a-zA-Z]?)$/);
    if (zPrefiksem) {
      // Jawny lokal ("m. 5" / "lok 5") — zawsze nr lokalu.
      if (!flat) flat = zPrefiksem[1];
    } else if (goly) {
      // Goły numer: najpierw uzupełnia brakujący nr domu, dopiero potem lokal.
      if (!house) house = goly[1];
      else if (!flat) flat = goly[1];
    } else if (!flat) {
      flat = a2; // niestandardowe ("II piętro") — najlepszy strzał do korekty
    }
  }
  return { street, house, flat };
}

// Payloady zamówień przychodzą w dwóch smakach: nasz sync GraphQL (MoneyBag =
// {shopMoney:{amount}}, lineItems.nodes) i webhook z Make (spłaszczone
// {amount}, lineItems jako tablica, czasem tags jako string). Sprowadzamy
// wszystko do kształtu synca, żeby orderToRow miał jedno wejście.
function moneyBag(v) {
  if (!v || v.shopMoney) return v;
  return { shopMoney: { amount: v.amount } };
}
function normalizeOrderNode(o) {
  const order = { ...o };
  order.totalPriceSet = moneyBag(o.totalPriceSet);
  if (typeof o.tags === 'string') {
    order.tags = o.tags.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const items = o.lineItems?.nodes || o.lineItems || [];
  order.lineItems = {
    nodes: items.map((li) => ({
      ...li,
      discountedUnitPriceSet: moneyBag(
        li.discountedUnitPriceSet || li.discountedUnitPriceAfterAllDiscountsSet || li.originalUnitPriceSet
      ),
    })),
  };
  return order;
}

// Pobranie: brak opłaty w sklepie (PENDING) albo bramka typu "cash on
// delivery"/"pobranie". Opłacone z góry (Shopify Payments/P24) -> nie-COD.
function jestPobranie(order) {
  const gateways = (order.paymentGatewayNames || []).join(' ').toLowerCase();
  if (/pobran|cash on delivery|\bcod\b/.test(gateways)) return true;
  return order.displayFinancialStatus !== 'PAID';
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
  const pobranie = jestPobranie(order);
  const adres = parseAdres(addr);
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
    // 'delivery' = pobranie (jak formularz), inaczej opłacone w sklepie.
    payment_method: pobranie ? 'delivery' : 'shopify_payments',
    ship_street: adres.street,
    ship_house_no: adres.house,
    ship_flat_no: adres.flat,
    ship_postcode: addr.zip || null,
    ship_city: addr.city || null,
    ship_country: addr.countryCodeV2 || null,
    process_stage: mapStage(order),
    paid,
    paid_at: paid ? order.createdAt : null,
    opis_zamowienia: `Zamówienie ze sklepu ${order.name}`,
    legacy: {
      shopify: {
        financial_status: order.displayFinancialStatus || null,
        fulfillment_status: order.displayFulfillmentStatus || null,
        gateways: order.paymentGatewayNames || [],
        address1: addr.address1 || null,
        address2: addr.address2 || null,
      },
    },
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

// Etapy, w których wiersz należy jeszcze do SYNCA (sklep może aktualizować
// status/kwoty). Po potwierdzeniu w Fulfillmencie (realizujSklep) wiersz jest
// NASZ — sync go nie dotyka (nie cofa statusów, nie nadpisuje paid/kwot po FV).
const ETAPY_SYNCA = new Set(['SUBMITTED', 'SHOP_CONFIRM']);

// Następny wolny numer S (ostatnie S + 1) — tabela mała, sync jednowątkowy.
async function nextSklepNr(db) {
  const { data, error } = await db.from('wyceny').select('sklep_nr').not('sklep_nr', 'is', null);
  if (error) throw error;
  const max = (data || []).reduce((m, r) => {
    const n = Number(String(r.sklep_nr || '').replace(/\D/g, ''));
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  return `S${max + 1}`;
}

// Zapisz numer S jako tag zamówienia w Shopify (znacznik "przeprocesowane").
// Best effort: brak scope write_orders NIE wywala synca — logujemy event.
async function tagujWShopify(db, wycenaId, order, sklepNr) {
  if ((order.tags || []).includes(sklepNr)) return;
  try {
    const data = await shopifyGraphql(TAGS_ADD_MUTATION, { id: order.id, tags: [sklepNr] });
    // shopifyGraphql zwraca null bez SHOPIFY_ADMIN_TOKEN — wtedy tag dokleja
    // scenariusz Make (z sklep_nr w odpowiedzi webhooka) albo backfill ręczny.
    if (data === null) throw new Error('brak SHOPIFY_ADMIN_TOKEN (tag doda Make)');
    const errs = data?.tagsAdd?.userErrors || [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
  } catch (err) {
    console.error(`Tag ${sklepNr} na ${order.name}:`, err.message);
    await db.from('wyceny_events').insert({
      wycena_id: wycenaId, kind: 'shopify.tag_failed',
      payload: { tag: sklepNr, order: order.name, error: err.message.slice(0, 200) },
    });
  }
}

// Push do adminów o nowym zamówieniu ze sklepu czekającym na potwierdzenie.
async function pushNoweZamowienie(db, wycenaId, row) {
  try {
    const push = require('./push');
    if (!push || !push.notifyUser) return;
    const { data } = await db.from('app_users').select('id,role').eq('active', true);
    for (const u of (data || []).filter((x) => x.role === 'admin')) {
      await push.notifyUser(() => db, u.id, {
        title: 'Sklep — nowe zamówienie',
        body: `${row.sklep_nr || ''} ${row.shopify_order_name} · ${row.imie_nazwisko || ''} · ${row.kwota_sprzedazy_brutto || '?'} zł — potwierdź dane`,
        url: '/fulfillment/',
        tag: `sklep-${wycenaId}`,
      });
    }
  } catch (err) {
    console.warn(`Push sklep ${wycenaId} nie wyszedł:`, err.message);
  }
}

// Upsert po shopify_order_id; nowe dostają id z sekwencji wycen + numer S.
// order = surowy węzeł Shopify (do tagowania); przy wołaniu bez niego (testy)
// tag po prostu nie leci.
async function upsertOrder(db, row, order) {
  const { data: existing, error } = await db.from('wyceny')
    .select('id, process_stage, paid, paid_at, sklep_nr')
    .eq('shopify_order_id', row.shopify_order_id).limit(1);
  if (error) throw error;
  if (existing && existing.length) {
    const w = existing[0];
    // Po potwierdzeniu/realizacji wiersz jest nasz — sync nie nadpisuje.
    // sklep_nr w odpowiedzi zawsze — Make dokleja z niego tag w Shopify.
    if (!ETAPY_SYNCA.has(String(w.process_stage))) return { id: w.id, created: false, skipped: 'realized', sklep_nr: w.sklep_nr };
    const { error: upErr } = await db.from('wyceny').update({
      status: row.status,
      // SHIPPED (sklep sam zrealizował) wygrywa; inaczej nie cofamy etapu.
      process_stage: row.process_stage === 'SHIPPED' ? 'SHIPPED' : w.process_stage,
      // paid nigdy nie wraca na false (PENDING w Shopify po naszym pobraniu).
      paid: w.paid || row.paid,
      paid_at: w.paid_at || row.paid_at,
      payment_method: row.payment_method,
      items: row.items,
      kwota_proponowana_brutto: row.kwota_proponowana_brutto,
      kwota_sprzedazy_brutto: row.kwota_sprzedazy_brutto,
      updated_at: new Date().toISOString(),
    }).eq('id', w.id);
    if (upErr) throw upErr;
    if (order && w.sklep_nr) await tagujWShopify(db, w.id, order, w.sklep_nr);
    return { id: w.id, created: false, sklep_nr: w.sklep_nr };
  }
  // Tag S już w Shopify, a wiersza brak = przeprocesowane kiedyś (np. wiersz
  // skasowany ręcznie) — nie tworzymy duplikatu.
  const staryTag = (order?.tags || []).find((t) => /^S\d+$/i.test(String(t).trim()));
  if (staryTag) return { id: null, created: false, skipped: `tagged:${staryTag}` };

  const { data: idData, error: idErr } = await db.rpc('wyceny_next_id');
  if (idErr) throw idErr;
  const sklepNr = await nextSklepNr(db);
  const crypto = require('crypto');
  const { error: insErr } = await db.from('wyceny').insert({
    id: idData,
    owner: 'Antoni',
    form_token: crypto.randomBytes(12).toString('base64url'),
    created_at: row.form_submitted_at,
    sklep_nr: sklepNr,
    ...row,
  });
  if (insErr) throw insErr;
  await db.from('wyceny_events').insert({ wycena_id: idData, kind: 'wycena.created', payload: { source: 'shopify', order: row.shopify_order_name, sklep_nr: sklepNr } });
  if (order) await tagujWShopify(db, idData, order, sklepNr);
  if (row.process_stage === 'SHOP_CONFIRM') await pushNoweZamowienie(db, idData, { ...row, sklep_nr: sklepNr });
  return { id: idData, created: true, sklep_nr: sklepNr };
}

// Przyrostowy sync (worker): ostatnie 50 zamówień po updated_at wystarcza
// przy przebiegu co 20 min.
async function syncShopifyOrders(db) {
  if (!process.env.SHOPIFY_ADMIN_TOKEN) return { skipped: 'no-token' };
  const skuIndex = await buildSkuIndex(db);
  const data = await shopifyGraphql(ORDERS_QUERY, { cursor: null });
  let created = 0, updated = 0, skipped = 0;
  for (const order of data.orders.nodes) {
    const result = await upsertOrder(db, orderToRow(order, skuIndex), order);
    if (result.created) created += 1;
    else if (result.skipped) skipped += 1;
    else updated += 1;
  }
  return { created, updated, skipped };
}

module.exports = { syncShopifyOrders, orderToRow, upsertOrder, buildSkuIndex, parseAdres, jestPobranie, normalizeOrderNode, ORDERS_QUERY };
