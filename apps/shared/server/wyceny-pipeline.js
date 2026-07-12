// ── Pipeline realizacji zamówienia (maszyna stanów wycen) ────────────────────
// Zastępuje ~20 gałęzi Make (Formularz POST, #3 PAID, #4 Sprawdzenie dostawy)
// kombinacją tych samych kroków z parametrami:
//   POBRANIE:  przesyłka (COD+ubezpieczenie) -> proforma "delivery" -> mail
//              z trackingiem i proformą -> po DORĘCZENIU faktura VAT (paid),
//              KSeF, delete proformy, mail z VAT.
//   PRZELEW:   proforma "transfer" + szybka płatność -> mail z linkiem ->
//              po OPŁACENIU (webhook inFakt) przesyłka (bez COD), faktura VAT
//              (paid), KSeF, delete proformy, mail z VAT i trackingiem.
//   ZAGRANICA: kraj != PL -> bez auto-przesyłki (jak dziś w Make; Furgonetka
//              dojdzie po cutoverze) — proforma/faktura normalnie.
//
// Idempotencja: lock na wycenie (lock_token + lock_expires_at) + wznowienie
// od brakującego kroku (istniejąca przesyłka/faktura nie jest tworzona
// ponownie). Każdy krok loguje się do wyceny_events.
const crypto = require('crypto');
const infakt = require('./wyceny-infakt');
const shipx = require('./wyceny-shipx');
const mailer = require('./wyceny-mailer');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function logEvent(db, wycenaId, kind, payload) {
  const { error } = await db.from('wyceny_events').insert({ wycena_id: wycenaId, kind, payload: payload || null });
  if (error) console.error(`Event ${kind} wyceny ${wycenaId}:`, error.message);
}

function num(v) {
  const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

// Wyliczenia 1:1 z Make (moduły 301/302/307):
//   rabat_aktywny  — rabat 24h z przyszłym terminem
//   kwota_finalna  — kwota_proponowana − aktywny rabat 24h
//   rabat_laczny   — (kwota_proponowana − suma pozycji) − aktywny rabat 24h
//                    (ujemna pozycja "Rabat" na fakturze)
function policzKwoty(wycena) {
  const suma = (wycena.items || []).reduce((a, p) => a + num(p.price) * (num(p.quantity) || 1), 0);
  const kwota = wycena.kwota_proponowana_brutto != null ? num(wycena.kwota_proponowana_brutto) : suma;
  const rabatAktywny = Boolean(
    wycena.rabat24h_kwota && wycena.rabat24h_wazny_do
    && new Date(wycena.rabat24h_wazny_do).getTime() > Date.now()
  );
  const rabat24h = rabatAktywny ? num(wycena.rabat24h_kwota) : 0;
  const kwotaFinalna = Math.round((kwota - rabat24h) * 100) / 100;
  const znizka = suma ? Math.round((kwota - suma) * 100) / 100 : 0;
  const rabatLaczny = Math.round((znizka - rabat24h) * 100) / 100;
  return { suma, kwotaFinalna, rabatLaczny, rabatAktywny };
}

function jestLocker(wycena) {
  return String(wycena.punkt_odbioru || '').replace(/[,\s]/g, '').length > 3;
}

function jestZagranica(wycena) {
  return Boolean(wycena.ship_country && wycena.ship_country !== 'PL');
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
    const services = infakt.buildServices(wycena.items, rabatLaczny);
    const isCod = String(wycena.payment_method || '').toLowerCase() !== 'transfer';
    const zagranica = jestZagranica(wycena);

    // wznowienie: co już istnieje?
    const [{ data: shipments }, { data: invoices }] = await Promise.all([
      db.from('wyceny_shipments').select('*').eq('wycena_id', wycenaId).eq('kind', 'order'),
      db.from('wyceny_invoices').select('*').eq('wycena_id', wycenaId).eq('kind', 'proforma'),
    ]);

    if (isCod) {
      // POBRANIE: przesyłka z COD od razu, proforma "delivery", mail z trackingiem
      let shipment = (shipments || [])[0];
      if (!shipment && !zagranica) {
        shipment = await krokPrzesylka(db, wycena, { codAmount: kwotaFinalna, insuranceAmount: kwotaFinalna });
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
    const zagranica = jestZagranica(wycena);

    let shipment = null;
    if (!zagranica) {
      const { data: existing } = await db.from('wyceny_shipments')
        .select('*').eq('wycena_id', wycenaId).eq('kind', 'order');
      shipment = (existing || [])[0]
        || await krokPrzesylka(db, wycena, { codAmount: null, insuranceAmount: kwotaFinalna });
    } else {
      await logEvent(db, wycenaId, 'pipeline.manual_shipping_needed', { kraj: wycena.ship_country });
    }

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
      process_stage: zagranica ? 'PAID' : 'SHIPPED',
      status: 'Fulfilled',
      worker_last_error: null,
    });
    return { ok: true };
  } catch (err) {
    await zapiszBlad(db, wycenaId, 'onInvoicePaid', err);
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
  return krokPrzesylka(db, wycena, { codAmount: null, insuranceAmount: null, kind: 'reship' });
}

// ── Worker (pg_cron -> POST /formularz/api/cron/worker) ─────────────────────
async function runWorker(db) {
  const raport = { tracking: 0, delivered: 0, uzupelnione: 0, retry: 0, bledy: [] };

  // 1) przesyłki bez trackingu / świeże — dociągnij dane z ShipX
  const { data: created } = await db.from('wyceny_shipments')
    .select('*').in('status', ['created', 'confirmed']).is('delivered_at', null);
  for (const s of created || []) {
    try {
      if (!s.tracking_number) {
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
      // 2) tracking z JAWNYM mapowaniem (tylko "delivered" = doręczona)
      const tracking = await shipx.getTracking(s.tracking_number);
      const raw = tracking.tracking_status || tracking.status || '';
      const mapped = shipx.mapTrackingStatus(raw);
      await logEvent(db, s.wycena_id, 'tracking.read', { tracking: s.tracking_number, raw, mapped });
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

  // przesyłki nadane — sprawdzaj do doręczenia
  const { data: sent } = await db.from('wyceny_shipments')
    .select('*').eq('status', 'sent').is('delivered_at', null).not('tracking_number', 'is', null);
  for (const s of sent || []) {
    try {
      const tracking = await shipx.getTracking(s.tracking_number);
      const raw = tracking.tracking_status || tracking.status || '';
      const mapped = shipx.mapTrackingStatus(raw);
      await logEvent(db, s.wycena_id, 'tracking.read', { tracking: s.tracking_number, raw, mapped });
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
  // świeżych submitów (ostatnie 7 dni).
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const freshCutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const { data: stuck } = await db.from('wyceny')
    .select('id, wyceny_invoices(id)')
    .eq('form_status', 'SUBMITTED')
    .in('process_stage', ['SUBMITTED', 'ERROR'])
    .neq('source', 'import')
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

module.exports = { startPipeline, onInvoicePaid, onDelivered, reship, runWorker, policzKwoty };
