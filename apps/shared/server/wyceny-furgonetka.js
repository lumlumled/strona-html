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

// Produkcyjny magazyn tokenów oparty o Supabase (tabela furgonetka_oauth, wiersz
// id=1). Przetrwa zimne starty serverless i rotację single-use refresh_token.
// Użycie w pipeline: furgonetka.useTokenStore(furgonetka.makeSupabaseTokenStore(db)).
function makeSupabaseTokenStore(db) {
  return {
    load: async () => {
      const { data } = await db.from('furgonetka_oauth').select('*').eq('id', 1).limit(1);
      const row = data && data[0];
      if (!row) return {};
      return {
        access: row.access_token || null,
        accessExp: row.access_expires_at ? new Date(row.access_expires_at).getTime() : 0,
        refresh: row.refresh_token || null,
      };
    },
    save: async (patch) => {
      const upd = { id: 1, updated_at: new Date().toISOString() };
      if (patch.access !== undefined) upd.access_token = patch.access;
      if (patch.refresh !== undefined) upd.refresh_token = patch.refresh;
      if (patch.accessExp !== undefined) upd.access_expires_at = new Date(patch.accessExp).toISOString();
      const { error } = await db.from('furgonetka_oauth').upsert(upd);
      if (error) console.error('Furgonetka token save błąd:', error.message);
    },
  };
}
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
  const nr = [wycena.ship_house_no, wycena.ship_flat_no].filter(Boolean).join('/');
  // Numer budynku MUSI być w polu `street` (tak trzyma to Furgonetka — realna
  // paczka: "Mierová 950/95", building_number=null; DPD waliduje street→noNumber
  // gdy brak numeru). Osobne pola zostawiamy dla kurierów, które je czytają.
  return {
    name: [wycena.first_name, wycena.last_name].filter(Boolean).join(' ').trim()
      || wycena.imie_nazwisko || wycena.invoice_company_name || '',
    company: wycena.invoice_company_name || '',
    email: wycena.email || '',
    phone: String(wycena.telefon_e164 || wycena.telefon_digits || '').replace(/^\+/, ''),
    street: [wycena.ship_street, nr].filter(Boolean).join(' '),
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

// Pudło = największe REALNIE używane (43×33×10 cm). Ustalone empirycznie na żywym
// cenniku (2026-07-13): wszystkie realne pudełka LumLum (24,5×23×9 … 43×33×10)
// mieszczą się w tym samym progu cenowym, więc dobór S/M/L nic nie oszczędza —
// bierzemy największe, żeby zawsze się zmieściło. WAŻNE: cena kuriera = max(waga
// rzeczywista, gabaryt = W×D×H/5000). Przy tym pudle gabaryt ≈ 2,84 kg, więc dla
// cięższych zamówień to WAGA zaczyna decydować. ULEPSZENIE (v2): weight z pozycji
// (Σ ilość × sku_cennik.weight_kg + narzut) — override przez env FURGONETKA_WEIGHT_KG.
function buildParcel(wycena) {
  return {
    width: 43,
    depth: 33,
    height: 10,
    weight: Number(process.env.FURGONETKA_WEIGHT_KG) || 3,
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

// Kurierzy DOZWOLENI (allow-lista, decyzja Antoniego): TYLKO renomowani —
// DPD, DHL, FedEx, UPS. Żadnych randomowych brokerów (swiatprzesylek,
// ambroexpress, gls) ani Poczty/Pocztexu (twardy zakaz). Wszystko spoza listy
// jest ignorowane. Override/rozszerzenie env FURGONETKA_ALLOWED.
const DOZWOLENI = new Set(
  (process.env.FURGONETKA_ALLOWED || 'dpd,dhl,fedex,ups')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
);

// Oferty POSORTOWANE rosnąco po cenie: available=true, jest pricing.price_gross,
// TYLKO dozwoleni kurierzy. Lista do fallbacku (najtańszy DOZWOLONY, który
// realnie przyjmie paczkę — patrz orchestracja).
function sortowaneOferty(pricing) {
  const offers = (pricing && pricing.services_prices) || [];
  return offers
    .filter((o) => o.available && o.pricing && o.pricing.price_gross != null && DOZWOLENI.has(String(o.service || '').toLowerCase()))
    .sort((a, b) => a.pricing.price_gross - b.pricing.price_gross);
}

// Najtańsza pojedyncza oferta (wygoda; orchestracja i tak używa fallbacku).
function wybierzNajtanszaOferte(pricing) {
  return sortowaneOferty(pricing)[0] || null;
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
function packageIdOf(paczka) {
  return paczka?.package_id ?? paczka?.id ?? (paczka?.packages && paczka.packages[0] && paczka.packages[0].package_id) ?? null;
}

async function zamowPrzesylkeZagraniczna(wycena, { autoOrder = true } = {}) {
  const pricing = await calculatePrice(wycena);
  const oferty = sortowaneOferty(pricing);
  if (!oferty.length) {
    throw new Error(`Furgonetka: brak oferty kuriera dla ${wycena.ship_country} (poza-EU może wymagać danych celnych)`);
  }

  // create z FALLBACKIEM po ofertach: najtańszy, który REALNIE przyjmie paczkę
  // (kurier ma limit wartości, np. swiatprzesylek 500 zł, albo nie wspiera pól).
  let paczka = null; let oferta = null; let ostatniBlad = null; let odrzuconych = 0;
  for (const o of oferty) {
    try { paczka = await createPackage(wycena, o, { reference: wycena.id }); oferta = o; break; }
    catch (e) { ostatniBlad = `${o.service}: ${e.message.slice(0, 120)}`; odrzuconych += 1; }
  }
  if (!paczka) throw new Error(`Furgonetka: żaden z ${oferty.length} kurierów nie przyjął paczki. Ostatni: ${ostatniBlad}`);
  const packageId = packageIdOf(paczka);
  if (!packageId) throw new Error(`Furgonetka: createPackage bez package_id: ${JSON.stringify(paczka).slice(0, 200)}`);

  // order = kupno (płatne). pickup + etykieta A6 best-effort (nie wywalają całości).
  let ordered = false; let pickup = null; let label = null;
  if (autoOrder) {
    await orderPackage(packageId);
    ordered = true;
    try { await schedulePickup(packageId); pickup = await getPickup(); } catch (e) { pickup = { error: e.message }; }
    try { label = await downloadLabel(packageId); } catch (_) { label = null; } // dociągnie worker
  }

  return {
    provider: 'furgonetka',
    shipment_id: String(packageId),
    service: oferta.service ?? null,
    tracking_number: paczka?.tracking_number ?? (paczka?.parcels && paczka.parcels[0] && paczka.parcels[0].package_no) ?? null,
    cena_kuriera: oferta.pricing?.price_gross ?? null,
    ordered,
    pickup, // { … godzina odbioru … } — do pusha „kurier odbierze o HH:MM"
    label,  // Buffer PDF A6 albo null (dociągnie worker po potwierdzeniu)
    raw: { ofert: oferty.length, odrzuconych },
  };
}

module.exports = {
  getToken,
  useTokenStore,
  makeSupabaseTokenStore,
  bootstrapPassword,
  furgoFetch,
  buildReceiver,
  buildParcel,
  calculatePrice,
  sortowaneOferty,
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
