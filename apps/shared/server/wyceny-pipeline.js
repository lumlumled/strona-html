// ── Pipeline realizacji zamówienia (maszyna stanów wycen) ────────────────────
// Zastępuje ~20 gałęzi Make (Formularz POST, #3 PAID, #4 Sprawdzenie dostawy)
// kombinacją tych samych kroków z parametrami:
//   POBRANIE:  przesyłka (COD+ubezpieczenie) -> proforma "delivery" -> mail
//              z trackingiem i proformą -> po DORĘCZENIU faktura VAT (paid),
//              KSeF, delete proformy, mail z VAT.
//   PRZELEW:   proforma "transfer" + szybka płatność -> mail z linkiem ->
//              po OPŁACENIU (webhook inFakt) przesyłka (bez COD), faktura VAT
//              (paid), KSeF, delete proformy, mail z VAT i trackingiem.
//   ZAGRANICA: routing przewoźnika (2026-07-14): Polska = TYLKO InPost;
//              zagranica -> Furgonetka FULL AUTO (najtańszy z allow-listy,
//              order, etykieta A6, push z odbiorem) dla UE; poza UE (dane
//              celne) i firma zagraniczna (odwrotne obciążenie) ->
//              wstrzymanie + push do Antoniego.
//
// Idempotencja: lock na wycenie (lock_token + lock_expires_at) + wznowienie
// od brakującego kroku (istniejąca przesyłka/faktura nie jest tworzona
// ponownie). Każdy krok loguje się do wyceny_events.
const crypto = require('crypto');
const infakt = require('./wyceny-infakt');
const shipx = require('./wyceny-shipx');
const furgonetka = require('./wyceny-furgonetka');
const mailer = require('./wyceny-mailer');
// "Cena, którą klient realnie płaci" (rabat czasowy obniża cenę ostateczną).
const { cenaFinalna } = require('./wyceny-cena');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function logEvent(db, wycenaId, kind, payload) {
  const { error } = await db.from('wyceny_events').insert({ wycena_id: wycenaId, kind, payload: payload || null });
  if (error) console.error(`Event ${kind} wyceny ${wycenaId}:`, error.message);
}

function num(v) {
  const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

// Godzina lokalna Warszawy (0–23) — okna sprawdzania trackingu (decyzja
// Antoniego 2026-07-13): nadanie sprawdzamy 17–18, doręczenie 10–16. Dzięki
// temu odpytujemy ShipX tylko wtedy, gdy realnie coś się dzieje, i nie
// wpisujemy "doręczono" tego samego dnia, co nadanie (stary bug z Make).
function warsawHour() {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Warsaw', hour: '2-digit', hour12: false,
  }).format(new Date()));
}
// Okno „czy nadana" (created/confirmed -> sent): raz dziennie, 17:00–17:59.
function wOknieNadania() {
  const h = warsawHour();
  return h >= 17 && h < 18;
}
// Okno „czy dostarczona" (sent -> delivered): 11:00–16:59, co przebieg workera
// (cron */20 → co 20 min). Kończy się tuż przed oknem nadania (17:00).
function wOknieDoreczenia() {
  const h = warsawHour();
  return h >= 11 && h < 17;
}

// Push „Nowe do spakowania" — do adminów (Antoni) + env FULFILLMENT_NOTIFY /
// WYCENY_EXTRA_NOTIFY. Nigdy nie wywala pipeline'u (błędy tylko logujemy).
// Odpala się przy PRZEJŚCIU zamówienia w stan gotowy do pakowania (opłacony
// przelew / ręczne opłacenie); pobranie ma już push „Formularz wypełniony".
async function notifyFulfillment(db, wycena) {
  try {
    const push = require('./push');
    if (!push || !push.notifyUser) return;
    const wanted = new Set(
      String(process.env.FULFILLMENT_NOTIFY || process.env.WYCENY_EXTRA_NOTIFY || 'Antoni')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    );
    const { data } = await db.from('app_users').select('id,name,role').eq('active', true);
    const targets = (data || []).filter((u) => u.role === 'admin' || wanted.has(String(u.name || '').trim().toLowerCase()));
    const nazwa = wycena.imie_nazwisko || [wycena.first_name, wycena.last_name].filter(Boolean).join(' ').trim();
    const kwota = cenaFinalna(wycena);
    for (const u of targets) {
      await push.notifyUser(() => db, u.id, {
        title: 'Nowe do spakowania',
        body: `#${wycena.id}${nazwa ? ` · ${nazwa}` : ''}${kwota != null ? ` · ${num(kwota)} zł` : ''}`,
        url: '/fulfillment/',
        tag: `fulfillment-${wycena.id}`,
      });
    }
  } catch (err) {
    console.warn(`Push fulfillment ${wycena?.id} nie wyszedł:`, err.message);
  }
}

// Weekend-lean (§4 planu furgonetka-jutro): zamówienie GOTOWE w sobotę →
// push „nadać dziś?" — nie nadasz, pojedzie dopiero w poniedziałek. Pełna
// logika czw→pt (paczka sobotnia) świadomie odłożona na v2.
function jestSobotaWarszawa() {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw', weekday: 'short' })
    .format(new Date()) === 'Sat';
}
async function pushWeekend(db, wycena) {
  if (!jestSobotaWarszawa()) return;
  await pushDoAdminow(db, {
    title: 'Sobota — nadać dziś?',
    body: `#${wycena.id} gotowe do pakowania. Nie nadasz dziś — pojedzie w poniedziałek.`,
    url: '/fulfillment/',
    tag: `weekend-${wycena.id}`,
  });
}

// Wyliczenia 1:1 z Make (moduły 301/302/307):
//   rabat_aktywny  — rabat 24h z przyszłym terminem
//   kwota_finalna  — kwota_proponowana − aktywny rabat 24h
//   rabat_laczny   — (kwota_proponowana − suma pozycji) − aktywny rabat 24h
//                    (ujemna pozycja "Rabat" na fakturze)
function policzKwoty(wycena) {
  const suma = (wycena.items || []).reduce((a, p) => a + num(p.price) * (num(p.quantity) || 1), 0);
  const kwotaBaza = wycena.kwota_proponowana_brutto != null ? num(wycena.kwota_proponowana_brutto) : suma;
  // Kwota, którą klient realnie płaci: kwota sprzedaży (zamrożona przy złożeniu
  // zamówienia) albo proponowana − rabat czasowy. Faktura MUSI zgadzać się z tą
  // liczbą (jedno źródło prawdy: wyceny-cena.js).
  const finalna = cenaFinalna(wycena);
  const kwotaFinalna = Math.round((finalna != null ? num(finalna) : kwotaBaza) * 100) / 100;
  // Ujemna pozycja "Rabat" na fakturze tak, by suma pozycji + Rabat = kwota
  // finalna (obejmuje i zniżkę proponowana-vs-pozycje, i rabat czasowy).
  const rabatLaczny = suma
    ? Math.round((kwotaFinalna - suma) * 100) / 100
    : Math.round((kwotaFinalna - kwotaBaza) * 100) / 100;
  return { suma, kwotaFinalna, rabatLaczny };
}

function jestLocker(wycena) {
  return String(wycena.punkt_odbioru || '').replace(/[,\s]/g, '').length > 3;
}

function jestZagranica(wycena) {
  return Boolean(wycena.ship_country && wycena.ship_country !== 'PL');
}

// ── Routing przewoźnika ──────────────────────────────────────────────────────
// Decyzja Antoniego 2026-07-14 (nadpisuje dogrywkę ze spec): po Polsce TYLKO
// i wyłącznie InPost — także przy obcym numerze telefonu (paczkomat i tak jest
// ukrywany w formularzu bez polskiego prefiksu; SMS-y mogą nie dojść — trudno).
// Furgonetka = wyłącznie dostawa za granicę.
function jestFurgonetka(wycena) {
  return jestZagranica(wycena);
}

// Duty-guard: UE (unia celna) = full auto; cała reszta (US, UK, CH, NO, UA, …)
// wymaga danych celnych `duty`, których nie wysyłamy → order by padł →
// wstrzymujemy z pushem zamiast produkować błąd.
const UE = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
  'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);
function wymagaCla(wycena) {
  return jestZagranica(wycena) && !UE.has(String(wycena.ship_country || '').toUpperCase());
}

// Firma na fakturze: NIP jak w wyceny-infakt (firma = NIP > 6 znaków) LUB nazwa
// firmy (zagraniczne firmy nie mają polskiego NIP-u). Dla zagranicy firma =
// odwrotne obciążenie, polski 23% VAT byłby błędny → faktura ręcznie.
function firmaNaFakturze(wycena) {
  return String(wycena.invoice_company_nip || '').trim().length > 6
    || String(wycena.invoice_company_name || '').trim().length > 1;
}

// Push do adminów (Antoni) — alerty pipeline'u zagranicy (wstrzymania, kurier
// zamówiony). Nigdy nie wywala pipeline'u.
async function pushDoAdminow(db, { title, body, url, tag }) {
  try {
    const push = require('./push');
    if (!push || !push.notifyUser) return;
    const { data } = await db.from('app_users').select('id,role').eq('active', true);
    for (const u of (data || []).filter((x) => x.role === 'admin')) {
      await push.notifyUser(() => db, u.id, { title, body, url, tag });
    }
  } catch (err) {
    console.warn('Push adminów nie wyszedł:', err.message);
  }
}

async function loadWycena(db, id) {
  const { data, error } = await db.from('wyceny').select('*').eq('id', id).limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

// ── Lock (idempotencja między webhookiem, workerem i retry) ─────────────────
async function acquireLock(db, id) {
  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const { data, error } = await db.from('wyceny')
    .update({ lock_token: token, lock_expires_at: expires, worker_last_run_at: now })
    .eq('id', id)
    .or(`lock_expires_at.is.null,lock_expires_at.lt.${now}`)
    .select('id');
  if (error) throw error;
  return data && data.length ? token : null;
}

async function releaseLock(db, id, token, patch = {}) {
  await db.from('wyceny')
    .update({ ...patch, lock_token: null, lock_expires_at: null, updated_at: new Date().toISOString() })
    .eq('id', id).eq('lock_token', token);
}

async function zapiszBlad(db, id, step, err) {
  console.error(`Pipeline ${id} / ${step}:`, err.message);
  await db.from('wyceny').update({
    worker_last_error: `${step}: ${err.message}`.slice(0, 500),
    process_stage: 'ERROR',
    updated_at: new Date().toISOString(),
  }).eq('id', id);
  await logEvent(db, id, 'pipeline.error', { step, error: err.message.slice(0, 500) });
}

// ── Kroki ────────────────────────────────────────────────────────────────────

// Przesyłka ShipX + polling trackingu (ShipX potwierdza ofertę asynchronicznie,
// zwykle w sekundy). kind: 'order' | 'reship'.
async function krokPrzesylka(db, wycena, { codAmount, insuranceAmount, kind = 'order' }) {
  const locker = jestLocker(wycena);
  const created = await shipx.createShipment(wycena, {
    locker,
    codAmount,
    insuranceAmount,
    reference: wycena.id,
  });
  const { data: rows, error } = await db.from('wyceny_shipments').insert({
    wycena_id: wycena.id,
    provider: 'shipx',
    kind,
    shipment_id: String(created.id),
    service: created.service || (locker ? 'inpost_locker_standard' : 'inpost_courier_standard'),
    status: 'created',
    raw_status: created.status || 'created',
    tracking_number: created.tracking_number || null,
    target_point: locker ? String(wycena.punkt_odbioru || '').split(',')[0].trim() : null,
    cod_amount: codAmount || null,
    insurance_amount: insuranceAmount || null,
  }).select('*');
  if (error) throw error;
  let shipment = rows[0];
  await logEvent(db, wycena.id, kind === 'reship' ? 'shipment.reship' : 'shipment.created', {
    shipment_id: shipment.shipment_id, service: shipment.service, cod: codAmount || 0,
  });

  // polling po tracking_number (max ~50 s; jak nie zdąży — dociągnie worker)
  for (let i = 0; i < 10 && !shipment.tracking_number; i += 1) {
    await sleep(5000);
    try {
      const fresh = await shipx.getShipment(shipment.shipment_id);
      if (fresh.tracking_number || fresh.status !== shipment.raw_status) {
        const patch = {
          tracking_number: fresh.tracking_number || null,
          raw_status: fresh.status || shipment.raw_status,
          status: fresh.status === 'confirmed' ? 'confirmed' : shipment.status,
          updated_at: new Date().toISOString(),
        };
        await db.from('wyceny_shipments').update(patch).eq('id', shipment.id);
        shipment = { ...shipment, ...patch };
      }
    } catch (err) {
      console.error(`Polling przesyłki ${shipment.shipment_id}:`, err.message);
    }
  }
  return shipment;
}

// Przesyłka zagraniczna przez Furgonetkę — FULL AUTO (decyzja Antoniego,
// spec furgonetka-zagranica): najtańszy DOZWOLONY kurier (DPD/DHL/FedEx/UPS)
// → order (kupno) → etykieta A6 → wiersz wyceny_shipments + push „kurier
// zamówiony". Wołane TYLKO dla UE (duty-guard w utworzPrzesylkeWgRoutingu).
async function krokPrzesylkaFurgonetka(db, wycena, { kind = 'order' } = {}) {
  furgonetka.useTokenStore(furgonetka.makeSupabaseTokenStore(db));
  const wynik = await furgonetka.zamowPrzesylkeZagraniczna(wycena);
  // Jeśli order sam umówił odbiór (pickup_date w paczce) — stemplujemy od razu,
  // chip „kurier zamówiony" świeci, a „Drukuj etykietę" nie umawia drugi raz.
  const pickupDate = wynik.pickup && wynik.pickup.date;
  const { data: rows, error } = await db.from('wyceny_shipments').insert({
    wycena_id: wycena.id,
    provider: 'furgonetka',
    kind,
    shipment_id: String(wynik.shipment_id),
    service: wynik.service || null,
    status: 'confirmed', // zamówiona = etykieta jest → od razu gotowa do pakowania
    raw_status: 'ordered',
    tracking_number: wynik.tracking_number || null,
    dispatch_order_id: pickupDate ? `pickup:${pickupDate}` : null,
    dispatch_ordered_at: pickupDate ? new Date().toISOString() : null,
  }).select('*');
  if (error) throw error;
  const shipment = rows[0];
  await logEvent(db, wycena.id, kind === 'reship' ? 'shipment.reship' : 'shipment.created', {
    provider: 'furgonetka', shipment_id: String(wynik.shipment_id), service: wynik.service,
    cena_kuriera: wynik.cena_kuriera, order_uuid: wynik.order_uuid, pickup: wynik.pickup,
  });
  await pushDoAdminow(db, {
    title: `Kurier ${String(wynik.service || 'Furgonetka').toUpperCase()} zamówiony`,
    body: `#${wycena.id} · ${wycena.ship_country || 'PL'}`
      + (wynik.pickup && wynik.pickup.date ? ` · odbiór ${wynik.pickup.date}` : '')
      + (wynik.cena_kuriera != null ? ` · ${wynik.cena_kuriera} zł` : ''),
    url: '/fulfillment/',
    tag: `furgonetka-${wycena.id}`,
  });
  return shipment;
}

// Przesyłka po opłaceniu wg ROUTINGU przewoźnika: InPost (PL + polski numer),
// Furgonetka (zagranica / obcy numer, tylko UE), albo wstrzymanie z pushem
// (poza UE = dane celne). Zwraca wiersz przesyłki albo null (wstrzymane).
async function utworzPrzesylkeWgRoutingu(db, wycena, { insuranceAmount } = {}) {
  if (!jestFurgonetka(wycena)) {
    return krokPrzesylka(db, wycena, { codAmount: null, insuranceAmount });
  }
  if (wymagaCla(wycena)) {
    await logEvent(db, wycena.id, 'pipeline.hold_duty', { kraj: wycena.ship_country });
    await pushDoAdminow(db, {
      title: 'Zagranica poza UE — wyślij ręcznie',
      body: `#${wycena.id} · ${wycena.ship_country} — wymaga danych celnych; zamów kuriera w panelu Furgonetki`,
      url: '/fulfillment/',
      tag: `hold-duty-${wycena.id}`,
    });
    return null;
  }
  return krokPrzesylkaFurgonetka(db, wycena);
}

// Proforma inFakt; zwraca wiersz wyceny_invoices (uuid może dociągnąć worker).
async function krokProforma(db, wycena, { services, paymentMethod, kwotaFinalna }) {
  const payload = infakt.buildProforma(wycena, { services, paymentMethod });
  const result = await infakt.createInvoiceAsync(payload);
  const { data: rows, error } = await db.from('wyceny_invoices').insert({
    wycena_id: wycena.id,
    kind: 'proforma',
    infakt_uuid: result.uuid,
    task_reference_number: result.taskReference,
    status: result.uuid ? 'issued' : 'pending',
    gross: kwotaFinalna,
  }).select('*');
  if (error) throw error;
  await logEvent(db, wycena.id, 'invoice.created', { kind: 'proforma', uuid: result.uuid, payment_method: paymentMethod });
  return rows[0];
}

// Faktura VAT z opłaconej proformy + KSeF + delete proformy (kolejność
// jak w #3: create -> pdf -> delete proformy -> KSeF).
async function krokFakturaKoncowa(db, wycena, proformaRow) {
  const proforma = await infakt.getInvoice(proformaRow.infakt_uuid);
  const vatPayload = infakt.buildVatFromProforma(proforma);
  const result = await infakt.createInvoiceAsync(vatPayload);
  if (!result.uuid) throw new Error('inFakt nie zwrócił uuid faktury VAT (async pending)');
  const { data: rows, error } = await db.from('wyceny_invoices').insert({
    wycena_id: wycena.id,
    kind: 'vat',
    infakt_uuid: result.uuid,
    task_reference_number: result.taskReference,
    status: 'paid',
    gross: proforma.gross_price / 100,
    paid_at: new Date().toISOString(),
  }).select('*');
  if (error) throw error;
  const pdf = await infakt.downloadPdf(result.uuid);
  try {
    await infakt.deleteInvoice(proformaRow.infakt_uuid);
    await db.from('wyceny_invoices').update({ status: 'deleted', updated_at: new Date().toISOString() })
      .eq('id', proformaRow.id);
  } catch (err) {
    console.error(`Delete proformy ${proformaRow.infakt_uuid}:`, err.message);
  }
  try {
    await infakt.sendToKsef(result.uuid);
    await db.from('wyceny_invoices').update({ ksef_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', rows[0].id);
  } catch (err) {
    console.error(`KSeF ${result.uuid}:`, err.message);
    await logEvent(db, wycena.id, 'pipeline.error', { step: 'ksef', error: err.message.slice(0, 300) });
  }
  await logEvent(db, wycena.id, 'invoice.created', { kind: 'vat', uuid: result.uuid });
  return { vatRow: rows[0], pdf };
}

async function krokMail(db, wycena, { subject, text, attachments, reply = false }) {
  const legacy = wycena.legacy || {};
  const sent = await mailer.sendMail(db, {
    to: wycena.email,
    subject,
    text,
    attachments,
    threadId: reply ? legacy.mail_thread_id || null : null,
  });
  if (!legacy.mail_thread_id && sent.threadId) {
    await db.from('wyceny').update({
      legacy: { ...legacy, mail_thread_id: sent.threadId },
      updated_at: new Date().toISOString(),
    }).eq('id', wycena.id);
  }
  await logEvent(db, wycena.id, 'mail.sent', { subject, to: wycena.email });
  return sent;
}

// ── Główne przejścia ─────────────────────────────────────────────────────────

// Po submicie formularza (POST /formularz/api/zapis) i przy retry z workera.
async function startPipeline(db, wycenaId) {
  const token = await acquireLock(db, wycenaId);
  if (!token) return { skipped: 'locked' };
  const wycena = await loadWycena(db, wycenaId);
  try {
    if (!wycena || wycena.form_status !== 'SUBMITTED') {
      await releaseLock(db, wycenaId, token);
      return { skipped: 'not-submitted' };
    }
    const { kwotaFinalna, rabatLaczny } = policzKwoty(wycena);
    // Dopłata do wysyłki zagranicznej (PL=0, Europa=50, poza=100) doliczana do
    // faktury — ta sama reguła, którą klient widzi w formularzu.
    const doplataWysylka = infakt.shippingSurchargePLN(wycena.ship_country);
    const services = infakt.buildServices(wycena.items, rabatLaczny, doplataWysylka);
    const isCod = String(wycena.payment_method || '').toLowerCase() !== 'transfer';
    const zagranica = jestZagranica(wycena);

    // wznowienie: co już istnieje?
    const [{ data: shipments }, { data: invoices }] = await Promise.all([
      db.from('wyceny_shipments').select('*').eq('wycena_id', wycenaId).eq('kind', 'order'),
      db.from('wyceny_invoices').select('*').eq('wycena_id', wycenaId).eq('kind', 'proforma'),
    ]);

    // Firma zagraniczna = odwrotne obciążenie, polski 23% VAT byłby błędny —
    // NIE wystawiamy nic automatycznie (decyzja Antoniego, spec zagranica).
    // Antoni: FV ręcznie, potem „Oznacz opłacone" (markPaidAndShip bez proformy
    // zrobi przesyłkę wg routingu). Stan HOLD_MANUAL jest poza retry workera.
    if (zagranica && firmaNaFakturze(wycena) && !(invoices || []).length) {
      await logEvent(db, wycenaId, 'pipeline.hold_b2b_zagranica', {
        kraj: wycena.ship_country, nip: wycena.invoice_company_nip || null,
      });
      await pushDoAdminow(db, {
        title: 'Firma zagraniczna — faktura ręcznie',
        body: `#${wycena.id} · ${wycena.ship_country} · odwrotne obciążenie — wystaw FV ręcznie, potem „Oznacz opłacone"`,
        url: '/sprzedaze/',
        tag: `hold-b2b-${wycena.id}`,
      });
      await releaseLock(db, wycenaId, token, {
        process_stage: 'HOLD_MANUAL',
        status: 'Waiting for payment',
        worker_last_error: null,
      });
      return { ok: true, path: 'hold-b2b-zagranica' };
    }

    if (isCod) {
      // POBRANIE: przesyłka z COD od razu, proforma "delivery", mail z trackingiem
      let shipment = (shipments || [])[0];
      if (!shipment && !jestFurgonetka(wycena)) {
        shipment = await krokPrzesylka(db, wycena, { codAmount: kwotaFinalna, insuranceAmount: kwotaFinalna });
      } else if (!shipment) {
        // Pobranie nie jeździ Furgonetką (v1 bez COD w payloadzie); formularz
        // blokuje COD dla zagranicy, więc to czysty bezpiecznik na ręczne wyceny.
        await logEvent(db, wycenaId, 'pipeline.manual_shipping_needed', { kraj: wycena.ship_country || 'PL', powod: 'cod-poza-inpost' });
        await pushDoAdminow(db, {
          title: 'Pobranie poza InPostem — wyślij ręcznie',
          body: `#${wycena.id} · obcy numer/kraj — zamów kuriera ręcznie`,
          url: '/fulfillment/',
          tag: `hold-cod-${wycena.id}`,
        });
      }
      let proformaRow = (invoices || [])[0];
      if (!proformaRow) {
        proformaRow = await krokProforma(db, wycena, { services, paymentMethod: 'delivery', kwotaFinalna });
      }
      if (proformaRow.infakt_uuid && wycena.email) {
        const pdf = await infakt.downloadPdf(proformaRow.infakt_uuid);
        await krokMail(db, wycena, {
          subject: `Numer śledzenia zamówienia #${wycena.id}`,
          text: mailer.MAILE.codZProforma(shipment?.tracking_number || '(numer wkrótce)').text,
          attachments: [{ filename: `proforma-${wycena.id}.pdf`, data: pdf }],
        });
      }
      if (shipment) await pushWeekend(db, wycena);
      await releaseLock(db, wycenaId, token, {
        process_stage: 'SHIPPED',
        status: 'Fulfilled',
        worker_last_error: null,
      });
      return { ok: true, path: 'cod' };
    }

    // PRZELEW: proforma "transfer" + szybka płatność, przesyłka po opłaceniu
    let proformaRow = (invoices || [])[0];
    if (!proformaRow) {
      proformaRow = await krokProforma(db, wycena, { services, paymentMethod: 'transfer', kwotaFinalna });
    }
    let paymentLink = null;
    if (proformaRow.infakt_uuid) {
      try {
        paymentLink = await infakt.createQuickPayment(proformaRow.infakt_uuid);
        if (paymentLink) {
          await db.from('wyceny_invoices').update({ quick_payment_url: paymentLink, updated_at: new Date().toISOString() })
            .eq('id', proformaRow.id);
        }
      } catch (err) {
        console.error(`Szybka płatność ${proformaRow.infakt_uuid}:`, err.message);
      }
      if (wycena.email) {
        const pdf = await infakt.downloadPdf(proformaRow.infakt_uuid);
        await krokMail(db, wycena, {
          subject: `Faktura proforma za zamówienie #${wycena.id}`,
          text: mailer.MAILE.przelewZProforma(paymentLink || '(link niedostępny — dane do przelewu na proformie)').text,
          attachments: [{ filename: `proforma-${wycena.id}.pdf`, data: pdf }],
        });
      }
    }
    await releaseLock(db, wycenaId, token, {
      process_stage: 'PROFORMA_SENT',
      status: 'Waiting for payment',
      worker_last_error: null,
    });
    return { ok: true, path: 'transfer' };
  } catch (err) {
    await zapiszBlad(db, wycenaId, 'startPipeline', err);
    await releaseLock(db, wycenaId, token);
    throw err;
  }
}

// Webhook inFakt "faktura opłacona" (event invoice_paid, resource.uuid).
async function onInvoicePaid(db, uuid) {
  const { data: invRows, error } = await db.from('wyceny_invoices')
    .select('*').eq('infakt_uuid', uuid).eq('kind', 'proforma').limit(1);
  if (error) throw error;
  const proformaRow = invRows && invRows[0];
  if (!proformaRow) return { skipped: 'unknown-invoice' };
  const wycenaId = proformaRow.wycena_id;

  const token = await acquireLock(db, wycenaId);
  if (!token) return { skipped: 'locked' };
  try {
    const wycena = await loadWycena(db, wycenaId);
    if (!wycena || wycena.paid) {
      await releaseLock(db, wycenaId, token);
      return { skipped: 'already-paid' };
    }
    await db.from('wyceny').update({ paid: true, paid_at: new Date().toISOString() }).eq('id', wycenaId);
    await db.from('wyceny_invoices').update({ status: 'paid', paid_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', proformaRow.id);
    await logEvent(db, wycenaId, 'invoice.paid', { uuid });

    const { kwotaFinalna } = policzKwoty(wycena);

    // Przesyłka wg routingu (InPost / Furgonetka UE / wstrzymanie poza-UE).
    const { data: existing } = await db.from('wyceny_shipments')
      .select('*').eq('wycena_id', wycenaId).eq('kind', 'order');
    const shipment = (existing || [])[0]
      || await utworzPrzesylkeWgRoutingu(db, wycena, { insuranceAmount: kwotaFinalna });

    const { pdf } = await krokFakturaKoncowa(db, wycena, proformaRow);
    if (wycena.email) {
      await krokMail(db, wycena, {
        subject: `Faktura VAT za zamówienie #${wycena.id}`,
        text: shipment
          ? mailer.MAILE.oplaconaVatZTrackingiem(shipment.tracking_number || '(numer wkrótce)').text
          : mailer.MAILE.vatPoDoreczeniu().text,
        attachments: [{ filename: `faktura-${wycena.id}.pdf`, data: pdf }],
        reply: true,
      });
    }
    await releaseLock(db, wycenaId, token, {
      process_stage: shipment ? 'SHIPPED' : 'PAID',
      status: 'Fulfilled',
      worker_last_error: null,
    });
    if (shipment) {
      await notifyFulfillment(db, wycena); // gotowe do spakowania
      await pushWeekend(db, wycena);
    }
    return { ok: true };
  } catch (err) {
    await zapiszBlad(db, wycenaId, 'onInvoicePaid', err);
    await releaseLock(db, wycenaId, token);
    throw err;
  }
}

// Ręczne „Oznacz opłacone" z panelu Fulfillment (przelew opłacony poza inFakt,
// albo domknięcie telefoniczne). Decyzja Antoniego 2026-07-13: ma zadziałać
// dokładnie jak automatyczna płatność — utworzyć przesyłkę + etykietę od razu.
// Jeśli jest proforma z uuid -> pełna ścieżka onInvoicePaid (paid + przesyłka +
// FV VAT + KSeF + mail). Bez proformy (np. wycena bez faktury) -> lekki tryb:
// oznacz opłacone i utwórz przesyłkę, żeby zamówienie trafiło do „do spakowania".
async function markPaidAndShip(db, wycenaId) {
  const wycena = await loadWycena(db, wycenaId);
  if (!wycena) throw new Error('Nie znaleziono wyceny');
  if (wycena.paid) return { skipped: 'already-paid' };
  const { data: inv } = await db.from('wyceny_invoices')
    .select('*').eq('wycena_id', wycenaId).eq('kind', 'proforma').not('infakt_uuid', 'is', null).limit(1);
  if (inv && inv[0]) return onInvoicePaid(db, inv[0].infakt_uuid);

  const token = await acquireLock(db, wycenaId);
  if (!token) return { skipped: 'locked' };
  try {
    const { kwotaFinalna } = policzKwoty(wycena);
    const { data: existing } = await db.from('wyceny_shipments')
      .select('*').eq('wycena_id', wycenaId).eq('kind', 'order');
    const shipment = (existing || [])[0]
      || await utworzPrzesylkeWgRoutingu(db, wycena, { insuranceAmount: kwotaFinalna });
    await logEvent(db, wycenaId, 'invoice.paid', { manual: true });
    await releaseLock(db, wycenaId, token, {
      paid: true,
      paid_at: new Date().toISOString(),
      process_stage: shipment ? 'SHIPPED' : 'PAID',
      status: 'Fulfilled',
      worker_last_error: null,
    });
    if (shipment) {
      await notifyFulfillment(db, wycena);
      await pushWeekend(db, wycena);
    }
    return { ok: true, path: 'manual-paid' };
  } catch (err) {
    await zapiszBlad(db, wycenaId, 'markPaidAndShip', err);
    await releaseLock(db, wycenaId, token);
    throw err;
  }
}

// Realizacja zamówienia ze SKLEPU (Shopify) po ręcznym potwierdzeniu danych
// w panelu Fulfillment (etap SHOP_CONFIRM → „Potwierdź i realizuj"). Sklep NIE
// robi już fulfillmentu — my: etykieta InPost + faktury inFakt, jak przy
// zamówieniach z formularza. Dwie ścieżki:
//   OPŁACONE (Shopify Payments/P24): przesyłka bez COD + proforma → od razu
//     FV VAT (paid, KSeF, delete proformy) + mail z FV i trackingiem.
//   POBRANIE: identycznie jak COD formularza — przesyłka z pobraniem +
//     proforma "delivery" + mail z trackingiem; FV końcową robi onDelivered.
// Wznawialne po błędzie (ERROR → ponowne „Potwierdź"): istniejąca przesyłka /
// proforma / FV nie są tworzone drugi raz.
async function realizujSklep(db, wycenaId, { pobranie } = {}) {
  const token = await acquireLock(db, wycenaId);
  if (!token) return { skipped: 'locked' };
  try {
    const wycena = await loadWycena(db, wycenaId);
    if (!wycena || wycena.source !== 'shopify') {
      await releaseLock(db, wycenaId, token);
      return { skipped: 'not-shop' };
    }
    const { kwotaFinalna, rabatLaczny } = policzKwoty(wycena);
    // Total Shopify zawiera koszt dostawy — nadwyżka nad sumą pozycji idzie na
    // fakturę jako jawna pozycja "Dostawa" (buildServices dodaje tylko ujemny
    // rabat, dodatniej różnicy nie zna).
    const services = infakt.buildServices(wycena.items, Math.min(rabatLaczny, 0), 0);
    if (rabatLaczny > 0) {
      services.push({ name: 'Dostawa', unit: 'szt.', quantity: 1, tax_symbol: '23', gross_price: infakt.grosze(rabatLaczny) });
    }

    // wznowienie: co już istnieje?
    const [{ data: shipments }, { data: proformy }, { data: vaty }] = await Promise.all([
      db.from('wyceny_shipments').select('*').eq('wycena_id', wycenaId).eq('kind', 'order'),
      db.from('wyceny_invoices').select('*').eq('wycena_id', wycenaId).eq('kind', 'proforma').neq('status', 'deleted'),
      db.from('wyceny_invoices').select('*').eq('wycena_id', wycenaId).eq('kind', 'vat'),
    ]);

    if (pobranie) {
      let shipment = (shipments || [])[0];
      if (!shipment) {
        shipment = await krokPrzesylka(db, wycena, { codAmount: kwotaFinalna, insuranceAmount: kwotaFinalna });
      }
      let proformaRow = (proformy || [])[0];
      if (!proformaRow) {
        proformaRow = await krokProforma(db, wycena, { services, paymentMethod: 'delivery', kwotaFinalna });
      }
      if (proformaRow.infakt_uuid && wycena.email) {
        const pdf = await infakt.downloadPdf(proformaRow.infakt_uuid);
        await krokMail(db, wycena, {
          subject: `Numer śledzenia zamówienia ${wycena.shopify_order_name || `#${wycena.id}`}`,
          text: mailer.MAILE.codZProforma(shipment?.tracking_number || '(numer wkrótce)').text,
          attachments: [{ filename: `proforma-${wycena.id}.pdf`, data: pdf }],
        });
      }
      await releaseLock(db, wycenaId, token, {
        process_stage: 'SHIPPED',
        status: 'Fulfilled',
        paid: false,
        worker_last_error: null,
      });
      await notifyFulfillment(db, wycena);
      await pushWeekend(db, wycena);
      return { ok: true, path: 'sklep-pobranie' };
    }

    // OPŁACONE w sklepie: przesyłka bez COD, FV VAT od razu.
    let shipment = (shipments || [])[0];
    if (!shipment) {
      shipment = await krokPrzesylka(db, wycena, { codAmount: null, insuranceAmount: kwotaFinalna });
    }
    let fakturaPdf = null;
    if (!(vaty || []).length) {
      let proformaRow = (proformy || [])[0];
      if (!proformaRow) {
        proformaRow = await krokProforma(db, wycena, { services, paymentMethod: 'transfer', kwotaFinalna });
      }
      if (!proformaRow.infakt_uuid) {
        throw new Error('Proforma inFakt jeszcze bez uuid (async) — kliknij „Potwierdź" ponownie za chwilę');
      }
      const { pdf } = await krokFakturaKoncowa(db, wycena, proformaRow);
      fakturaPdf = pdf;
    }
    if (fakturaPdf && wycena.email) {
      await krokMail(db, wycena, {
        subject: `Faktura VAT za zamówienie ${wycena.shopify_order_name || `#${wycena.id}`}`,
        text: mailer.MAILE.oplaconaVatZTrackingiem(shipment?.tracking_number || '(numer wkrótce)').text,
        attachments: [{ filename: `faktura-${wycena.id}.pdf`, data: fakturaPdf }],
      });
    }
    await releaseLock(db, wycenaId, token, {
      process_stage: 'SHIPPED',
      status: 'Fulfilled',
      paid: true,
      paid_at: wycena.paid_at || new Date().toISOString(),
      worker_last_error: null,
    });
    await notifyFulfillment(db, wycena);
    await pushWeekend(db, wycena);
    return { ok: true, path: 'sklep-oplacone' };
  } catch (err) {
    await zapiszBlad(db, wycenaId, 'realizujSklep', err);
    await releaseLock(db, wycenaId, token);
    throw err;
  }
}

// Doręczenie (worker): przy pobraniu faktura końcowa z opłaconej proformy.
async function onDelivered(db, shipment) {
  const wycena = await loadWycena(db, shipment.wycena_id);
  if (!wycena) return;
  await db.from('wyceny_shipments').update({
    status: 'delivered', delivered_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', shipment.id);
  await logEvent(db, wycena.id, 'tracking.delivered', { tracking: shipment.tracking_number });

  if (shipment.kind === 'reship') return; // dosyłka nie zmienia stanu zamówienia

  const codOrder = Number(shipment.cod_amount) > 0;
  if (codOrder && !wycena.paid) {
    const token = await acquireLock(db, wycena.id);
    if (!token) return;
    try {
      const { data: invRows } = await db.from('wyceny_invoices')
        .select('*').eq('wycena_id', wycena.id).eq('kind', 'proforma').not('infakt_uuid', 'is', null).limit(1);
      const proformaRow = invRows && invRows[0];
      if (proformaRow) {
        const { pdf } = await krokFakturaKoncowa(db, wycena, proformaRow);
        if (wycena.email) {
          await krokMail(db, wycena, {
            subject: `Faktura VAT za zamówienie #${wycena.id}`,
            text: mailer.MAILE.vatPoDoreczeniu().text,
            attachments: [{ filename: `faktura-${wycena.id}.pdf`, data: pdf }],
            reply: true,
          });
        }
      }
      await releaseLock(db, wycena.id, token, {
        paid: true,
        paid_at: new Date().toISOString(),
        cod_status: 'Doręczono (pobranie)',
        process_stage: 'DELIVERED',
        status: 'Closed',
        worker_last_error: null,
      });
    } catch (err) {
      await zapiszBlad(db, wycena.id, 'onDelivered', err);
      await releaseLock(db, wycena.id, token);
    }
    return;
  }
  await db.from('wyceny').update({
    process_stage: 'DELIVERED', status: 'Closed', updated_at: new Date().toISOString(),
  }).eq('id', wycena.id);
}

// "Zamów kuriera ponownie" — nowa przesyłka na te same dane, bez faktury
// i bez zmiany statusów (dosyłka/reklamacja).
async function reship(db, wycenaId) {
  const wycena = await loadWycena(db, wycenaId);
  if (!wycena) throw new Error('Nie znaleziono wyceny');
  if (jestFurgonetka(wycena)) {
    if (wymagaCla(wycena)) throw new Error('Dosyłka poza UE wymaga danych celnych — zamów ręcznie w panelu Furgonetki.');
    return krokPrzesylkaFurgonetka(db, wycena, { kind: 'reship' });
  }
  return krokPrzesylka(db, wycena, { codAmount: null, insuranceAmount: null, kind: 'reship' });
}

// ── Worker (pg_cron -> POST /formularz/api/cron/worker) ─────────────────────
// Odczyt statusu przesyłki NIEZALEŻNIE od przewoźnika. Zwraca { raw, mapped }.
// ShipX: tracking po numerze przesyłki. Furgonetka: tracking po package_id
// (=shipment_id), a stan bierzemy jako NAJBARDZIEJ zaawansowany ze zdarzeń
// (kolejność w tablicy /tracking nie jest gwarantowana). OBIE ścieżki mapują
// TYLKO literalne "delivered" na doręczoną — żadnego fałszywego domknięcia z
// „nadana" (naprawa starego buga Make: „doręczono" przy samym nadaniu).
async function odczytajTracking(s) {
  if (s.provider === 'furgonetka') {
    const t = await furgonetka.getTracking(s.shipment_id);
    const arr = Array.isArray(t && t.tracking) ? t.tracking : (Array.isArray(t) ? t : []);
    const rank = { created: 0, problem: 1, sent: 2, delivered: 3 };
    let raw = '', mapped = 'created';
    for (const ev of arr) {
      const r = String((ev && (ev.status ?? ev.code ?? ev.state ?? ev.name ?? ev.event)) || '').trim();
      const m = furgonetka.mapTrackingStatus(r);
      if (rank[m] >= rank[mapped]) { mapped = m; if (r) raw = r; }
    }
    return { raw, mapped };
  }
  const tracking = await shipx.getTracking(s.tracking_number);
  const raw = tracking.tracking_status || tracking.status || '';
  return { raw, mapped: shipx.mapTrackingStatus(raw) };
}

async function runWorker(db) {
  const oknoNadania = wOknieNadania();
  const oknoDoreczenia = wOknieDoreczenia();
  const raport = { tracking: 0, delivered: 0, uzupelnione: 0, retry: 0, oknoNadania, oknoDoreczenia, bledy: [] };

  // 1) przesyłki bez trackingu / świeże — dociągnij dane z ShipX.
  // Dociąganie numeru śledzenia leci ZAWSZE (etykieta/tracking muszą być
  // widoczne od razu po utworzeniu). Odczyt STATUSU „czy nadana" tylko w oknie
  // 17–18 — nie zgadujemy nadania w losowych porach.
  const { data: created } = await db.from('wyceny_shipments')
    .select('*').in('status', ['created', 'confirmed']).is('delivered_at', null);
  for (const s of created || []) {
    try {
      if (s.provider === 'furgonetka') {
        // Furgonetka: numer nadania jest od razu przy zamówieniu, tracking
        // czytamy po package_id (=shipment_id) — nie dociągamy numeru z ShipX.
        if (!s.shipment_id) continue;
      } else if (!s.tracking_number) {
        const fresh = await shipx.getShipment(s.shipment_id);
        if (fresh.tracking_number) {
          await db.from('wyceny_shipments').update({
            tracking_number: fresh.tracking_number,
            raw_status: fresh.status,
            status: 'confirmed',
            updated_at: new Date().toISOString(),
          }).eq('id', s.id);
          raport.uzupelnione += 1;
        }
        continue;
      }
      if (!oknoNadania) continue; // poza oknem 17–18 nie sprawdzamy nadania
      // tracking z JAWNYM mapowaniem per przewoźnik (tylko "delivered" = doręczona)
      const { raw, mapped } = await odczytajTracking(s);
      await logEvent(db, s.wycena_id, 'tracking.read', { tracking: s.tracking_number || s.shipment_id, provider: s.provider, raw, mapped });
      raport.tracking += 1;
      if (mapped === 'delivered') {
        await onDelivered(db, s);
        raport.delivered += 1;
      } else if (mapped === 'sent' && s.status !== 'sent') {
        await db.from('wyceny_shipments').update({
          status: 'sent', raw_status: raw,
          nadana_at: s.nadana_at || new Date().toISOString(),
          checked_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }).eq('id', s.id);
      } else {
        await db.from('wyceny_shipments').update({
          raw_status: raw, checked_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }).eq('id', s.id);
      }
    } catch (err) {
      // świeżo utworzona przesyłka może nie mieć jeszcze trackingu w systemie;
      // przesyłki z importu arkusza (raw_status 'import') z martwym numerem
      // archiwizujemy — nie ma sensu odpytywać ich w każdym przebiegu
      if (/404/.test(err.message)) {
        if (s.raw_status === 'import') {
          await db.from('wyceny_shipments').update({ status: 'archived', updated_at: new Date().toISOString() }).eq('id', s.id);
        }
      } else {
        raport.bledy.push(`shipment ${s.id}: ${err.message.slice(0, 120)}`);
      }
    }
  }

  // przesyłki nadane — sprawdzaj do doręczenia, tylko w oknie 10–16.
  const { data: sent } = oknoDoreczenia
    ? await db.from('wyceny_shipments')
        .select('*').eq('status', 'sent').is('delivered_at', null)
    : { data: [] };
  for (const s of sent || []) {
    try {
      // ShipX potrzebuje numeru trackingu; Furgonetka śledzi po package_id.
      if (s.provider !== 'furgonetka' && !s.tracking_number) continue;
      const { raw, mapped } = await odczytajTracking(s);
      await logEvent(db, s.wycena_id, 'tracking.read', { tracking: s.tracking_number || s.shipment_id, provider: s.provider, raw, mapped });
      raport.tracking += 1;
      if (mapped === 'delivered') {
        await onDelivered(db, s);
        raport.delivered += 1;
      } else if (raw !== s.raw_status) {
        await db.from('wyceny_shipments').update({
          raw_status: raw, checked_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }).eq('id', s.id);
      }
    } catch (err) {
      if (/404/.test(err.message) && s.raw_status === 'import') {
        await db.from('wyceny_shipments').update({ status: 'archived', updated_at: new Date().toISOString() }).eq('id', s.id);
      } else if (!/404/.test(err.message)) {
        raport.bledy.push(`tracking ${s.tracking_number}: ${err.message.slice(0, 120)}`);
      }
    }
  }

  // 3) faktury async bez uuid — dociągnij
  const { data: pending } = await db.from('wyceny_invoices')
    .select('*').is('infakt_uuid', null).not('task_reference_number', 'is', null);
  for (const inv of pending || []) {
    try {
      const status = await infakt.getAsyncStatus(inv.task_reference_number);
      if (status.invoice_uuid) {
        await db.from('wyceny_invoices').update({
          infakt_uuid: status.invoice_uuid, status: 'issued', updated_at: new Date().toISOString(),
        }).eq('id', inv.id);
        raport.uzupelnione += 1;
      }
    } catch (err) {
      raport.bledy.push(`invoice ${inv.id}: ${err.message.slice(0, 120)}`);
    }
  }

  // 4) zamówienia SUBMITTED bez proformy (>10 min) — retry pipeline'u.
  // NIGDY dla wycen z importu arkusza (stare zamówienia sprzed migracji
  // mają stage SUBMITTED bez faktur — to historia, nie zator) i tylko dla
  // świeżych submitów (ostatnie 7 dni). NIGDY też dla zamówień ze sklepu
  // Shopify (source='shopify'): sklep robi własny fulfillment i faktury, a
  // one wpadają jako form_status=SUBMITTED/process_stage=SUBMITTED (patrz
  // wyceny-shopify.js mapStage) — bez tego wykluczenia retry sam odpaliłby na
  // nich ShipX + inFakt (zamówiłby kuriera i wystawił FV za sklepowy order,
  // przypadek #1877). Bezpiecznik MUSI być na prodzie, ZANIM wejdzie
  // SHOPIFY_ADMIN_TOKEN i orders sklepu zaczną się synchronizować.
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const freshCutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const { data: stuck } = await db.from('wyceny')
    .select('id, wyceny_invoices(id)')
    .eq('form_status', 'SUBMITTED')
    .in('process_stage', ['SUBMITTED', 'ERROR'])
    .neq('source', 'import')
    .neq('source', 'shopify')
    .gt('form_submitted_at', freshCutoff)
    .lt('updated_at', cutoff)
    .limit(10);
  for (const w of stuck || []) {
    if ((w.wyceny_invoices || []).length) continue;
    try {
      await startPipeline(db, w.id);
      raport.retry += 1;
    } catch (err) {
      raport.bledy.push(`retry ${w.id}: ${err.message.slice(0, 120)}`);
    }
  }

  // 5) zamówienia ze sklepu Shopify (skip bez SHOPIFY_ADMIN_TOKEN)
  try {
    const { syncShopifyOrders } = require('./wyceny-shopify');
    raport.shopify = await syncShopifyOrders(db);
  } catch (err) {
    raport.bledy.push(`shopify: ${err.message.slice(0, 120)}`);
  }

  return raport;
}

module.exports = {
  startPipeline, onInvoicePaid, onDelivered, reship, runWorker, policzKwoty, markPaidAndShip,
  realizujSklep, jestFurgonetka, wymagaCla, firmaNaFakturze,
};
