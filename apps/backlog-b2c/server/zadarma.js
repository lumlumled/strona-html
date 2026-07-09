const crypto = require('crypto');

const API_BASE = 'https://api.zadarma.com';

function sortEntries(params) {
  return Object.keys(params)
    .sort()
    .map((k) => [k, params[k]]);
}

// Zadarma podpisuje request jako: method + queryString + md5(queryString),
// HMAC-SHA1 tym sekretem, wynik (jako hex) base64. queryString musi być
// zakodowany identycznie do tego, co faktycznie leci w URL (RFC1738 —
// spacja jako '+') — URLSearchParams robi dokładnie to samo kodowanie,
// więc używamy go i do podpisu, i do właściwego requestu.
function buildQueryString(sortedEntries) {
  const usp = new URLSearchParams();
  sortedEntries.forEach(([k, v]) => usp.append(k, v));
  return usp.toString();
}

// Zadarma liczy sygnatury (zarówno do podpisywania własnych requestów, jak i
// do weryfikacji przychodzących webhooków) tym samym wzorcem:
// base64( hex( hmac_sha1(string, secret) ) ) — hex jako string pośredni, nie
// surowe bajty (tak właśnie robi ich oficjalna biblioteka PHP).
function encodeSignature(str, secret) {
  const hmacHex = crypto.createHmac('sha1', secret).update(str).digest('hex');
  return Buffer.from(hmacHex).toString('base64');
}

function sign(method, queryString, secret) {
  const md5Hash = crypto.createHash('md5').update(queryString).digest('hex');
  const stringToSign = method + queryString + md5Hash;
  return encodeSignature(stringToSign, secret);
}

// UWAGA: webhook PBX call info faktycznie używany przez to konto (potwierdzone
// na prawdziwych payloadach) NIE wysyła pola `signature` w ogóle — powyższy,
// udokumentowany w bibliotece PHP mechanizm podpisu dotyczy innego wariantu
// webhooka niż ten, którego tu używamy. Endpoint /api/webhooks/zadarma
// zabezpiecza się zamiast tego sekretnym tokenem w query stringu.

// httpMethod: 'GET' (domyślnie, params w query stringu) albo 'POST'/'PUT'
// (params w body jako application/x-www-form-urlencoded) — algorytm podpisu
// jest identyczny dla obu, różni się tylko to, GDZIE params faktycznie lecą
// (dokumentacja Zadarmy: paramsStr do podpisu zawsze pochodzi z tych samych,
// posortowanych parametrów, niezależnie od metody HTTP).
async function callZadarma(method, params = {}, httpMethod = 'GET') {
  const key = process.env.ZADARMA_API_KEY;
  const secret = process.env.ZADARMA_API_SECRET;
  if (!key || !secret) throw new Error('Brak ZADARMA_API_KEY/ZADARMA_API_SECRET w konfiguracji serwera');

  const entries = sortEntries(params);
  const queryString = buildQueryString(entries);
  const signature = sign(method, queryString, secret);
  const headers = { Authorization: `${key}:${signature}` };

  let url = API_BASE + method;
  const options = { method: httpMethod, headers };
  if (httpMethod === 'GET') {
    url += queryString ? `?${queryString}` : '';
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    options.body = queryString;
  }

  const res = await fetch(url, options);
  const body = await res.json();
  if (!res.ok || body.status === 'error') {
    throw new Error(`Zadarma ${method}: ${body.message || res.status}`);
  }
  return body;
}

module.exports = { callZadarma };
