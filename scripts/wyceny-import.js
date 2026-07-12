// Import mechanizmu wycen z Google Sheets (eksporty CSV) do Supabase —
// Etap 0 planu docs/plan-wyceny-migracja.md. Trzy pliki:
//   CRM_CASES  -> wyceny (+ rozbicie na wyceny_shipments / wyceny_invoices)
//   Wyceny B2C -> merge Komentarz / Data Feedbacku po ID
//   SKU        -> sku_cennik (koszty/marże do jsonb `koszty` — tylko owner)
//
// RE-RUNNABLE (upsert po id) — do ponownego odpalenia tuż przed cutoverem
// (noc 2) na świeżych eksportach. Zasady ponownego przebiegu:
//   - form_token istniejącego wiersza NIE jest nadpisywany (linki żyją),
//   - shipments/invoices wycen Z ARKUSZA są kasowane i wstawiane od nowa;
//     wyceny spoza arkusza (utworzone już w panelu, id z sekwencji) są
//     nietykane — nasz pipeline nie traci swoich wierszy.
//
// Użycie: node scripts/wyceny-import.js "<CRM_CASES.csv>" "<WycenyB2C.csv>" "<SKU.csv>"
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const KOM_SERVER = path.join(__dirname, '..', 'apps', 'komunikator', 'server');
require(path.join(KOM_SERVER, 'node_modules', 'dotenv')).config({ path: path.join(KOM_SERVER, '.env') });
const { Client } = require(path.join(KOM_SERVER, 'node_modules', 'pg'));

function pooledUrl() {
  const url = new URL(process.env.DATABASE_URL);
  const projectRef = url.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/)?.[1];
  if (!projectRef) return process.env.DATABASE_URL;
  return `postgresql://postgres.${projectRef}:${url.password}@aws-0-eu-west-3.pooler.supabase.com:5432/postgres`;
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function csvObjects(file) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const header = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()])));
}

// '2 600,00' | '2600' | '85,5 zł' -> Number; pusty/nienumeryczny -> null
function money(v) {
  const s = String(v || '').replace(/[^\d,.-]/g, '').replace(/,/g, '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Arkusz miesza formaty dat: '09.07.2026', '09.07.2026 18:24' (Europe/Warsaw)
// oraz ISO '2026-07-09T16:25:49.797Z'. DST liczymy z reguły UE (ostatnie
// niedziele marca/października) — wystarczające dla metadanych.
function toIso(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const [, d, mo, y, h = '12', mi = '0'] = m;
  const lastSunday = (year, month) => { // month 1-12, dzień ostatniej niedzieli
    const last = new Date(Date.UTC(year, month, 0));
    return last.getUTCDate() - last.getUTCDay();
  };
  const dst = (Number(mo) > 3 && Number(mo) < 10)
    || (Number(mo) === 3 && Number(d) >= lastSunday(Number(y), 3))
    || (Number(mo) === 10 && Number(d) < lastSunday(Number(y), 10));
  const pad = (x) => String(x).padStart(2, '0');
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:00${dst ? '+02:00' : '+01:00'}`;
}

// produkty_json ma dwa formaty:
//   stary: `{...}, {...}` (obiekty bez nawiasów tablicy, klucze price_brutto/tax_rate)
//   nowy:  pełny JSON array [{name, SKU, quantity, unit, price, VAT, image_url}]
// Normalizujemy do nowego (to czyta formularz i panel).
function parseItems(rawStr, skuByName) {
  const s = String(rawStr || '').trim();
  if (!s) return [];
  let arr;
  try { arr = JSON.parse(s); } catch (_) {
    try { arr = JSON.parse(`[${s}]`); } catch (_) { return [{ name: s, quantity: 1, unit: 'szt', price: '', VAT: '23' }]; }
  }
  if (!Array.isArray(arr)) arr = [arr];
  return arr.filter(Boolean).map((p) => {
    const name = String(p.name || 'Produkt');
    const skuRow = p.SKU ? null : skuByName.get(name.toLowerCase());
    return {
      name,
      SKU: p.SKU || (skuRow ? skuRow.sku : ''),
      quantity: money(p.quantity) ?? 1,
      unit: p.unit || (skuRow ? skuRow.unit : 'szt'),
      price: p.price != null && p.price !== '' ? String(money(p.price) ?? p.price) : String(money(p.price_brutto) ?? ''),
      VAT: String(p.VAT || p.tax_rate || '23'),
      image_url: p.image_url || (skuRow ? skuRow.image_url : '') || '',
    };
  });
}

function digitsOf(v) { return String(v || '').replace(/\D/g, ''); }

// Kanoniczne kody maszyny stanów z tekstowych etapów arkusza; oryginał
// zostaje w legacy.process_stage_raw.
function mapStage(raw, typ) {
  const s = String(raw || '');
  if (/dostarczona/i.test(s)) return 'DELIVERED';
  if (/etykieta wygenerowana/i.test(s)) return 'SHIPPED';
  if (/proforma wysłana/i.test(s)) return 'PROFORMA_SENT';
  if (typ === 'ZAMÓWIENIE') return s ? 'SUBMITTED' : 'SUBMITTED';
  return 'NEW';
}

const MAPPED_COLS = new Set([
  'id', 'typ', 'status', 'Imie_nazwisko', 'telefon_e164', 'email_full', 'adres',
  'Opis_zamówienia', 'produkty_json', 'kwota_proponowana_brutto', 'kwota_sprzedazy_brutto',
  'partner', 'Dane do faktury', 'punkt_odbioru', 'payment_method', 'telefon_digits',
  'history_log', 'prowizja_status', 'process_stage', 'shipment_id', 'tracking_number',
  'delivery_status', 'cod_status', 'invoice_task_reference_number', 'infakt_UUID_number',
  'invoice_status', 'PAID', 'paid_at', 'invoice_url', 'label_url', 'lock_token',
  'lock_expires_at', 'worker_last_error', 'worker_last_run_at', 'first_name', 'last_name',
  'ship_street', 'ship_house_no', 'ship_flat_no', 'ship_postcode', 'ship_city', 'ship_country',
  'invoice_company_nip', 'invoice_company_name', 'form_submitted_at', 'form_status',
  'ID Paczkomatu', 'Adres paczkomatu', 'rabat24h_kwota', 'rabat24h_wazny_do',
  'Data_stworzenia', 'Data_update', 'invoice_issued_at',
]);

async function main() {
  const [casesCsv, lorenzoCsv, skuCsv] = process.argv.slice(2);
  if (!casesCsv || !lorenzoCsv || !skuCsv) {
    throw new Error('Użycie: node scripts/wyceny-import.js <CRM_CASES.csv> <WycenyB2C.csv> <SKU.csv>');
  }
  const client = new Client({ connectionString: pooledUrl() });
  await client.connect();

  // ── SKU najpierw (items dociągają image_url/SKU po nazwie) ────────────────
  const skuRows = csvObjects(skuCsv);
  let category = '';
  let skuCount = 0;
  const skuByName = new Map();
  for (const r of skuRows) {
    const name = r[Object.keys(r)[0]]; // pierwsza kolumna = nazwa (nagłówek to nazwa kategorii)
    if (!r.SKU) { category = name; continue; }
    const rec = {
      sku: r.SKU,
      nazwa: name,
      price_brutto: money(r.Price),
      vat: Number(r.Tax) || 23,
      unit: (r.Unit || 'szt').replace(/\.$/, ''),
      weight_kg: money(r['Weight (kg)']),
      image_url: r['Link do zdjęć'] || '',
      shopify_id: r['Shopify ID'] || '',
      koszty: {
        kategoria: category,
        zakup_netto: money(r['net pur price']),
        sprzedaz_netto: money(r.Netto),
        marza_netto: money(r['Marża netto']),
        marza_pct: r['Netto handlowa'] || '',
      },
    };
    await client.query(
      `insert into sku_cennik (sku, nazwa, price_brutto, vat, unit, weight_kg, image_url, shopify_id, koszty, active, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,now())
       on conflict (sku) do update set nazwa=excluded.nazwa, price_brutto=excluded.price_brutto,
         vat=excluded.vat, unit=excluded.unit, weight_kg=excluded.weight_kg, image_url=excluded.image_url,
         shopify_id=excluded.shopify_id, koszty=excluded.koszty, active=true, updated_at=now()`,
      [rec.sku, rec.nazwa, rec.price_brutto, rec.vat, rec.unit, rec.weight_kg, rec.image_url, rec.shopify_id, rec.koszty]
    );
    skuByName.set(rec.nazwa.toLowerCase(), rec);
    skuCount += 1;
  }

  // ── Lorenzo: Komentarz / Data Feedbacku po ID ─────────────────────────────
  const lorenzo = new Map();
  for (const r of csvObjects(lorenzoCsv)) {
    const id = Number(digitsOf(r.ID));
    if (id) lorenzo.set(id, r);
  }

  // ── CRM_CASES -> wyceny ───────────────────────────────────────────────────
  const cases = csvObjects(casesCsv);
  const importedIds = [];
  let shipments = 0, invoices = 0;
  for (const r of cases) {
    const id = Number(digitsOf(r.id));
    if (!id) continue;
    importedIds.push(id);
    const typ = r.typ === 'ZAMÓWIERZENIE' ? 'ZAMÓWIENIE' : (r.typ || 'WYCENA');
    const lor = lorenzo.get(id);
    const legacy = {};
    for (const [k, v] of Object.entries(r)) {
      if (!MAPPED_COLS.has(k) && v !== '') legacy[k] = v;
    }
    if (r.process_stage) legacy.process_stage_raw = r.process_stage;
    if (r.typ === 'ZAMÓWIERZENIE') legacy.typ_raw = r.typ;
    if (lor && lor['Data Feedbacku']) legacy.data_feedbacku = lor['Data Feedbacku'];

    const formSubmittedAt = toIso(r.form_submitted_at);
    const formStatus = formSubmittedAt || typ === 'ZAMÓWIENIE' ? 'SUBMITTED' : 'NEW';
    const items = parseItems(r.produkty_json, skuByName);

    await client.query(
      `insert into wyceny (id, typ, status, owner, source, imie_nazwisko, telefon_e164, telefon_digits,
         email, adres, opis_zamowienia, komentarz, dane_do_faktury, partner, prowizja_status,
         items, kwota_proponowana_brutto, kwota_sprzedazy_brutto, rabat24h_kwota, rabat24h_wazny_do,
         form_status, form_submitted_at, form_token,
         payment_method, punkt_odbioru, punkt_odbioru_adres, first_name, last_name,
         ship_street, ship_house_no, ship_flat_no, ship_postcode, ship_city, ship_country,
         invoice_company_nip, invoice_company_name,
         process_stage, paid, paid_at, cod_status, history_log, legacy, created_at, updated_at)
       values ($1,$2,$3,'Antoni','import',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
         $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,
         coalesce($41, now()), coalesce($42, now()))
       on conflict (id) do update set
         typ=excluded.typ, status=excluded.status, imie_nazwisko=excluded.imie_nazwisko,
         telefon_e164=excluded.telefon_e164, telefon_digits=excluded.telefon_digits, email=excluded.email,
         adres=excluded.adres, opis_zamowienia=excluded.opis_zamowienia, komentarz=excluded.komentarz,
         dane_do_faktury=excluded.dane_do_faktury, partner=excluded.partner, prowizja_status=excluded.prowizja_status,
         items=excluded.items, kwota_proponowana_brutto=excluded.kwota_proponowana_brutto,
         kwota_sprzedazy_brutto=excluded.kwota_sprzedazy_brutto, rabat24h_kwota=excluded.rabat24h_kwota,
         rabat24h_wazny_do=excluded.rabat24h_wazny_do, form_status=excluded.form_status,
         form_submitted_at=excluded.form_submitted_at,
         payment_method=excluded.payment_method, punkt_odbioru=excluded.punkt_odbioru,
         punkt_odbioru_adres=excluded.punkt_odbioru_adres, first_name=excluded.first_name,
         last_name=excluded.last_name, ship_street=excluded.ship_street, ship_house_no=excluded.ship_house_no,
         ship_flat_no=excluded.ship_flat_no, ship_postcode=excluded.ship_postcode, ship_city=excluded.ship_city,
         ship_country=excluded.ship_country, invoice_company_nip=excluded.invoice_company_nip,
         invoice_company_name=excluded.invoice_company_name, process_stage=excluded.process_stage,
         paid=excluded.paid, paid_at=excluded.paid_at, cod_status=excluded.cod_status,
         history_log=excluded.history_log, legacy=excluded.legacy, updated_at=now()`,
      [
        id, typ, r.status || 'Open', r.Imie_nazwisko || null, r.telefon_e164 || null,
        digitsOf(r.telefon_digits || r.telefon_e164) || null, r.email_full || null, r.adres || null,
        r['Opis_zamówienia'] || null, (lor && lor.Komentarz) || null, r['Dane do faktury'] || null,
        r.partner || null, r.prowizja_status || null, JSON.stringify(items),
        money(r.kwota_proponowana_brutto), money(r.kwota_sprzedazy_brutto),
        money(r.rabat24h_kwota), toIso(r.rabat24h_wazny_do),
        formStatus, formSubmittedAt, crypto.randomBytes(12).toString('base64url'),
        r.payment_method || null, r.punkt_odbioru || r['ID Paczkomatu'] || null,
        r['Adres paczkomatu'] || null, r.first_name || null, r.last_name || null,
        r.ship_street || null, r.ship_house_no || null, r.ship_flat_no || null,
        r.ship_postcode || null, r.ship_city || null, r.ship_country || null,
        r.invoice_company_nip || null, r.invoice_company_name || null,
        mapStage(r.process_stage, typ), r.PAID === 'PAID', toIso(r.paid_at), r.cod_status || null,
        r.history_log || null, JSON.stringify(legacy), toIso(r.Data_stworzenia), toIso(r.Data_update),
      ]
    );

    // shipments/invoices: świeży stan z arkusza (delete+insert tylko dla id z arkusza)
    await client.query('delete from wyceny_shipments where wycena_id=$1', [id]);
    await client.query('delete from wyceny_invoices where wycena_id=$1', [id]);
    if (r.shipment_id || r.tracking_number) {
      const stage = mapStage(r.process_stage, typ);
      // raw_status 'import' = przesyłka z arkusza; worker archiwizuje ją przy
      // martwym trackingu (404) zamiast odpytywać w kółko
      await client.query(
        `insert into wyceny_shipments (wycena_id, provider, kind, shipment_id, service, status, raw_status, tracking_number, label_url, delivered_at)
         values ($1,'shipx','order',$2,$3,$4,'import',$5,$6,$7)`,
        [
          id, r.shipment_id || null,
          // arkusz miewa "puste" punkty odbioru w postaci ", " — to kurier
          String(r.punkt_odbioru || r['ID Paczkomatu'] || '').replace(/[,\s]/g, '')
            ? 'inpost_locker_standard' : 'inpost_courier_standard',
          stage === 'DELIVERED' ? 'delivered' : 'sent',
          r.tracking_number || null, r.label_url || null,
          stage === 'DELIVERED' ? toIso(r.Data_update) : null,
        ]
      );
      shipments += 1;
    }
    if (r.infakt_UUID_number || r.invoice_task_reference_number) {
      const isVat = /vat/i.test(r.invoice_status || '');
      await client.query(
        `insert into wyceny_invoices (wycena_id, kind, infakt_uuid, task_reference_number, status, gross, paid_at, pdf_url)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id, isVat ? 'vat' : 'proforma', r.infakt_UUID_number || null,
          r.invoice_task_reference_number || null,
          r.PAID === 'PAID' ? 'paid' : (r.invoice_status ? 'sent' : 'pending'),
          money(r.kwota_sprzedazy_brutto) ?? money(r.kwota_proponowana_brutto),
          toIso(r.paid_at), r.invoice_url || null,
        ]
      );
      invoices += 1;
    }
  }

  // Wyceny obecne TYLKO u Lorenzo (np. #1862) — ich linki do formularza żyją
  // u klientów, więc wstawiamy wiersz minimalny (arkusz Lorenzo nie ma kolumn
  // pipeline). CRM_CASES pozostaje masterem dla wspólnych ID.
  const missing = [...lorenzo.keys()].filter((id) => !importedIds.includes(id));
  for (const id of missing) {
    const r = lorenzo.get(id);
    await client.query(
      `insert into wyceny (id, typ, status, owner, source, imie_nazwisko, telefon_e164, telefon_digits,
         email, komentarz, partner, items, kwota_proponowana_brutto, form_status, form_token, legacy, created_at)
       values ($1,$2,$3,'Antoni','import',$4,$5,$6,$7,$8,$9,$10,$11,'NEW',$12,$13,coalesce($14, now()))
       on conflict (id) do update set typ=excluded.typ, status=excluded.status,
         imie_nazwisko=excluded.imie_nazwisko, telefon_e164=excluded.telefon_e164,
         telefon_digits=excluded.telefon_digits, email=excluded.email, komentarz=excluded.komentarz,
         partner=excluded.partner, items=excluded.items,
         kwota_proponowana_brutto=excluded.kwota_proponowana_brutto, legacy=excluded.legacy, updated_at=now()`,
      [
        id, r.Typ || 'WYCENA', r.Status || 'Open', r['Imię'] || null, r.Telefon || null,
        digitsOf(r.Telefon).replace(/^48/, '') || null, r.Email || null, r.Komentarz || null,
        r['Partner?'] || null, JSON.stringify(parseItems(r.produkty_json, skuByName)),
        money(r.Kwota), crypto.randomBytes(12).toString('base64url'),
        JSON.stringify({ zrodlo_importu: 'arkusz-lorenzo', data_feedbacku: r['Data Feedbacku'] || undefined }),
        toIso(r['Data stworzenia']),
      ]
    );
  }

  // Sekwencja: nowe wyceny kontynuują numerację arkusza.
  await client.query(`select setval('wyceny_id_seq', (select coalesce(max(id), 1500) from wyceny))`);

  const { rows: [c] } = await client.query('select count(*)::int as n, max(id) as max from wyceny');
  console.log(`OK — wyceny: ${importedIds.length} z arkusza (w bazie ${c.n}, max id ${c.max}), ` +
    `shipments: ${shipments}, invoices: ${invoices}, sku: ${skuCount}, ` +
    `komentarze Lorenzo: ${[...lorenzo.values()].filter((r) => r.Komentarz).length}` +
    (missing.length ? `, dograne z arkusza Lorenzo: ${missing.join(', ')}` : ''));
  await client.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
