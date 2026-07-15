// ── Klient InPost ShipX (przesyłki wycen: paczkomat + kurier) ────────────────
// Po migracji OBA typy przesyłek idą przez ShipX (koniec z Baselinkerem
// i rozjazdem web tracker / Menedżer Paczek). Payloady 1:1 z Make
// (Formularz POST moduł 60, #3 moduł 53); kurier = to samo API z service
// inpost_courier_standard i adresem odbiorcy zamiast target_point.
const BASE = 'https://api-shipx-pl.easypack24.net/v1';

function orgId() {
  return process.env.INPOST_ORG_ID || '122150';
}

function token() {
  const t = process.env.INPOST_SHIPX_TOKEN;
  if (!t) throw new Error('Brak INPOST_SHIPX_TOKEN w env');
  return t;
}

async function shipxFetch(pathname, { method = 'get', body } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`ShipX ${method.toUpperCase()} ${pathname} → ${res.status}: ${raw.slice(0, 400)}`);
  try { return JSON.parse(raw); } catch (_) { return raw; }
}

// Nadawca = Wrocław (2026-07-13, decyzja Antoniego — spójnie z kontem Furgonetki
// „dane odbioru w Furgonetce"). Adres nadawcy jest WYMAGANY w payloadzie ShipX
// (bez niego 400) i InPost drukuje go na etykiecie jako adres zwrotny — nie ma
// flagi API, żeby go ukryć; dlatego musi być poprawny (a nie ukryty).
const SENDER = {
  company_name: 'LumLum',
  first_name: 'first_name',
  last_name: 'last_name',
  email: 'kontakt@lumlum.co',
  phone: '604650590',
  address: {
    street: 'Walońska',
    building_number: '7/84',
    city: 'Wrocław',
    post_code: '50-418',
    country_code: 'PL',
  },
};

// Przesyłka paczkomatowa (inpost_locker_standard, template medium) albo
// kurierska (inpost_courier_standard, wymiary jak dziś w Baselinkerze:
// 50×35×18 cm, 3 kg). codAmount/insuranceAmount w zł (null = bez).
async function createShipment(wycena, { locker, codAmount, insuranceAmount, reference }) {
  const receiver = {
    company_name: wycena.invoice_company_name || '',
    first_name: wycena.first_name || '',
    last_name: wycena.last_name || '',
    email: wycena.email || '',
    phone: String(wycena.telefon_digits || wycena.telefon_e164 || '').replace(/^48/, ''),
  };
  const payload = {
    sender: SENDER,
    receiver,
    insurance: insuranceAmount ? { amount: Number(insuranceAmount), currency: 'PLN' } : undefined,
    cod: codAmount ? { amount: Number(codAmount), currency: 'PLN' } : undefined,
    reference: String(reference || wycena.id),
  };
  if (locker) {
    payload.parcels = { template: 'medium' };
    // Kod paczkomatu = PIERWSZY token pola punkt_odbioru. Liquid zapisuje tu
    // sklejkę "KOD — adres" (np. "WAW201M — Nowogrodzka 27"), a ShipX wymaga
    // samego kodu ("WAW201M") — inaczej 400 incorrect_name (+ kaskadowo
    // cod unavailable_for_target_point). punkt_odbioru_ID (czysty kod) miałby
    // pierwszeństwo, gdyby serwer go zapisywał; dziś w bazie jest tylko sklejka.
    const targetPoint = String(wycena.punkt_odbioru_ID || wycena.punkt_odbioru || '')
      .trim().split(/[\s,]+/)[0];
    payload.custom_attributes = {
      sending_method: 'dispatch_order',
      target_point: targetPoint,
    };
    payload.service = 'inpost_locker_standard';
  } else {
    receiver.address = {
      street: wycena.ship_street || '',
      building_number: [wycena.ship_house_no, wycena.ship_flat_no].filter(Boolean).join('/'),
      city: wycena.ship_city || '',
      post_code: wycena.ship_postcode || '',
      country_code: wycena.ship_country || 'PL',
    };
    payload.parcels = { dimensions: { length: '50', width: '35', height: '18' }, weight: { amount: '3', unit: 'kg' } };
    payload.custom_attributes = { sending_method: 'dispatch_order' };
    payload.service = 'inpost_courier_standard';
  }
  return shipxFetch(`/organizations/${orgId()}/shipments`, { method: 'post', body: payload });
}

async function getShipment(shipmentId) {
  return shipxFetch(`/shipments/${shipmentId}`);
}

// Etykieta PDF (bajty). Dostępna dopiero gdy przesyłka jest potwierdzona
// (status confirmed — ShipX tworzy ofertę asynchronicznie). Rozmiar A6
// (decyzja Antoniego 2026-07-13) — pod drukarkę etykiet; nadpisywalny env
// SHIPX_LABEL_TYPE (np. A6P/normal), gdyby trzeba było inny format.
async function downloadLabel(shipmentId) {
  const type = process.env.SHIPX_LABEL_TYPE || 'A6';
  const res = await fetch(`${BASE}/shipments/${shipmentId}/label?format=pdf&type=${encodeURIComponent(type)}`, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  if (!res.ok) throw new Error(`ShipX etykieta ${shipmentId} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function getTracking(trackingNumber) {
  return shipxFetch(`/tracking/${trackingNumber}`);
}

async function listDispatchPoints() {
  const res = await shipxFetch(`/organizations/${orgId()}/dispatch_points`);
  return (res && res.items) || [];
}

// Zlecenie odbioru (zamawianie kuriera): kurier przyjeżdża pod adres nadawcy po
// podane przesyłki. Wymogi ShipX: przesyłki confirmed, każda w MAX 1 zleceniu.
//
// ⚠️ KLUCZOWE (2026-07-15): NIE wysyłamy name/address — InPost robi z nich ZA
// KAŻDYM razem NOWY dispatch_point (fantomowe punkty „LumLum (numer)" na koncie
// Antoniego, których ShipX API nie pozwala skasować). Zamiast tego
// REFERENCUJEMY istniejący punkt przez `dispatch_point_id` (konto ma jeden,
// reużywamy go). Fallback name/address tylko gdy konto nie ma ŻADNEGO punktu
// (utworzy go raz). Zwracamy też external_id = numer referencyjny w Menedżerze
// Paczek (potwierdzenie odbioru dla Antoniego; bywa null tuż po utworzeniu —
// jeden dociąg GET-em).
async function createDispatchOrder(shipmentIds, { comment } = {}) {
  const punkt = (await listDispatchPoints().catch(() => []))[0];
  const body = punkt
    ? { shipments: shipmentIds.map(String), dispatch_point_id: punkt.id, comment: comment || undefined }
    : {
      shipments: shipmentIds.map(String),
      name: SENDER.company_name, phone: SENDER.phone, email: SENDER.email,
      address: SENDER.address, office_hours: '15:00 - 17:00', comment: comment || undefined,
    };
  const order = await shipxFetch(`/organizations/${orgId()}/dispatch_orders`, { method: 'post', body });
  let externalId = order.external_id || null;
  if (!externalId && order.id) {
    try { externalId = (await shipxFetch(`/dispatch_orders/${order.id}`)).external_id || null; } catch (_) { /* dociągnie panel */ }
  }
  return { ...order, external_id: externalId };
}

// ── JAWNE mapowanie statusów ShipX ───────────────────────────────────────────
// Naprawa znanego buga starego systemu (świeża paczka oznaczana jako
// doręczona): TYLKO status "delivered" znaczy doręczona. Każdy odczyt
// trafia do wyceny_events, więc surowa historia jest w panelu.
const DELIVERED_STATUSES = new Set(['delivered']);
const SENT_STATUSES = new Set([
  'dispatched_by_sender', 'dispatched_by_sender_to_pok', 'collected_from_sender',
  'taken_by_courier', 'taken_by_courier_from_pok', 'adopted_at_source_branch',
  'sent_from_source_branch', 'adopted_at_sorting_center', 'sent_from_sorting_center',
  'adopted_at_target_branch', 'out_for_delivery', 'out_for_delivery_to_address',
  'ready_to_pickup', 'pickup_reminder_sent', 'stack_in_box_machine',
  'stack_parcel_in_box_machine', 'pickup_reminder_sent_address',
]);
const PROBLEM_STATUSES = new Set([
  'canceled', 'returned_to_sender', 'avizo', 'claimed', 'rejected_by_receiver',
  'undelivered', 'oversized', 'delay_in_delivery',
]);

function mapTrackingStatus(rawStatus) {
  const s = String(rawStatus || '').toLowerCase();
  if (DELIVERED_STATUSES.has(s)) return 'delivered';
  if (SENT_STATUSES.has(s)) return 'sent';
  if (PROBLEM_STATUSES.has(s)) return 'problem';
  return 'created'; // created / offer_selected / confirmed itd. — jeszcze nie nadana
}

module.exports = {
  createShipment,
  getShipment,
  downloadLabel,
  getTracking,
  createDispatchOrder,
  listDispatchPoints,
  mapTrackingStatus,
};
