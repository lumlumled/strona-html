// Import historycznych sprzedaży 2025 (sprzed obecnego systemu) z arkusza
// "Sprzedaż LumLum - Arkusz1.csv". TWARDE ODCIĘCIE: ID od 1000 (obecny system
// startuje od ~1503), więc te lecą na sam dół listy w sekcji "Zamknięte".
// Mapujemy tylko to, co jest sensowne: kwota, imię/nazwisko, adres wysyłki,
// telefon, e-mail. Resztę olewamy (danych i tak brak). Kwota = "Po zniżce",
// a jak pusta to kolumna brutto (zgadza się z sumą arkusza ~118 448 zł).
//
// Bezpiecznie: DOMYŚLNIE dry-run. Zapis dopiero z --apply.
//   node scripts/wyceny-import-hist-2025.js "/ścieżka/do.csv"           # podgląd
//   node scripts/wyceny-import-hist-2025.js "/ścieżka/do.csv" --apply    # zapis
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'node_modules', 'dotenv')).config({ path: path.join(ROOT, 'apps', 'formularz', 'server', '.env') });
const { createClient } = require(path.join(ROOT, 'node_modules', '@supabase/supabase-js'));

const APPLY = process.argv.includes('--apply');
const CSV = process.argv.find((a) => a.endsWith('.csv')) || '/Users/anton/Downloads/Sprzedaż LumLum - Arkusz1.csv';
const ID_START = 1000;

function parseCSV(text) {
  const rows = []; let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += c; }
    else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const money = (v) => {
  const s = String(v || '').trim();
  if (!s) return null;
  const n = Number(s.replace(/\s/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

function parseDate(s) {
  const m = String(s || '').match(/^\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\s*$/);
  if (!m) return null;
  const [, d, mo, y] = m.map(Number);
  return new Date(Date.UTC(y, mo - 1, d, 10, 0, 0));
}

function parseAddress(raw) {
  const adres = String(raw || '').trim();
  if (!adres) return { adres: null };
  const pc = adres.match(/(\d{2}-\d{3})/);
  if (!pc) return { adres, ship_street: adres, ship_country: 'PL' };
  const postcode = pc[1];
  const before = adres.slice(0, pc.index).replace(/[,\s]+$/, '').trim();
  const after = adres.slice(pc.index + postcode.length).replace(/^[,\s]+/, '').trim();
  return { adres, ship_street: before || null, ship_postcode: postcode, ship_city: after || null, ship_country: 'PL' };
}

function parsePhone(v) {
  const digits = String(v || '').replace(/\D/g, '');
  if (!digits) return { e164: null, digits: null };
  const local = digits.replace(/^48/, '');
  return { e164: `48${local}`, digits: local };
}

async function main() {
  const rows = parseCSV(fs.readFileSync(CSV, 'utf8'));
  const header = rows[0];
  const col = (name) => header.findIndex((h) => h.trim() === name);
  const iData = col('Data'), iName = col('Imię i nazwisko'), iAdr = col('Adres'), iMail = col('Mail'), iTel = col('Tel'), iPoz = col('Po zniżce');
  const iBrutto = iTel + 1; // kolumna kwoty brutto (nagłówek = suma)
  const iB2B = col('B2B?'), iUwagi = col('Uwagi'), iForma = col('Forma płatności'), iZrodlo = col('Źródło');

  const wiersze = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const date = parseDate(row[iData]);
    const name = (row[iName] || '').trim();
    if (!date || !name) continue;
    const poz = money(row[iPoz]);
    const brutto = money(row[iBrutto]);
    const kwota = (poz && poz > 0) ? poz : brutto;
    const ph = parsePhone(row[iTel]);
    const addr = parseAddress(row[iAdr]);
    wiersze.push({
      date, name,
      email: (row[iMail] || '').trim().toLowerCase() || null,
      phone: ph, addr, kwota,
      b2b: (row[iB2B] || '').trim(), uwagi: (row[iUwagi] || '').trim(),
      forma: (row[iForma] || '').trim(), zrodlo: (row[iZrodlo] || '').trim(),
    });
  }

  console.log(`Wierszy do importu: ${wiersze.length} (ID ${ID_START}..${ID_START + wiersze.length - 1})`);
  const suma = wiersze.reduce((a, w) => a + (w.kwota || 0), 0);
  console.log(`Suma kwot: ${Math.round(suma)} zł`);
  console.log('Próbka:');
  wiersze.slice(0, 4).forEach((w, i) => console.log(`  #${ID_START + i} ${w.date.toISOString().slice(0, 10)} ${w.name} | ${w.kwota} zł | tel ${w.phone.e164 || '-'} | ${w.email || '-'} | ${[w.addr.ship_street, w.addr.ship_postcode, w.addr.ship_city].filter(Boolean).join(', ')}`));

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // Guard kolizji: żaden z docelowych ID nie może już istnieć.
  const ids = wiersze.map((_, i) => ID_START + i);
  const { data: kolizje, error: cErr } = await db.from('wyceny').select('id').in('id', ids);
  if (cErr) throw cErr;
  if (kolizje && kolizje.length) {
    console.error(`\n❌ Kolizja ID: ${kolizje.map((k) => k.id).join(', ')} już istnieją. Przerywam.`);
    process.exit(1);
  }
  console.log('\nKolizji ID brak.');

  if (!APPLY) { console.log('[dry-run] Nic nie zapisano. Uruchom z --apply.'); return; }

  let done = 0;
  for (let i = 0; i < wiersze.length; i++) {
    const w = wiersze[i];
    const iso = w.date.toISOString();
    const kwota = w.kwota != null ? w.kwota : null;
    const paid = String(w.forma || '').toUpperCase() !== 'POBRANIE';
    const insert = {
      id: ID_START + i,
      typ: 'ZAMÓWIENIE',
      status: 'Closed',
      process_stage: 'DELIVERED',
      source: 'import',
      owner: 'Antoni',
      imie_nazwisko: w.name,
      telefon_e164: w.phone.e164,
      telefon_digits: w.phone.digits,
      email: w.email,
      adres: w.addr.adres || null,
      ship_street: w.addr.ship_street || null,
      ship_postcode: w.addr.ship_postcode || null,
      ship_city: w.addr.ship_city || null,
      ship_country: w.addr.ship_country || null,
      items: [],
      kwota_proponowana_brutto: kwota,
      kwota_sprzedazy_brutto: kwota,
      payment_method: /przelew/i.test(w.forma) ? 'transfer' : (/pobranie/i.test(w.forma) ? 'COD' : null),
      paid,
      paid_at: paid ? iso : null,
      created_at: iso,
      updated_at: new Date().toISOString(),
      legacy: { zrodlo: 'sprzedaz-2025-arkusz', b2b: w.b2b || null, uwagi: w.uwagi || null, forma_platnosci: w.forma || null, zrodlo_sprzedazy: w.zrodlo || null },
    };
    const { error } = await db.from('wyceny').insert(insert);
    if (error) throw error;
    done += 1;
  }
  console.log(`\n[apply] Zaimportowano ${done} historycznych sprzedaży (ID ${ID_START}..${ID_START + done - 1}).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
