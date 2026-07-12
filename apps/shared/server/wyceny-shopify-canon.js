// ── Kanonizacja produktów Shopify -> nasz cennik (sku_cennik) ────────────────
// Tytuły ze sklepu są rozwlekłe i niespójne ("Sterownik do taśm cyfrowych
// LumControl - Jednostrefowy", "Cyfrowa taśma LED COB IP20 CRI90+ - Ciepła
// biel (3000K) / 10 m"). Tu sprowadzamy je DETERMINISTYCZNIE do naszej nazwy,
// naszego SKU i naszego zdjęcia — żeby zamówienie ze sklepu wyglądało tak samo
// jak pozycja dodana ręcznie. Taśmy rozkładamy z reguł (typ/barwa/IP/długość),
// resztę z jawnej tablicy aliasów.
//
// Używane przez orderToRow (sync na bieżąco) oraz backfill
// scripts/wyceny-canonize-shopify.js (istniejące 55 zamówień).

// Piloty generyczne "Sterowanie X strefowe - Pilot X" (bez wskazania MONO/CCT/
// RGBCCT) — DECYZJA ANTONIEGO 2026-07-12: idą razem z LumControl i taśmami
// jednobarwnymi, mapujemy na piloty MONO. Zmiana = jedna stała tutaj.
const PILOT_1Z_SKU = 'LL-REMOTE-MONO-1Z';
const PILOT_4Z_SKU = 'LL-REMOTE-MONO-4Z';

// Barwa z nazwy Shopify -> segment SKU (kolejność: RGBCCT przed CCT!).
const TEMP_RULES = [
  [/rgb\s*\+?\s*cct/i, 'RGBCCT'],
  [/3000\s*k|ciep/i, '3000K'],
  [/4000\s*k|neutral/i, '4000K'],
  [/6000\s*k|zimn/i, '6000K'],
  [/\bcct\b|mieszanie/i, 'CCT'],
];
function tempOf(s) { for (const [re, v] of TEMP_RULES) if (re.test(s)) return v; return null; }

// Aliasy pozycji NIE-taśmowych: regex tytułu -> nasze SKU. Kolejność ma
// znaczenie — bardziej szczegółowe (np. "... do taśm MONO") PRZED generycznymi.
const ALIASES = [
  [/lumcontrol/i, 'LL-CTRL-LUMCONTROL'],
  [/schodow.*laser|laser.*schodow/i, 'LL-CTRL-STAIR-L'],
  [/schodow.*(podczerw|\bpir\b|\bir\b)|(podczerw|\bpir\b).*schodow/i, 'LL-CTRL-STAIR-S'],
  [/sterownik.*analogow.*mono/i, 'LL-CTRL-ANA-MONO'],
  [/panel.*(ścienn|scienn).*mono/i, 'LL-PANEL-WALL-MONO'],
  [/panel.*biurkow.*mono/i, 'LL-PANEL-DESK-MONO'],
  [/pilot.*(czterostref|4\s*stref).*rgb/i, 'LL-REMOTE-RGBCCT-4Z'],
  [/pilot.*(czterostref|4\s*stref).*(mono)/i, 'LL-REMOTE-MONO-4Z'],
  [/pilot.*(jednostref|1\s*stref).*(mono)/i, 'LL-REMOTE-MONO-1Z'],
  [/pilot.*(jednostref|1\s*stref).*(rgb)/i, 'LL-REMOTE-RGBCCT-1Z'],
  [/pilot.*(jednostref|1\s*stref).*cct/i, 'LL-REMOTE-CCT-1Z'],
  [/laserow.*czujnik|czujnik.*laser/i, 'LL-SENSOR-PIR-LASER'],
  [/czujnik/i, 'LL-SENSOR-PIR'],
  [/zasilacz.*mean\s*well.*600/i, 'LL-PSU-MEANWELL-600W-24V'],
  [/zasilacz.*mean\s*well.*200/i, 'LL-PSU-MEANWELL-200W-24V'],
  [/zasilacz.*mean\s*well.*150/i, 'LL-PSU-MEANWELL-150W-24V'],
  [/zasilacz.*mean\s*well.*75/i, 'LL-PSU-MEANWELL-75W-24V'],
  [/zasilacz.*150\s*w/i, 'LL-PSU-150W-24V'],
  [/narzędzi|narzedzi/i, 'LL-ACC-TOOLS'],
  [/przewod/i, 'LL-ACC-WIRES'],
  // Generyczne piloty na końcu (najmniej szczegółowe) — patrz PILOT_*_SKU.
  [/(sterowanie.*(4|cztero).*stref)|(pilot.*(czterostref|4\s*stref))/i, PILOT_4Z_SKU],
  [/(sterowanie.*(jedno|1).*stref)|(pilot.*(jednostref|1\s*stref))/i, PILOT_1Z_SKU],
];

// Taśma z reguł -> { sku, meters } albo null.
function canonTape(title) {
  if (!/ta[śs]ma/i.test(title) || !/\bcob\b/i.test(title)) return null;
  const dig = /cyfrow/i.test(title) ? 'DIG' : (/analogow/i.test(title) ? 'ANA' : null);
  if (!dig) return null;
  const temp = tempOf(title);
  if (!temp) return null;
  const ipm = title.match(/ip\s*(20|65|67)/i);
  const ip = ipm ? `IP${ipm[1]}` : 'IP20'; // brak IP w tytule -> IP20 (najczęstsze)
  const lenm = title.match(/(\d+(?:[.,]\d+)?)\s*m\b/i);
  const meters = lenm ? Number(String(lenm[1]).replace(',', '.')) : null;
  return { sku: `LL-TAPE-${dig}-COB-${temp}-${ip}`, meters };
}

// Znormalizowana pozycja { name, sku, quantity, unitPrice } -> pozycja karty.
// index = buildSkuIndex (bySku Map, byName Map z pełnymi rekordami cennika).
function canonicalize({ name, sku, quantity, unitPrice }, index) {
  const rawName = String(name || '').trim();
  const rawSku = String(sku || '').trim();
  const qty = Number(quantity) || 1;
  const price = Number(unitPrice) || 0;

  let canonSku = null;
  let meters = null;

  const tape = canonTape(rawName);
  if (tape && index.bySku.has(tape.sku)) { canonSku = tape.sku; meters = tape.meters; }

  if (!canonSku) {
    for (const [re, aliasSku] of ALIASES) {
      if (aliasSku && re.test(rawName) && index.bySku.has(aliasSku)) { canonSku = aliasSku; break; }
    }
  }
  if (!canonSku) {
    if (rawSku && index.bySku.has(rawSku)) canonSku = rawSku;
    else if (index.byName.has(rawName.toLowerCase())) canonSku = index.byName.get(rawName.toLowerCase()).sku;
  }

  if (!canonSku) {
    // Brak dopasowania (np. "testowy") — zostaw surowe, nic nie psujemy.
    return { name: rawName, SKU: rawSku, quantity: qty, unit: 'szt', price: String(price || ''), VAT: '23', image_url: '', _unmatched: true };
  }

  const c = index.bySku.get(canonSku);
  if (meters && meters > 0) {
    // Taśma pakowana (np. "/ 10 m") -> nasza jednostka metrowa: ilość = metry
    // × liczba paczek, cena = cena paczki / metry.
    return {
      name: c.nazwa, SKU: c.sku,
      quantity: Math.round(meters * qty * 100) / 100,
      unit: c.unit || 'm',
      price: String(Math.round((price / meters) * 100) / 100),
      VAT: '23', image_url: c.image_url || '',
    };
  }
  return {
    name: c.nazwa, SKU: c.sku, quantity: qty, unit: c.unit || 'szt',
    price: String(price || ''), VAT: '23', image_url: c.image_url || '',
  };
}

module.exports = { canonicalize, canonTape, PILOT_1Z_SKU, PILOT_4Z_SKU };
