// ── Weryfikacja firm do faktur: Biała Lista MF (PL) + VIES (VAT UE / WDT) ────
// Dwa użycia:
//  1. Lookup w formularzu („Wyszukaj dane firmy"): NIP → nazwa + adres + status
//     VAT, żeby klient nie wpisywał danych z palca.
//  2. Weryfikacja przy submicie zamówienia: firma z UE poza PL z aktywnym VAT
//     UE w VIES → faktura WDT ze stawką 0% (klient płaci netto — decyzja
//     Antoniego 2026-07-21). Wynik + numer konsultacji VIES ląduje w
//     wyceny.invoice_dane.vat_ue jako dowód do dokumentacji WDT.
// VIES bywa niedostępny i miewa opóźnienia danych — negatywny/brak wyniku
// NIGDY nie blokuje zamówienia; pipeline wstrzymuje wtedy fakturę do ręcznej
// decyzji (jak dotychczasowy HOLD firm zagranicznych).

const VIES_URL = 'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number';
const MF_URL = 'https://wl-api.mf.gov.pl/api/search/nip/';

// Kraje obsługiwane przez VIES: UE27 + XI (Irlandia Płn.). Grecja w VIES ma
// prefiks EL — mapujemy z GR używanego w formularzu/wysyłce.
const VIES_CC = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'EL',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI',
  'ES', 'SE', 'XI',
]);

function viesCountry(cc) {
  const c = String(cc || '').trim().toUpperCase();
  return c === 'GR' ? 'EL' : c;
}

// NIP/VAT z formularza: zdejmij separatory; wiodące 2 litery = prefiks kraju
// (np. "BE0417497106"). Zwraca { country|null, digits }.
function rozbierzNip(raw) {
  const s = String(raw || '').replace(/[\s.\-\/]/g, '').toUpperCase();
  const m = s.match(/^([A-Z]{2})(.+)$/);
  if (m && VIES_CC.has(viesCountry(m[1]))) return { country: m[1], digits: m[2] };
  return { country: null, digits: s };
}

async function fetchJson(url, { method = 'get', body, timeoutMs = 8000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch (_) { /* nie-JSON = błąd serwisu */ }
  return { ok: res.ok, status: res.status, json, raw };
}

// ── VIES ─────────────────────────────────────────────────────────────────────
// Zwraca { status: 'valid'|'invalid'|'unavailable', name, address, consultation,
// checked_at }. requesterNumber (NIP LumLum, env LUMLUM_NIP) daje w odpowiedzi
// requestIdentifier = urzędowy numer konsultacji; bez env sprawdzenie działa,
// tylko bez numeru.
async function viesCheck(country, vatNumber) {
  const cc = viesCountry(country);
  const digits = String(vatNumber || '').replace(/[\s.\-\/]/g, '').replace(new RegExp(`^${cc}`), '');
  const checked_at = new Date().toISOString();
  if (!VIES_CC.has(cc) || cc === 'PL' || !digits) {
    return { status: 'invalid', name: '', address: '', consultation: '', checked_at };
  }
  const body = { countryCode: cc, vatNumber: digits };
  const requester = String(process.env.LUMLUM_NIP || '').replace(/\D/g, '');
  if (requester) {
    body.requesterMemberStateCode = 'PL';
    body.requesterNumber = requester;
  }
  try {
    const { ok, json } = await fetchJson(VIES_URL, { method: 'post', body });
    if (!ok || !json || typeof json.valid !== 'boolean') {
      // errorWrappers / userError: INVALID_INPUT = zły format numeru; reszta
      // (MS_UNAVAILABLE, MS_MAX_CONCURRENT_REQ, TIMEOUT…) = spróbuj później.
      const err = JSON.stringify(json || {});
      if (/INVALID_INPUT/i.test(err)) {
        return { status: 'invalid', name: '', address: '', consultation: '', checked_at };
      }
      return { status: 'unavailable', name: '', address: '', consultation: '', checked_at };
    }
    const czysc = (v) => (String(v || '').trim() === '---' ? '' : String(v || '').trim());
    return {
      status: json.valid ? 'valid' : 'invalid',
      name: czysc(json.name),
      address: czysc(json.address),
      consultation: String(json.requestIdentifier || ''),
      checked_at,
    };
  } catch (err) {
    return { status: 'unavailable', name: '', address: '', consultation: '', error: String(err.message || err).slice(0, 200), checked_at };
  }
}

// ── Biała Lista MF (polskie NIP-y) ───────────────────────────────────────────
// Zwraca { found, vat_active, name, address, requestId } albo { found: false }.
async function mfLookup(nip) {
  const digits = String(nip || '').replace(/\D/g, '');
  if (digits.length !== 10) return { found: false };
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' }).format(new Date());
  try {
    const { ok, json } = await fetchJson(`${MF_URL}${digits}?date=${date}`, { timeoutMs: 6000 });
    const subject = ok && json && json.result && json.result.subject;
    if (!subject) return { found: false };
    return {
      found: true,
      vat_active: String(subject.statusVat || '') === 'Czynny',
      name: String(subject.name || ''),
      address: String(subject.workingAddress || subject.residenceAddress || ''),
      requestId: String((json.result && json.result.requestId) || ''),
    };
  } catch (err) {
    return { found: false, error: String(err.message || err).slice(0, 200) };
  }
}

// ── Parsowanie adresów na pola formularza (best-effort, pola są edytowalne) ──
// MF: "CHEMIKÓW 7, 09-411 PŁOCK" / "UL. TESTOWA 1/2, 00-001 WARSZAWA".
// VIES: "Brouwerijplein 1\n3000 Leuven" (formaty różne per kraj, DE/ES nie
// zwracają nic). Gdy nie umiemy rozebrać — całość w `street`, resztę dopisze
// klient.
function rozbierzUlice(part) {
  const s = String(part || '').trim().replace(/^UL\.?\s+|^ULICA\s+/i, '');
  const m = s.match(/^(.*?)[\s,]+(\d[\w]*(?:\/[\w]+)?)$/);
  if (!m) return { street: s, house_no: '', flat_no: '' };
  const [house, flat] = m[2].split('/');
  return { street: m[1].trim(), house_no: house || '', flat_no: flat || '' };
}

function parseAdres(addr) {
  const s = String(addr || '').replace(/\r/g, '').trim();
  if (!s) return { street: '', house_no: '', flat_no: '', postcode: '', city: '' };
  // ostatni segment (po przecinku lub nowej linii) z cyframi = "kod miasto"
  const parts = s.split(/\n|,/).map((p) => p.trim()).filter(Boolean);
  const last = parts[parts.length - 1] || '';
  const m = parts.length > 1 && last.match(/^([A-Z0-9][A-Z0-9\- ]{1,9}?)\s+(.+)$/i);
  if (m && /\d/.test(m[1])) {
    return { ...rozbierzUlice(parts.slice(0, -1).join(', ')), postcode: m[1].trim(), city: m[2].trim() };
  }
  return { ...rozbierzUlice(s.replace(/\n/g, ', ')), postcode: '', city: '' };
}

// ── Weryfikacja VAT UE dla zamówienia (submit formularza) ────────────────────
// null = WDT nie dotyczy (brak firmy / kraj poza UE / wysyłka nie-UE / PL).
// Inaczej wynik viesCheck + kontekst + netto_zamrozone uzupełniane w zapisie.
const UE_BEZ_PL = new Set([...VIES_CC].filter((c) => c !== 'PL' && c !== 'EL'));

async function vatUeDlaZamowienia(body) {
  const nipRaw = String(body.invoice_company_nip || '').trim();
  if (nipRaw.length < 7) return null;
  const { country: nipCc, digits } = rozbierzNip(nipRaw);
  const invCc = String(body.invoice_company_country || '').trim().toUpperCase();
  const country = nipCc || invCc;
  const shipCc = String(body.ship_country || '').trim().toUpperCase();
  if (!country || country === 'PL' || !UE_BEZ_PL.has(country)) return null;
  if (!shipCc || shipCc === 'PL' || !UE_BEZ_PL.has(shipCc)) return null;
  const wynik = await viesCheck(country, digits);
  return { ...wynik, nip: `${viesCountry(country)}${digits}`, country, ship_country: shipCc };
}

module.exports = {
  VIES_CC,
  viesCountry,
  rozbierzNip,
  viesCheck,
  mfLookup,
  parseAdres,
  vatUeDlaZamowienia,
};
