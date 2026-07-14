// ── Panel Fulfillment (lumlum.dev/fulfillment) — pulpit pakowania ────────────
// Osobny, ADMIN-ONLY widok nad tymi samymi danymi co Sprzedaże (tabela wyceny +
// wyceny_shipments). Cała maszyna stanów, tracking i faktury już żyją w
// wyceny-pipeline.js — tu tylko PREZENTUJEMY „co spakować i nadać" i dajemy
// akcje ręczne. Jedyna własna kolumna to wyceny.packed_at (krok „spakowane");
// reszta bucketa liczona z payment_method, paid i statusu przesyłki.
//
// Stany (decyzja Antoniego 2026-07-13, krok „spakowane" dodany 2026-07-14):
//   do_spakowania   — gotowe do przygotowania (pobranie albo opłacony przelew),
//                     jeszcze NIE spakowane (packed_at puste).
//   spakowane       — packed_at ustawione („Oznacz spakowane"): spakowane,
//                     czeka na kuriera, jeszcze NIE nadane.
//   wyslane         — nadane (tracking sent / nadana_at / ręcznie); trzymamy 7
//                     dni po doręczeniu, potem znika (zamknięte).
//   czeka_na_platnosc — nieopłacone (status Waiting for payment), DOWOLNE źródło
//                     (też import/sklep) — żeby pilnować wpłaty („Oznacz opłacone").
// Nadanie/doręczenie łapie worker z trackingu w oknach 17–18 / 10–16, albo
// oznaczasz ręcznie tutaj (natychmiast).

const HISTORIA_MS = 7 * 24 * 60 * 60 * 1000; // wysłane trzymamy 7 dni po doręczeniu

function num(v) {
  const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

// Zamówienia własne (nie sklep/import): tylko te pakujemy sami. Shopify robi
// własny fulfillment, import to historia sprzed migracji.
function jestNasze(w) {
  return w.source !== 'shopify' && w.source !== 'import';
}

// Najnowsza przesyłka „zamówienia" (pomijamy dosyłki 'reship' — nie zmieniają
// stanu zamówienia). shipments przychodzą posortowane rosnąco po created_at.
function przesylkaZamowienia(shipments) {
  const orders = (shipments || []).filter((s) => s.kind !== 'reship');
  return orders.length ? orders[orders.length - 1] : null;
}

// Czy przelew (jedyna forma, która czeka na opłatę). Wszystko inne = pobranie /
// gratis / opłacone z góry -> gotowe od razu (zgodnie z wyceny-pipeline isCod).
function jestPrzelew(w) {
  return String(w.payment_method || '').toLowerCase() === 'transfer';
}

function nadana(ship) {
  return Boolean(ship && (['sent', 'delivered'].includes(String(ship.status)) || ship.nadana_at || ship.delivered_at));
}
function doreczona(ship) {
  return Boolean(ship && (String(ship.status) === 'delivered' || ship.delivered_at));
}

// Bucket albo null (nie pokazujemy w panelu). now = Date.now().
function bucketOf(w, ship, now) {
  const status = String(w.status || '').toLowerCase();
  if (status === 'stracone') return null;

  // Doręczone: nasza przesyłka delivered LUB pipeline oznaczył DELIVERED
  // (Shopify/import nie mają naszej przesyłki — sygnałem jest process_stage).
  if (doreczona(ship) || String(w.process_stage) === 'DELIVERED') {
    // Import z backfillu ma delivered_at ze skryptu migracji (bez nadana_at) —
    // nie zaśmieca „Wysłanych"; prawdziwy przepływ stawia nadana_at przy nadaniu.
    if (!jestNasze(w) && !(ship && ship.nadana_at)) return null;
    const dt = ship && ship.delivered_at ? new Date(ship.delivered_at).getTime() : 0;
    return dt && now - dt < HISTORIA_MS ? 'wyslane' : null; // po 7 dniach: zamknięte (znika)
  }
  if (nadana(ship)) return 'wyslane';

  // Czeka na płatność — DOWOLNE źródło (import/sklep też), żeby pilnować wpłaty.
  if (status === 'waiting for payment' && !w.paid) return 'czeka_na_platnosc';

  // Sklep/import bez naszej przesyłki nie są do pakowania przez nas — poza
  // kolejką. Z NASZĄ przesyłką (markPaidAndShip na imporcie, np. #1809) — nasze.
  if (!jestNasze(w) && !ship) return null;

  const gotowe = !jestPrzelew(w) || w.paid;
  if (!gotowe) return 'czeka_na_platnosc';
  // Gotowe do przygotowania → po ręcznym „Oznacz spakowane" (packed_at) idzie
  // do „spakowane" (czeka na kuriera), aż do nadania.
  return w.packed_at ? 'spakowane' : 'do_spakowania';
}

// Zamówienie „w grze" (już realizowane) — filtruje szkice/wyceny bez wysyłki.
// Czekające na płatność też są „w grze" (proforma poszła) — pokazujemy je nawet
// bez przesyłki, żeby pilnować wpłaty.
function realizowane(w, shipments) {
  const czeka = String(w.status || '').toLowerCase() === 'waiting for payment';
  return czeka || w.form_status === 'SUBMITTED' || (shipments && shipments.length > 0) || w.paid;
}

function placeOf(w) {
  const locker = String(w.punkt_odbioru || '').replace(/[,\s]/g, '');
  if (locker.length > 3) {
    return { typ: 'paczkomat', kod: String(w.punkt_odbioru).replace(/,\s*$/, '').split(',')[0].trim(),
      adres: w.punkt_odbioru_adres || '' };
  }
  const adres = [
    [w.ship_street, w.ship_house_no].filter(Boolean).join(' ') + (w.ship_flat_no ? `/${w.ship_flat_no}` : ''),
    [w.ship_postcode, w.ship_city].filter(Boolean).join(' '),
    w.ship_country && w.ship_country !== 'PL' ? w.ship_country : '',
  ].filter((s) => s && s.trim()).join(', ');
  return { typ: 'kurier', adres };
}

function serializeItems(items, cennikBySku) {
  return (Array.isArray(items) ? items : []).map((p) => ({
    name: p.name || p.SKU || '(pozycja)',
    sku: p.SKU || '',
    quantity: num(p.quantity) || 1,
    unit: p.unit || 'szt',
    image_url: p.image_url || (p.SKU && cennikBySku.get(p.SKU)) || '',
  }));
}

function serializeOrder(w, shipments, bucket, cennikBySku) {
  const ship = przesylkaZamowienia(shipments);
  return {
    id: w.id,
    bucket,
    imie_nazwisko: w.imie_nazwisko || [w.first_name, w.last_name].filter(Boolean).join(' ').trim() || '',
    telefon: w.telefon_e164 ? `+${String(w.telefon_e164).replace(/^\+/, '')}` : (w.telefon_digits ? `+48${w.telefon_digits}` : ''),
    email: w.email || '',
    kwota: num(w.kwota_sprzedazy_brutto ?? w.kwota_proponowana_brutto),
    payment_method: w.payment_method || '',
    paid: Boolean(w.paid),
    created_at: w.created_at || null,
    packed_at: w.packed_at || null,
    miejsce: placeOf(w),
    items: serializeItems(w.items, cennikBySku),
    shipment: ship ? {
      id: ship.shipment_id,
      provider: ship.provider || 'shipx',
      service: ship.service || '',
      tracking_number: ship.tracking_number || '',
      status: ship.status,
      raw_status: ship.raw_status || '',
      nadana_at: ship.nadana_at || null,
      delivered_at: ship.delivered_at || null,
      cod_amount: ship.cod_amount || null,
      label_printed_at: ship.label_printed_at || null,
      dispatch_order_id: ship.dispatch_order_id || null,
      dispatch_ordered_at: ship.dispatch_ordered_at || null,
    } : null,
    brak_etykiety: !ship, // gotowe do spakowania, ale przesyłki jeszcze nie ma (zagranica / świeżo opłacone)
  };
}

// ── Zlecenie odbioru kuriera (plan-furgonetka-jutro §3) ──────────────────────
// Pierwsze „Drukuj etykietę"/„Oznacz spakowane" danego dnia (przed 15:00)
// zamawia kuriera InPost na WSZYSTKIE potwierdzone, nienadane przesyłki bez
// zlecenia — jeden podjazd bierze całość, okno 15:00-17:00. Idempotencja RAZ
// dziennie: znacznik dispatch_ordered_at (data warszawska). Po 15:00 nie
// zamawiamy (info w panelu); jutrzejszy pierwszy druk/spakowanie zamówi.
const DISPATCH_CUTOFF_HOUR = 15;

function dataWarszawa(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(d);
}
function godzinaWarszawy(d) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw', hour: '2-digit', hour12: false }).format(d));
}

async function zamowKurieraInPost(supabase, rows, { user } = {}) {
  const teraz = new Date();
  const dzis = dataWarszawa(teraz);
  if (rows.some((s) => s.dispatch_ordered_at && dataWarszawa(new Date(s.dispatch_ordered_at)) === dzis)) {
    return { dispatch: 'juz-zamowiony' };
  }
  if (godzinaWarszawy(teraz) >= DISPATCH_CUTOFF_HOUR) return { dispatch: 'za-pozno' };
  // Tylko confirmed (wymóg ShipX) i bez wcześniejszego zlecenia — przesyłka
  // może być w JEDNYM zleceniu, inaczej 400 dla całego zlecenia.
  const doOdbioru = rows.filter((s) => String(s.status) === 'confirmed'
    && !s.nadana_at && !s.delivered_at && s.tracking_number && !s.dispatch_order_id);
  if (!doOdbioru.length) return { dispatch: 'brak-paczek' };
  const shipx = require('./wyceny-shipx');
  const order = await shipx.createDispatchOrder(doOdbioru.map((s) => s.shipment_id), {
    comment: `LumLum fulfillment ${dzis}`,
  });
  const nowIso = new Date().toISOString();
  const { error: uErr } = await supabase.from('wyceny_shipments')
    .update({ dispatch_order_id: String(order.id), dispatch_ordered_at: nowIso, updated_at: nowIso })
    .in('id', doOdbioru.map((s) => s.id));
  if (uErr) throw uErr;
  await supabase.from('wyceny_events').insert(doOdbioru.map((s) => ({
    wycena_id: s.wycena_id, kind: 'dispatch.ordered',
    payload: { dispatch_order_id: String(order.id), paczek: doOdbioru.length, user: user || null },
  })));
  return { dispatch: 'zamowiony', dispatch_order_id: String(order.id), paczek: doOdbioru.length };
}

// Odbiory Furgonetki (zagranica): per PACZKA, bez okna 15:00 (Furgonetka sama
// daje najbliższy termin) i bez flagi dziennej — idempotencja na
// dispatch_order_id przesyłki. Order zwykle umawia odbiór sam (stempel w
// krokPrzesylkaFurgonetka); to jest dogrywka z „Drukuj etykietę"/„Oznacz".
async function zamowOdbioryFurgonetki(supabase, rows, { user } = {}) {
  const czeka = rows.filter((s) => String(s.status) === 'confirmed'
    && !s.nadana_at && !s.delivered_at && !s.dispatch_order_id);
  if (!czeka.length) return null;
  const furgo = require('./wyceny-furgonetka');
  furgo.useTokenStore(furgo.makeSupabaseTokenStore(supabase));
  const wyniki = [];
  for (const s of czeka) {
    try {
      const p = await furgo.zamowOdbior(s.shipment_id);
      const nowIso = new Date().toISOString();
      await supabase.from('wyceny_shipments').update({
        dispatch_order_id: `pickup:${p.date || 'auto'}`, dispatch_ordered_at: nowIso, updated_at: nowIso,
      }).eq('id', s.id);
      await supabase.from('wyceny_events').insert({
        wycena_id: s.wycena_id, kind: 'dispatch.ordered',
        payload: { provider: 'furgonetka', package_id: s.shipment_id, pickup_date: p.date || null, existing: p.existing || false, user: user || null, raw: p.raw ? JSON.parse(JSON.stringify(p.raw)) : null },
      });
      wyniki.push({ wycena_id: s.wycena_id, service: s.service || '', date: p.date || null });
    } catch (err) {
      console.error(`Furgonetka pickup ${s.shipment_id}:`, err.message);
      wyniki.push({ wycena_id: s.wycena_id, service: s.service || '', error: err.message.slice(0, 160) });
    }
  }
  return wyniki;
}

async function zamowKuriera(supabase, { user } = {}) {
  const { data: ships, error } = await supabase.from('wyceny_shipments').select('*');
  if (error) throw error;
  const all = ships || [];
  const inpost = await zamowKurieraInPost(supabase, all.filter((s) => (s.provider || 'shipx') !== 'furgonetka'), { user });
  const furgonetka = await zamowOdbioryFurgonetki(supabase, all.filter((s) => s.provider === 'furgonetka'), { user });
  return { ...inpost, furgonetka };
}

function registerFulfillmentEndpoints(app, { getClient, requireAdmin }) {
  const guard = typeof requireAdmin === 'function' ? requireAdmin : (req, res, next) => next();

  function handleError(res, err) {
    console.error('Fulfillment:', err);
    res.status(502).json({ error: err.message || 'Wewnętrzny błąd serwera' });
  }

  // GET /api/fulfillment/queue — trzy kubełki gotowe do renderu.
  app.get('/api/fulfillment/queue', guard, async (req, res) => {
    try {
      const supabase = getClient();
      const { data: wyceny, error } = await supabase.from('wyceny').select('*')
        .eq('typ', 'ZAMÓWIENIE').neq('status', 'Stracone')
        .order('created_at', { ascending: false });
      if (error) throw error;

      // Przesyłki bierzemy WSZYSTKIE (mała tabela — same nasze, od migracji):
      // import z naszą przesyłką też pakujemy my, a które to są, wiemy dopiero
      // po złączeniu. Shopify wierszy tu nie tworzy, więc nie wpadnie.
      const { data: shipments, error: sErr } = await supabase.from('wyceny_shipments')
        .select('*').order('created_at', { ascending: true });
      if (sErr) throw sErr;
      const shipByWycena = new Map();
      (shipments || []).forEach((s) => {
        if (!shipByWycena.has(s.wycena_id)) shipByWycena.set(s.wycena_id, []);
        shipByWycena.get(s.wycena_id).push(s);
      });
      // Pakujemy własne zamówienia; DOKŁADAMY import/sklep z naszą przesyłką
      // oraz czekające na płatność z dowolnego źródła (pilnowanie wpłaty).
      const rows = (wyceny || []).filter((w) => jestNasze(w)
        || shipByWycena.has(w.id)
        || (String(w.status || '').toLowerCase() === 'waiting for payment' && !w.paid));

      // Zdjęcia pozycji bez image_url — dociągnij z cennika po SKU (jedno zapytanie).
      const brakSku = new Set();
      rows.forEach((w) => (Array.isArray(w.items) ? w.items : []).forEach((p) => {
        if (!p.image_url && p.SKU) brakSku.add(p.SKU);
      }));
      const cennikBySku = new Map();
      if (brakSku.size) {
        const { data: cennik } = await supabase.from('sku_cennik')
          .select('sku,image_url').in('sku', [...brakSku]);
        (cennik || []).forEach((c) => { if (c.image_url) cennikBySku.set(c.sku, c.image_url); });
      }

      const now = Date.now();
      const out = { do_spakowania: [], spakowane: [], czeka_na_platnosc: [], wyslane: [] };
      rows.forEach((w) => {
        const sh = shipByWycena.get(w.id) || [];
        if (!realizowane(w, sh)) return;
        const bucket = bucketOf(w, przesylkaZamowienia(sh), now);
        if (!bucket) return;
        out[bucket].push(serializeOrder(w, sh, bucket, cennikBySku));
      });
      // Kolejki do roboty (do spakowania / spakowane): najstarsze u góry
      // (najdłużej czekają); reszta: najnowsze u góry.
      out.do_spakowania.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
      out.spakowane.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
      res.json({ data: out });
    } catch (err) {
      handleError(res, err);
    }
  });

  // POST /api/fulfillment/:id/oznacz-spakowane — paczka fizycznie spakowana,
  // czeka na kuriera. Tylko znacznik packed_at; NIE dotyka przesyłki ani faktur.
  app.post('/api/fulfillment/:id(\\d+)/oznacz-spakowane', guard, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const supabase = getClient();
      const { data, error } = await supabase.from('wyceny').select('id,packed_at').eq('id', id).limit(1);
      if (error) throw error;
      const w = data && data[0];
      if (!w) return res.status(404).json({ error: 'Nie znaleziono zamówienia' });
      if (!w.packed_at) {
        const { error: uErr } = await supabase.from('wyceny')
          .update({ packed_at: new Date().toISOString() }).eq('id', id);
        if (uErr) throw uErr;
        await supabase.from('wyceny_events').insert({
          wycena_id: id, kind: 'order.packed',
          payload: { source: 'fulfillment-manual', user: req.user?.name || null },
        });
      }
      // Spakowane = gotowe do odbioru: próbuj zamówić kuriera (raz dziennie).
      // Błąd zamawiania NIE cofa spakowania — pakiet i tak jest gotowy.
      let kurier = null;
      try { kurier = await zamowKuriera(supabase, { user: req.user?.name }); }
      catch (err) { console.error('Fulfillment kurier:', err); kurier = { dispatch: 'blad', error: err.message }; }
      res.json({ ok: true, kurier });
    } catch (err) {
      handleError(res, err);
    }
  });

  // POST /api/fulfillment/:id/etykieta-wydrukowana — znacznik po kliknięciu
  // „Drukuj etykietę" (pierwszy raz) + próba zamówienia kuriera (raz dziennie).
  app.post('/api/fulfillment/:id(\\d+)/etykieta-wydrukowana', guard, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const supabase = getClient();
      const { data: ships, error } = await supabase.from('wyceny_shipments')
        .select('*').eq('wycena_id', id).neq('kind', 'reship').order('created_at', { ascending: true });
      if (error) throw error;
      const ship = (ships || [])[ships && ships.length ? ships.length - 1 : 0];
      if (!ship) return res.status(400).json({ error: 'Brak przesyłki dla tego zamówienia.' });
      if (!ship.label_printed_at) {
        const nowIso = new Date().toISOString();
        const { error: uErr } = await supabase.from('wyceny_shipments')
          .update({ label_printed_at: nowIso, updated_at: nowIso }).eq('id', ship.id);
        if (uErr) throw uErr;
        await supabase.from('wyceny_events').insert({
          wycena_id: id, kind: 'label.printed',
          payload: { user: req.user?.name || null, shipment_id: ship.shipment_id },
        });
      }
      let kurier = null;
      try { kurier = await zamowKuriera(supabase, { user: req.user?.name }); }
      catch (err) { console.error('Fulfillment kurier:', err); kurier = { dispatch: 'blad', error: err.message }; }
      res.json({ ok: true, kurier });
    } catch (err) {
      handleError(res, err);
    }
  });

  // POST /api/fulfillment/:id/oznacz-nadane — ręczne „spakowane i nadane".
  // Ustawia przesyłkę na 'sent' + nadana_at; worker/tracking domknie doręczenie.
  app.post('/api/fulfillment/:id(\\d+)/oznacz-nadane', guard, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const supabase = getClient();
      const { data: ships, error } = await supabase.from('wyceny_shipments')
        .select('*').eq('wycena_id', id).neq('kind', 'reship').order('created_at', { ascending: true });
      if (error) throw error;
      const ship = (ships || [])[ships && ships.length ? ships.length - 1 : 0];
      if (!ship) return res.status(400).json({ error: 'Brak przesyłki — najpierw utwórz etykietę (Oznacz opłacone / Realizuj).' });
      if (String(ship.status) === 'delivered' || ship.delivered_at) return res.json({ ok: true, skipped: 'delivered' });
      await supabase.from('wyceny_shipments').update({
        status: 'sent',
        nadana_at: ship.nadana_at || new Date().toISOString(),
        raw_status: 'dispatched_by_sender (ręcznie)',
        checked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', ship.id);
      await supabase.from('wyceny_events').insert({
        wycena_id: id, kind: 'shipment.marked_sent',
        payload: { source: 'fulfillment-manual', user: req.user?.name || null, tracking: ship.tracking_number || null },
      });
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  // POST /api/fulfillment/:id/oznacz-dostarczone — ręczne domknięcie (delivered
  // -> Closed + faktura końcowa dla pobrania). Reużywa onDelivered z pipeline.
  app.post('/api/fulfillment/:id(\\d+)/oznacz-dostarczone', guard, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const supabase = getClient();
      const { data: ships, error } = await supabase.from('wyceny_shipments')
        .select('*').eq('wycena_id', id).neq('kind', 'reship').order('created_at', { ascending: true });
      if (error) throw error;
      const ship = (ships || [])[ships && ships.length ? ships.length - 1 : 0];
      if (!ship) return res.status(400).json({ error: 'Brak przesyłki do oznaczenia.' });
      if (ship.delivered_at) return res.json({ ok: true, skipped: 'already-delivered' });
      const { onDelivered } = require('./wyceny-pipeline');
      await onDelivered(supabase, ship);
      await supabase.from('wyceny_events').insert({
        wycena_id: id, kind: 'tracking.delivered',
        payload: { source: 'fulfillment-manual', user: req.user?.name || null },
      });
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  // POST /api/fulfillment/:id/oznacz-oplacone — przelew opłacony poza inFakt.
  // Tworzy przesyłkę + etykietę od razu (jak automatyczna płatność).
  app.post('/api/fulfillment/:id(\\d+)/oznacz-oplacone', guard, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const supabase = getClient();
      const { data, error } = await supabase.from('wyceny').select('id,source').eq('id', id).limit(1);
      if (error) throw error;
      const w = data && data[0];
      if (!w) return res.status(404).json({ error: 'Nie znaleziono zamówienia' });
      // Sklep (Shopify) ma własną płatność/fulfillment — nie oznaczamy tu.
      // Import (migracja z Make) TAK: bywa realnym zamówieniem czekającym na
      // przelew (np. #1809), które trzeba domknąć ręcznie po wpłacie.
      if (w.source === 'shopify') {
        return res.status(400).json({ error: 'Zamówienie ze sklepu (Shopify) ma własny fulfillment — nie oznaczamy go tutaj.' });
      }
      const { markPaidAndShip } = require('./wyceny-pipeline');
      const result = await markPaidAndShip(supabase, id);
      res.json({ ok: true, ...result });
    } catch (err) {
      handleError(res, err);
    }
  });
}

module.exports = { registerFulfillmentEndpoints, bucketOf };
