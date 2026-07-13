// ── Klient Furgonetka (przesyłki ZAGRANICZNE wycen) ──────────────────────────
// Zagranica (ship_country ≠ PL) idzie przez Furgonetkę — agregator kurierów z
// obsługą międzynarodową. PL zostaje na InPost ShipX (wyceny-shipx.js) bez zmian.
//
// Model Antoniego: PO OPŁACENIU w pełni automatycznie — najtańsza oferta
// (calculate-price) → utwórz paczkę → zamów kuriera → etykieta A6 → odczytaj
// godzinę odbioru → push do Antoniego. Dane nadawcy/odbioru są skonfigurowane
// w KONCIE Furgonetki, więc payload nie wysyła pełnego nadawcy.
//
// Auth: OAuth2 **grant password + refresh_token**. UWAGA (zweryfikowane na
// żywym API 2026-07-13): client_credentials pobiera token aplikacji, ale
// endpointy konta/paczek zwracają 401 "Error user authentication" — wymagają
// tokena UŻYTKOWNIKA. Dlatego:
//   • BOOTSTRAP (jednorazowo, skrypt): grant=password (username+hasło [+2FA])
//     → zapis refresh_token do trwałego magazynu (env/DB). 2FA obsługiwane
//     tylko w bootstrapie, interaktywnie.
//   • RUNTIME: token wyłącznie z refresh_token (bez hasła/2FA) — access 30 dni,
//     refresh do 3 mies. Cache w pamięci + hak useTokenStore() do persystencji
//     (na serverless zimny start odświeża z refresh_token).
//
// STATUS PÓL (żywe API, 2026-07-13):
//   • OAuth password+refresh — POTWIERDZONE (refresh_token ROTUJE się przy każdym
//     użyciu → produkcyjny store MUSI zapisywać nowy refresh po każdym odświeżeniu).
//   • calculate-price — POTWIERDZONE: koperta `package`{type,pickup,receiver,parcels[]},
//     cena w services_prices[].pricing.price_gross.
//   • createPackage — POTWIERDZONE draftem: pola na ROOCIE (service_id, pickup,
//     receiver, parcels, type) — INNA struktura niż calculate-price (bez koperty).
//     Uwaga: część kurierów ma limit wartości (np. swiatprzesylek 500 zł) i nie
//     wspiera user_reference_number → wybór najtańszego musi to respektować.
//   • order/pickup/label — do potwierdzenia na REALNYM (płatnym) zamówieniu,
//     TODO(live). Poza-EU (np. US) może wymagać danych celnych (US w calculate-
//     price zwrócił pusto).

const API_BASE = process.env.FURGONETKA_API_BASE || 'https://api.furgonetka.pl';
const LABEL_FORMAT = process.env.FURGONETKA_LABEL_FORMAT || 'A6';
// Media type wersjonujący REST Furgonetki. TODO(sandbox): potwierdzić dokładny
// (spotykane: application/vnd.furgonetka.v1+json). Override przez env.
const MEDIA_TYPE = process.env.FURGONETKA_MEDIA_TYPE || 'application/vnd.furgonetka.v1+json';

function creds() {
  const id = process.env.FURGONETKA_CLIENT_ID;
  const secret = process.env.FURGONETKA_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Brak FURGONETKA_CLIENT_ID / FURGONETKA_CLIENT_SECRET w env');
  return { id, secret };
}

// ── Magazyn tokenów (wstrzykiwany) ───────────────────────────────────────────
// Produkcja: podłącz store oparty o Supabase (przetrwa zimne starty + rotację
// refresh_token). Domyślnie: pamięć procesu zasiana z env FURGONETKA_REFRESH_TOKEN.
let _mem = { access: null, accessExp: 0, refresh: process.env.FURGONETKA_REFRESH_TOKEN || null };
let _store = null; // { load: async()=>{access,accessExp,refresh}, save: async(patch)=>void }
function useTokenStore(store) { _store = store; }
async function loadTokens() { return _store ? { ..._mem, ...(await _store.load()) } : _mem; }
async function saveTokens(patch) { _mem = { ..._mem, ...patch }; if (_store) await _store.save(patch); }

// Surowe wywołanie /oauth/token (Basic client_id:secret + form-body).
async function oauthCall(formBody) {
  const { id, secret } = creds();
  const basic = Buffer.from(`${id}:${secret}`).toString('base64');
  const res = await fetch(`${API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody,
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Furgonetka OAuth ${res.status}: ${raw.slice(0, 300)}`);
  return JSON.parse(raw);
}

// RUNTIME: zwraca ważny access_token, odświeżając przez refresh_token gdy trzeba.
// NIE używa hasła (żeby nie wywołać 2FA na produkcji). Brak refresh_token →
// jasny błąd „uruchom bootstrap".
async function getToken() {
  const t = await loadTokens();
  if (t.access && t.accessExp > Date.now() + 60000) return t.access; // 60 s zapasu
  if (!t.refresh) throw new Error('Furgonetka: brak refresh_token — uruchom bootstrap (grant password) i zapisz refresh_token do env/DB.');
  const data = await oauthCall(`grant_type=refresh_token&refresh_token=${encodeURIComponent(t.refresh)}`);
  const patch = {
    access: data.access_token,
    accessExp: Date.now() + (Number(data.expires_in) || 2592000) * 1000,
    refresh: data.refresh_token || t.refresh, // rotacja jeśli zwrócony
  };
  await saveTokens(patch);
  return patch.access;
}

// BOOTSTRAP (jednorazowo): grant=password → { access_token, refresh_token }.
// Jeśli konto ma 2FA, zwrotka wskaże potrzebę /oauth/2fa (obsłużyć w skrypcie).
async function bootstrapPassword(username, password) {
  const data = await oauthCall(
    `grant_type=password&scope=api&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
  );
  await saveTokens({
    access: data.access_token,
    accessExp: Date.now() + (Number(data.expires_in) || 2592000) * 1000,
    refresh: data.refresh_token || null,
  });
  return data;
}

async function furgoFetch(pathname, { method = 'get', body, wantBuffer = false } = {}) {
  const token = await getToken();
  const res = await fetch(`${API_BASE}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: wantBuffer ? 'application/pdf' : MEDIA_TYPE,
      ...(body ? { 'Content-Type': MEDIA_TYPE } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Furgonetka ${method.toUpperCase()} ${pathname} → ${res.status}: ${errText.slice(0, 400)}`);
  }
  if (wantBuffer) return Buffer.from(await res.arrayBuffer());
  const raw = await res.text();
  try { return JSON.parse(raw); } catch (_) { return raw; }
}

// ── Mapowanie naszych danych → nadawca / odbiorca / paczka ───────────────────
// Nazwy pól POTWIERDZONE na żywym API (2026-07-13) przez odczyt realnej paczki
// i udany calculate-price. Odbiorca: building_number i flat_number OSOBNO.
function buildReceiver(wycena) {
  return {
    name: [wycena.first_name, wycena.last_name].filter(Boolean).join(' ').trim()
      || wycena.imie_nazwisko || wycena.invoice_company_name || '',
    company: wycena.invoice_company_name || '',
    email: wycena.email || '',
    phone: String(wycena.telefon_e164 || wycena.telefon_digits || '').replace(/^\+/, ''),
    street: wycena.ship_street || '',
    building_number: wycena.ship_house_no || '',
    flat_number: wycena.ship_flat_no || '',
    city: wycena.ship_city || '',
    postcode: wycena.ship_postcode || '',
    country_code: String(wycena.ship_country || '').toUpperCase(),
  };
}

// Nadawca/odbiór — skonfigurowany w koncie Furgonetki (Antoni: „dane odbioru są
// w furgonetce"). Nadpisywalny env-ami; domyślne = realne dane konta LumLum.
function buildPickup() {
  return {
    company: process.env.FURGONETKA_SENDER_COMPANY || 'LumLum',
    street: process.env.FURGONETKA_SENDER_STREET || 'Walońska 7/84',
    postcode: process.env.FURGONETKA_SENDER_POSTCODE || '50-418',
    city: process.env.FURGONETKA_SENDER_CITY || 'Wrocław',
    country_code: process.env.FURGONETKA_SENDER_COUNTRY || 'PL',
    email: process.env.FURGONETKA_SENDER_EMAIL || 'kontakt@lumlum.co',
    phone: process.env.FURGONETKA_SENDER_PHONE || '604650590',
  };
}

// Wymiary/waga jak kurier ShipX (50×35×18 cm, 3 kg) — pola: width/depth/height/
// weight (NIE length!) + value (do ubezpieczenia). ULEPSZENIE (v2): waga z
// pozycji × sku_cennik.weight_kg — dla zagranicy cena zależy od wagi mocniej.
function buildParcel(wycena) {
  return {
    width: 35,
    depth: 50,
    height: 18,
    weight: 3,
    value: Number(wycena.kwota_sprzedazy_brutto ?? wycena.kwota_proponowana_brutto ?? 0) || 0,
  };
}

// ── Endpointy (paths pewne z changelogu REST) ────────────────────────────────

// Porównanie ofert kurierów. Struktura POTWIERDZONA na żywym API: koperta
// `package` z `type:"package"` w środku i PŁASKĄ tablicą `parcels`. Zwraca
// { services_prices: [{ service, service_id, available, pricing:{price_gross,…} }] }.
async function calculatePrice(wycena) {
  const body = {
    package: {
      type: 'package',
      pickup: buildPickup(),
      receiver: buildReceiver(wycena),
      parcels: [buildParcel(wycena)],
    },
  };
  return furgoFetch('/packages/calculate-price', { method: 'post', body });
}

// Najtańsza realna oferta kurierska: available=true, jest pricing.price_gross,
// pomijamy „furgonetka_gielda" (aukcja, nie deterministyczny kurier).
function wybierzNajtanszaOferte(pricing) {
  const offers = (pricing && pricing.services_prices) || [];
  const ok = offers.filter((o) => o.available && o.pricing && o.pricing.price_gross != null
    && o.service !== 'furgonetka_gielda');
  ok.sort((a, b) => a.pricing.price_gross - b.pricing.price_gross);
  return ok[0] || null;
}

// Utworzenie paczki (draft w koszyku) dla wybranej oferty. UWAGA: `POST /packages`
// używa INNEJ struktury niż calculate-price — pola na ROOCIE (bez koperty
// `package`): service_id + pickup + receiver + parcels + type. Potwierdzone
// błędem walidacji na żywym API. `order` dopiero kupuje (osobny krok).
async function createPackage(wycena, oferta, { reference } = {}) {
  const body = {
    type: 'package',
    service_id: oferta.service_id,
    pickup: buildPickup(),
    receiver: buildReceiver(wycena),
    parcels: [buildParcel(wycena)],
    user_reference_number: String(reference || wycena.id),
  };
  return furgoFetch('/packages', { method: 'post', body });
}

// Zamówienie utworzonej paczki do nadania (to kosztuje/finalizuje). Przyjmuje
// id paczki zwrócone przez createPackage. TODO(sandbox): kształt body (lista id).
async function orderPackage(packageId) {
  return furgoFetch('/packages/order', { method: 'put', body: { packages: [packageId] } });
}

// Zamów odbiór kuriera + odczytaj okno godzinowe (do pusha „odbiór o HH:MM").
async function schedulePickup(packageId) {
  return furgoFetch('/packages/pickup', { method: 'put', body: { packages: [packageId] } });
}
async function getPickup() {
  return furgoFetch('/packages/pickup');
}

// Etykieta PDF w formacie A6 (do drukarki etykiet — jak ShipX). TODO(sandbox):
// dokładny path/parametr formatu druku.
async function downloadLabel(packageId) {
  return furgoFetch(`/packages/${encodeURIComponent(packageId)}/label?format=${encodeURIComponent(LABEL_FORMAT)}`, { wantBuffer: true });
}

async function getTracking(trackingNumber) {
  return furgoFetch(`/packages/tracking?tracking_number=${encodeURIComponent(trackingNumber)}`);
}

// Jawne mapowanie statusów (jak w ShipX — tylko „delivered" znaczy doręczona).
// TODO(sandbox): uzupełnić realne stringi statusów Furgonetki z webhooka/tracking.
const DELIVERED = new Set(['delivered', 'dostarczona', 'delivered_to_point']);
const SENT = new Set(['sent', 'in_transit', 'nadana', 'out_for_delivery', 'ready_to_pickup']);
const PROBLEM = new Set(['canceled', 'cancelled', 'returned', 'error', 'problem', 'undelivered']);
function mapTrackingStatus(rawStatus) {
  const s = String(rawStatus || '').toLowerCase();
  if (DELIVERED.has(s)) return 'delivered';
  if (SENT.has(s)) return 'sent';
  if (PROBLEM.has(s)) return 'problem';
  return 'created';
}

// ── Orkiestracja: „zamów zagraniczną przesyłkę w pełni automatycznie" ─────────
// Zwraca znormalizowany wynik do zapisania w wyceny_shipments + do pusha.
// Wołane z pipeline (krokPrzesylkaFurgonetka) TYLKO gdy jestZagranica.
async function zamowPrzesylkeZagraniczna(wycena) {
  const pricing = await calculatePrice(wycena);
  const oferta = wybierzNajtanszaOferte(pricing);
  if (!oferta) throw new Error('Furgonetka: brak dostępnej oferty kuriera dla kraju ' + wycena.ship_country);

  const paczka = await createPackage(wycena, oferta, { reference: wycena.id });
  const packageId = paczka?.id ?? paczka?.package_id ?? paczka?.uuid; // TODO(sandbox)
  if (!packageId) throw new Error('Furgonetka: createPackage nie zwrócił id: ' + JSON.stringify(paczka).slice(0, 200));

  await orderPackage(packageId);
  let pickup = null;
  try { await schedulePickup(packageId); pickup = await getPickup(); }
  catch (e) { pickup = { error: e.message }; } // odbiór nie może wywalić całości

  let label = null;
  try { label = await downloadLabel(packageId); }
  catch (e) { label = null; } // etykieta dociągnie worker, jak nie od razu

  return {
    provider: 'furgonetka',
    shipment_id: String(packageId),
    service: oferta.service ?? null,
    tracking_number: paczka?.tracking_number ?? paczka?.package_no ?? null, // TODO(live)
    cena_kuriera: oferta.pricing?.price_gross ?? null,
    pickup, // { date, time_from, time_to, ... } — do pusha „odbiór o …"
    label,  // Buffer PDF A6 albo null
    raw: { pricingCount: (pricing?.services_prices || []).length },
  };
}

module.exports = {
  getToken,
  useTokenStore,
  bootstrapPassword,
  furgoFetch,
  buildReceiver,
  buildParcel,
  calculatePrice,
  wybierzNajtanszaOferte,
  createPackage,
  orderPackage,
  schedulePickup,
  getPickup,
  downloadLabel,
  getTracking,
  mapTrackingStatus,
  zamowPrzesylkeZagraniczna,
};
