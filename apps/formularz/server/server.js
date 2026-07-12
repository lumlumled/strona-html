// ── Publiczne endpointy formularza zamówienia (lumlum.co/pages/formularz) ────
// Zastępują webhooki Make "Formularz na lumlum - Get" i "Formularz LumLum -
// post". Kontrakt odpowiedzi GET jest 1:1 z webhookiem Make (formularz liquid
// nie wymaga zmian logiki), z dwiema świadomymi różnicami z planu:
//   - form_status jest PRAWDZIWY (Make hardkodował "NEW") -> formularz
//     jednorazowy: liquid pokazuje ekran "zamówienie już złożone",
//   - link może nieść token (?t=...) -> stare linki bez tokenu działają
//     w okresie przejściowym, zły token = odmowa.
// POST przyjmuje dzisiejszy payload formularza bez zmian i startuje własny
// pipeline realizacji (apps/formularz/server/pipeline.js, etap 4).
//
// BEZ auth panelowego — to publiczna funkcja; CORS ograniczony do lumlum.co.
require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ limit: '1mb' }));

let client = null;
function getClient() {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Brak SUPABASE_URL lub SUPABASE_SERVICE_ROLE_KEY');
    client = createClient(url, key, { auth: { persistSession: false } });
  }
  return client;
}

// CORS: formularz żyje na lumlum.co (Shopify), endpointy na lumlum.dev.
const ALLOWED_ORIGINS = new Set([
  'https://lumlum.co',
  'https://www.lumlum.co',
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.has(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin))) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
  }
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

function num(v) {
  const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function sumaPozycji(items) {
  return (Array.isArray(items) ? items : []).reduce((a, p) => a + num(p.price) * (num(p.quantity) || 1), 0);
}

// Liquid parsuje rabat24h_wazny_do SZTYWNYM regexem "DD.MM.YYYY HH:mm"
// (czas lokalny przeglądarki ≈ Europe/Warsaw dla klientów PL).
function warsawDDMMYYYYHHmm(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('pl-PL', {
    timeZone: 'Europe/Warsaw', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}`;
}

async function findWycena(id) {
  const supabase = getClient();
  const { data, error } = await supabase.from('wyceny').select('*').eq('id', id).limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

async function logEvent(wycenaId, kind, payload) {
  try {
    await getClient().from('wyceny_events').insert({ wycena_id: wycenaId, kind, payload: payload || null });
  } catch (err) {
    console.error(`Błąd zapisu zdarzenia ${kind}:`, err.message);
  }
}

// Token w linku: stare linki (bez t) przechodzą w okresie przejściowym;
// jawnie zły token = odmowa (ochrona przed enumeracją sekwencyjnych ID).
function tokenOk(wycena, t) {
  if (!t) return true;
  return String(t) === String(wycena.form_token || '');
}

// GET /formularz/api/dane?id=1509[&t=token] — kontrakt 1:1 z webhookiem GET
// Make + prawdziwy form_status.
app.get('/api/dane', async (req, res) => {
  try {
    const id = Number(String(req.query.id || '').replace(/\D/g, ''));
    if (!id) return res.status(400).json({ error: 'Brak ID zamówienia' });
    const wycena = await findWycena(id);
    if (!wycena || !tokenOk(wycena, req.query.t)) {
      return res.status(404).json({ error: 'Nie znaleziono zamówienia' });
    }

    const suma = sumaPozycji(wycena.items);
    const kwota = wycena.kwota_proponowana_brutto != null ? num(wycena.kwota_proponowana_brutto) : suma;
    // "Zniżka kwota" jak w Make: kwota_proponowana − suma pozycji (ujemna
    // przy rabacie). Bez pozycji nie ma z czego liczyć -> 0.
    const discount = suma ? Math.round((kwota - suma) * 100) / 100 : 0;

    const rabatAktywny = wycena.rabat24h_kwota && wycena.rabat24h_wazny_do;

    res.json({
      id: `#${wycena.id}`,
      form_status: wycena.form_status || 'NEW',
      produkty: Array.isArray(wycena.items) ? wycena.items : [],
      kwota_proponowana_brutto: kwota,
      discount_amount: discount,
      rabat24h_kwota: rabatAktywny ? num(wycena.rabat24h_kwota) : 0,
      rabat24h_wazny_do: rabatAktywny ? warsawDDMMYYYYHHmm(wycena.rabat24h_wazny_do) : '',
      prefill: {
        first_name: wycena.first_name || '',
        last_name: wycena.last_name || '',
        email: wycena.email || '',
        phone: wycena.telefon_digits || '',
        ship_street: wycena.ship_street || '',
        ship_house_no: wycena.ship_house_no || '',
        ship_flat_no: wycena.ship_flat_no || '',
        ship_postcode: wycena.ship_postcode || '',
        ship_city: wycena.ship_city || '',
        ship_country: wycena.ship_country || '',
        delivery_method: '',
        payment_method: '',
        invoice_enabled: false,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Błąd serwera' });
  }
});

// Pola z formularza zapisywane wprost do kolumn wyceny.
const FORM_FIELDS = [
  'first_name', 'last_name', 'ship_street', 'ship_house_no', 'ship_flat_no',
  'ship_postcode', 'ship_city', 'ship_country', 'punkt_odbioru',
  'punkt_odbioru_adres', 'payment_method', 'delivery_method',
  'invoice_company_nip', 'invoice_company_name',
];

// POST /formularz/api/zapis — dzisiejszy payload POST formularza.
// Odrzuca zapis gdy wycena ma już SUBMITTED (double-submit / dwie karty).
app.post('/api/zapis', async (req, res) => {
  try {
    const body = req.body || {};
    const id = Number(String(body.id || '').replace(/\D/g, ''));
    if (!id) return res.status(400).json({ error: 'Brak ID zamówienia' });
    const wycena = await findWycena(id);
    if (!wycena || !tokenOk(wycena, req.query.t || body.t)) {
      return res.status(404).json({ error: 'Nie znaleziono zamówienia' });
    }
    if (wycena.form_status === 'SUBMITTED') {
      await logEvent(id, 'form.duplicate_submit', { ip: req.headers['x-forwarded-for'] || '' });
      return res.status(409).json({ error: 'Zamówienie zostało już złożone' });
    }

    const patch = {
      form_status: 'SUBMITTED',
      form_submitted_at: body.form_submitted_at || new Date().toISOString(),
      process_stage: 'SUBMITTED',
      typ: 'ZAMÓWIENIE',
      updated_at: new Date().toISOString(),
    };
    FORM_FIELDS.forEach((f) => { if (body[f] !== undefined) patch[f] = String(body[f] || '') || null; });
    if (body.email) patch.email = String(body.email).toLowerCase().trim();
    if (body.phone_e164 || body.phone) {
      patch.telefon_e164 = String(body.phone_e164 || body.phone).replace(/^\+/, '');
      patch.telefon_digits = String(body.phone_number || patch.telefon_e164).replace(/\D/g, '').replace(/^48/, '');
    }
    // Pełny zestaw pól faktury (firma / prywatna-inny adres) do jsonb —
    // pipeline faktur czyta stąd, nic z formularza nie ginie.
    const invoiceDane = {};
    Object.keys(body).forEach((k) => {
      if (k.startsWith('invoice_')) invoiceDane[k] = body[k];
    });
    if (Object.keys(invoiceDane).length) patch.invoice_dane = invoiceDane;

    const { error } = await getClient().from('wyceny').update(patch).eq('id', id);
    if (error) throw error;
    await logEvent(id, 'form.submitted', {
      payment_method: patch.payment_method,
      delivery_method: patch.delivery_method,
      punkt_odbioru: patch.punkt_odbioru || '',
      ship_country: patch.ship_country || '',
    });

    // Start pipeline'u realizacji — SYNCHRONICZNIE przed odpowiedzią
    // (serverless umiera po res.json; formularz i tak czeka na overlay,
    // a maxDuration=180 s starcza z zapasem). Błąd pipeline'u nie wywala
    // zapisu zamówienia — worker retry podejmie z bazy.
    try {
      const { startPipeline } = require('../../shared/server/wyceny-pipeline');
      await startPipeline(getClient(), id);
    } catch (err) {
      console.error(`Pipeline start ${id}:`, err.message);
    }

    res.json({ ok: true, id: `#${id}` });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Błąd serwera' });
  }
});

// POST /formularz/api/infakt-webhook — hak "faktura opłacona" z inFakt
// (przepięty z Make przy cutoverze). Kształt payloadu jak w Make #3:
// event.name == 'invoice_paid', resource.uuid == uuid opłaconej proformy.
app.post('/api/infakt-webhook', async (req, res) => {
  try {
    const body = req.body || {};
    const eventName = body.event?.name || body.event_name || '';
    const uuid = body.resource?.uuid || body.invoice?.uuid || '';
    if (eventName !== 'invoice_paid' || !uuid) {
      return res.json({ ok: true, skipped: eventName || 'no-event' });
    }
    const { onInvoicePaid } = require('../../shared/server/wyceny-pipeline');
    const result = await onInvoicePaid(getClient(), uuid);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('inFakt webhook:', err.message);
    // 200 mimo błędu — inFakt nie musi retry'ować; nasz worker dokończy
    res.json({ ok: false, error: err.message.slice(0, 200) });
  }
});

// /formularz/api/cron/worker — odpalany przez pg_cron + pg_net (Vercel Hobby:
// crony częstsze niż 1/dzień muszą iść spoza vercel.json, jak w komunikatorze;
// pg_net woła GET z ?secret=, ręcznie można POST z Bearerem).
async function cronWorker(req, res) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '') || req.query.token || req.query.secret;
    if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'Zły token' });
    }
    const { runWorker } = require('../../shared/server/wyceny-pipeline');
    const raport = await runWorker(getClient());
    res.json({ ok: true, ...raport });
  } catch (err) {
    console.error('Worker:', err.message);
    res.status(502).json({ error: err.message.slice(0, 300) });
  }
}
app.post('/api/cron/worker', cronWorker);
app.get('/api/cron/worker', cronWorker);

// GET /formularz/test?id=...&t=... — strona testowa formularza: DOKŁADNIE ta
// sekcja liquid, która przy cutoverze (noc 2) trafi do live theme Shopify
// (apps/formularz/liquid/formularz.liquid — czysty HTML/CSS/JS, zero tagów
// liquid poza schema, więc renderuje się identycznie poza theme). Testy bez
// dotykania produkcyjnego lumlum.co/pages/formularz.
const fsMod = require('fs');
const pathMod = require('path');
let testPageCache = null;
app.get('/test', (req, res) => {
  if (!testPageCache) {
    let sekcja = fsMod.readFileSync(pathMod.join(__dirname, '..', 'liquid', 'formularz.liquid'), 'utf8');
    sekcja = sekcja.replace(/{%\s*schema\s*%}[\s\S]*?{%\s*endschema\s*%}/, '');
    testPageCache = `<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Formularz LumLum — TEST</title>
<style>body{margin:0;background:#0b0b0b;font-family:'Assistant',system-ui,-apple-system,sans-serif;}
.test-banner{position:fixed;top:0;left:0;right:0;z-index:999;background:#b5433f;color:#fff;font-size:12px;font-weight:700;text-align:center;padding:4px;letter-spacing:.05em;}</style>
</head><body><div class="test-banner">WERSJA TESTOWA — lumlum.dev (produkcyjny formularz nietknięty)</div>
<div style="height:26px"></div>${sekcja}</body></html>`;
  }
  res.type('html').send(testPageCache);
});

// ── Publiczne linki do PDF etykiety i faktury (BEZ logowania) ────────────────
// Zastępują dawne udostępniane linki z Google Drive: klik = PDF inline, gotowy
// do druku (AirPrint z telefonu). Zabezpieczone tokenem wyceny (form_token)
// w linku — model "anyone with the link", chroni przed zgadywaniem numerów.
// Karta wyceny buduje te linki z form_token; endpoint sprawdza, że przesyłka/
// faktura należy do wyceny o tym tokenie.
async function wycenaForToken(wycenaId, t) {
  const wycena = await findWycena(wycenaId);
  if (!wycena) return null;
  const token = String(wycena.form_token || '');
  if (!token || String(t || '') !== token) return null;
  return wycena;
}

// GET /formularz/api/etykieta/:shipmentId?t=token — etykieta ShipX (PDF inline).
app.get('/api/etykieta/:shipmentId', async (req, res) => {
  try {
    const shipmentId = String(req.params.shipmentId || '');
    if (!/^[A-Za-z0-9-]+$/.test(shipmentId)) return res.status(400).send('Zły identyfikator');
    const { data } = await getClient().from('wyceny_shipments')
      .select('wycena_id').eq('shipment_id', shipmentId).limit(1);
    const ship = data && data[0];
    if (!ship || !(await wycenaForToken(ship.wycena_id, req.query.t))) {
      return res.status(404).send('Nie znaleziono etykiety');
    }
    const shipx = require('../../shared/server/wyceny-shipx');
    const pdf = await shipx.downloadLabel(shipmentId);
    res.type('application/pdf').set('Content-Disposition', 'inline; filename="etykieta.pdf"').send(pdf);
  } catch (err) {
    console.error('Etykieta publiczna:', err.message);
    res.status(502).send('Nie udało się pobrać etykiety');
  }
});

// GET /formularz/api/faktura/:uuid?t=token — faktura/proforma inFakt (PDF inline).
app.get('/api/faktura/:uuid', async (req, res) => {
  try {
    const uuid = String(req.params.uuid || '');
    if (!/^[A-Za-z0-9-]+$/.test(uuid)) return res.status(400).send('Zły identyfikator');
    const { data } = await getClient().from('wyceny_invoices')
      .select('wycena_id, status').eq('infakt_uuid', uuid).limit(1);
    const inv = data && data[0];
    if (!inv || inv.status === 'deleted' || !(await wycenaForToken(inv.wycena_id, req.query.t))) {
      return res.status(404).send('Nie znaleziono faktury');
    }
    const infakt = require('../../shared/server/wyceny-infakt');
    const pdf = await infakt.downloadPdf(uuid);
    res.type('application/pdf').set('Content-Disposition', 'inline; filename="faktura.pdf"').send(pdf);
  } catch (err) {
    console.error('Faktura publiczna:', err.message);
    res.status(502).send('Nie udało się pobrać faktury');
  }
});

const PORT = process.env.PORT || 3007;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Formularz API działa na http://localhost:${PORT}`);
  });
}

module.exports = app;
