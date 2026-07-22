// ── Klient inFakt API v3 (faktury wycen) ─────────────────────────────────────
// Payloady 1:1 z blueprintów Make (Formularz POST, #3 PAID, #4 Dostawa).
// Async API: POST /async/invoices.json -> polling statusu po
// invoice_task_reference_number -> invoice_uuid. Kwoty w GROSZACH
// (gross_price = quantity × cena_brutto × 100 — tak liczył Make).
const BASE = 'https://api.infakt.pl/api/v3';

function apiKey() {
  const key = process.env.INFAKT_API_KEY;
  if (!key) throw new Error('Brak INFAKT_API_KEY w env');
  return key;
}

async function infaktFetch(pathname, { method = 'get', body } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      'X-inFakt-ApiKey': apiKey(),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`inFakt ${method.toUpperCase()} ${pathname} → ${res.status}: ${raw.slice(0, 300)}`);
  try { return JSON.parse(raw); } catch (_) { return raw; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// POST async + polling do skutku (Make: sleep 5 s i jedno GET; my dajemy
// kilka prób, bo serverless nie ma drugiej szansy).
async function createInvoiceAsync(invoice) {
  const created = await infaktFetch('/async/invoices.json', { method: 'post', body: { invoice } });
  const ref = created.invoice_task_reference_number;
  if (!ref) throw new Error(`inFakt nie zwrócił invoice_task_reference_number: ${JSON.stringify(created).slice(0, 200)}`);
  for (let i = 0; i < 10; i += 1) {
    await sleep(i < 3 ? 3000 : 6000);
    const status = await infaktFetch(`/async/invoices/status/${ref}.json`);
    if (status.invoice_uuid) return { uuid: status.invoice_uuid, taskReference: ref, status };
    if (String(status.processing_status || '').toLowerCase() === 'error') {
      throw new Error(`inFakt async error: ${JSON.stringify(status).slice(0, 300)}`);
    }
  }
  // async jeszcze mieli — zwróć ref bez uuid, worker dociągnie
  return { uuid: null, taskReference: ref, status: null };
}

async function getAsyncStatus(ref) {
  return infaktFetch(`/async/invoices/status/${ref}.json`);
}

async function getInvoice(uuid) {
  return infaktFetch(`/invoices/${uuid}.json`);
}

async function deleteInvoice(uuid) {
  return infaktFetch(`/invoices/${uuid}.json`, { method: 'delete' });
}

async function sendToKsef(uuid) {
  return infaktFetch(`/invoices/${uuid}/send_to_ksef.json`, { method: 'post' });
}

// Link szybkiej płatności (Autopay). WAŻNE: inFakt rejestruje transakcję Autopay
// SAM przy tworzeniu faktury przelewowej (globalne Szybkie Płatności = ON) i
// wystawia gotowy link w extensions.payments.link. NIE WOLNO wołać
// POST /quick_payments — to nadpisuje dobrą transakcję zepsutą i link od razu
// jest "wygasł lub jest niepoprawny" (UI i Make nigdy tego nie wołały;
// potwierdzone testami na żywym koncie 2026-07-22: async/sync + quick_payments
// = martwy, oba warianty BEZ quick_payments = działa). Bierzemy link z faktury.
async function getPaymentLink(uuid) {
  const inv = await infaktFetch(`/invoices/${uuid}.json`);
  const p = inv && inv.extensions && inv.extensions.payments;
  return p && p.available && p.link ? p.link : null;
}

// PDF faktury (bajty) — do załącznika maila i proxy w panelu.
async function downloadPdf(uuid) {
  const res = await fetch(`${BASE}/invoices/${uuid}/pdf.json?document_type=original`, {
    headers: { 'X-inFakt-ApiKey': apiKey() },
  });
  if (!res.ok) throw new Error(`inFakt PDF ${uuid} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ── Budowa payloadów (1:1 z Make) ────────────────────────────────────────────

function grosze(zl) {
  return Math.round(Number(zl) * 100);
}

// Dopłata do wysyłki zagranicznej (flat, brutto — decyzja Antoniego 2026-07-13):
// PL/pusty = 0 (darmowa), Europa = 50 zł, poza Europą = 100 zł. Ta sama reguła
// pokazuje się klientowi w formularzu (formularz.liquid) — trzymać zgodnie.
// EUROPA = EU27 + EEA (IS/LI/NO) + UK + CH + mikropaństwa + Bałkany + UA/MD/BY.
const EUROPA_CC = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
  'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES',
  'SE', 'IS', 'LI', 'NO', 'CH', 'GB', 'UA', 'MD', 'BY', 'RS', 'BA', 'ME', 'MK',
  'AL', 'XK', 'AD', 'MC', 'SM', 'VA', 'GI', 'FO',
]);
function shippingSurchargePLN(country) {
  const cc = String(country || '').trim().toUpperCase();
  if (!cc || cc === 'PL') return 0;
  return EUROPA_CC.has(cc) ? 50 : 100;
}

// services: pozycje wyceny + dopłata do wysyłki zagranicznej (jeśli > 0) +
// ujemna pozycja "Rabat" (zawsze kwotowa — decyzja Antoniego 2026-07-11).
// gross_price to ŁĄCZNA kwota pozycji w groszach (jak w Make: quantity ×
// price_brutto × 100). rabatLaczny (ujemny, zł) = (kwota_proponowana − suma
// pozycji) − aktywny rabat 24h. shippingSurcharge (zł, brutto) doliczany OSOBNO
// (nie jest reconcilowany rabatem) → podnosi sumę faktury o 50/100.
// taxDomyslny: stawka pozycji Wysyłka/Rabat — przy WDT (pipeline przekazuje
// '0') cała faktura musi być na jednej stawce, żeby rabat reconcilował sumę.
function buildServices(items, rabatLaczny, shippingSurcharge = 0, taxDomyslny = '23') {
  const services = (items || []).map((p) => ({
    name: p.name,
    unit: 'szt.',
    quantity: Number(p.quantity) || 1,
    tax_symbol: String(p.VAT || taxDomyslny),
    gross_price: grosze((Number(String(p.price).replace(',', '.')) || 0) * (Number(p.quantity) || 1)),
  }));
  if (shippingSurcharge && shippingSurcharge > 0) {
    services.push({ name: 'Wysyłka zagraniczna', unit: 'szt.', quantity: 1, tax_symbol: taxDomyslny, gross_price: grosze(shippingSurcharge) });
  }
  if (rabatLaczny && rabatLaczny < 0) {
    services.push({ name: 'Rabat', unit: 'szt.', quantity: 1, tax_symbol: taxDomyslny, gross_price: grosze(rabatLaczny) });
  }
  return services;
}

// Dane klienta: firma (NIP z formularza) albo osoba prywatna (fallback na
// adres wysyłki — jak ifempty() w Make).
function buildClient(wycena) {
  const inv = wycena.invoice_dane || {};
  const firma = String(wycena.invoice_company_nip || '').trim().length > 6;
  if (firma) {
    return {
      client_company_name: String(wycena.invoice_company_name || '').replace(/"/g, ''),
      client_street: inv.invoice_company_street || '',
      client_street_number: inv.invoice_company_house_no || '',
      client_flat_number: inv.invoice_company_flat_no || '',
      client_city: inv.invoice_company_city || '',
      client_post_code: inv.invoice_company_postcode || '',
      // Przy WDT numer z weryfikacji VIES (z prefiksem kraju, np. BE04…) —
      // stare formularze przysyłały same cyfry, a FV 0% musi mieć pełny VAT UE.
      client_tax_code: (inv.vat_ue && inv.vat_ue.nip) || wycena.invoice_company_nip || '',
      client_country: inv.invoice_company_country || wycena.ship_country || 'PL',
    };
  }
  return {
    client_company_name: ' ',
    client_first_name: inv.invoice_private_first_name || wycena.first_name || '',
    client_last_name: inv.invoice_private_last_name || wycena.last_name || '',
    client_business_activity_kind: 'private_person',
    client_street: inv.invoice_private_street || wycena.ship_street || '',
    client_street_number: inv.invoice_private_house_no || wycena.ship_house_no || '',
    client_flat_number: inv.invoice_private_flat_no || wycena.ship_flat_no || '',
    client_city: inv.invoice_private_city || wycena.ship_city || '',
    client_post_code: inv.invoice_private_postcode || wycena.ship_postcode || '',
    client_tax_code: '',
    client_country: inv.invoice_private_country || wycena.ship_country || 'PL',
  };
}

// Proforma po submicie formularza. paymentMethod: 'delivery' (pobranie)
// albo 'transfer' (przelew) — 1:1 z Make.
function buildProforma(wycena, { services, paymentMethod }) {
  return {
    kind: 'proforma',
    payment_method: paymentMethod,
    sale_type: 'merchandise',
    ...buildClient(wycena),
    services,
  };
}

// Faktura końcowa VAT z danych OPŁACONEJ proformy (klient i pozycje z
// proformy — jak w #3: client_id + services przepisane, status paid).
function buildVatFromProforma(proforma) {
  return {
    payment_method: 'transfer',
    bank_name: 'PKO BP',
    bank_account: '73102034660000990202255784',
    sale_type: 'merchandise',
    status: 'paid',
    paid_price: proforma.gross_price,
    kind: 'vat',
    paid_date: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' }).format(new Date()),
    client_id: proforma.client_id,
    client_company_name: proforma.client_company_name,
    client_street: proforma.client_street,
    client_street_number: proforma.client_street_number,
    client_flat_number: proforma.client_flat_number,
    client_city: proforma.client_city,
    client_post_code: proforma.client_post_code,
    client_tax_code: proforma.client_tax_code,
    client_country: proforma.client_country,
    services: (proforma.services || []).map((s) => ({
      name: s.name,
      unit: s.unit,
      quantity: s.quantity,
      tax_symbol: s.tax_symbol,
      gross_price: s.gross_price,
    })),
  };
}

module.exports = {
  createInvoiceAsync,
  getAsyncStatus,
  getInvoice,
  deleteInvoice,
  sendToKsef,
  getPaymentLink,
  downloadPdf,
  buildServices,
  shippingSurchargePLN,
  buildClient,
  buildProforma,
  buildVatFromProforma,
  grosze,
};
