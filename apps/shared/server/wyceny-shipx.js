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

// Nadawca 1:1 z Make (działa w prod od miesięcy — nie poprawiamy literówki
// w nazwie ulicy, InPost ma ją w każdej dotychczasowej przesyłce).
const SENDER = {
  company_name: 'LumLum',
  first_name: 'first_name',
  last_name: 'last_name',
  email: 'kontakt@lumlum.co',
  phone: '604650590',
  address: {
    street: 'Kościelsika',
    building_number: '11B',
    city: 'Zakopane',
    post_code: '34-500',
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
    payload.custom_attributes = {
      sending_method: 'dispatch_order',
      target_point: String(wycena.punkt_odbioru || '').split(',')[0].trim(),
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
// (status confirmed — ShipX tworzy ofertę asynchronicznie).
async function downloadLabel(shipmentId) {
  const res = await fetch(`${BASE}/shipments/${shipmentId}/label?format=pdf`, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  if (!res.ok) throw new Error(`ShipX etykieta ${shipmentId} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function getTracking(trackingNumber) {
  return shipxFetch(`/tracking/${trackingNumber}`);
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
  mapTrackingStatus,
};
