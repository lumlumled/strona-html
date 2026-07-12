// ── Panel Fulfillment (lumlum.dev/fulfillment) — pulpit pakowania ────────────
// Osobny, ADMIN-ONLY widok nad tymi samymi danymi co Sprzedaże (tabela wyceny +
// wyceny_shipments). Cała maszyna stanów, tracking i faktury już żyją w
// wyceny-pipeline.js — tu tylko PREZENTUJEMY „co spakować i nadać" i dajemy
// dwie/trzy akcje ręczne. Zero nowych kolumn: bucket liczony z payment_method,
// paid i statusu przesyłki.
//
// Stany (decyzja Antoniego 2026-07-13):
//   do_spakowania   — gotowe do wysyłki (pobranie albo opłacony przelew),
//                     etykieta jest, przesyłka jeszcze NIE nadana fizycznie.
//   czeka_na_platnosc — przelew nieopłacony (przycisk „Oznacz opłacone").
//   wyslane         — nadane (tracking sent / nadana_at / ręcznie); trzymamy 5
//                     dni po doręczeniu, potem znika (zamknięte).
// Nadanie/doręczenie łapie worker z trackingu w oknach 17–18 / 10–16, albo
// oznaczasz ręcznie tutaj (natychmiast).

const HISTORIA_MS = 5 * 24 * 60 * 60 * 1000; // wysłane trzymamy 5 dni po doręczeniu

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
  if (String(w.status || '').toLowerCase() === 'stracone') return null;

  if (doreczona(ship)) {
    const dt = ship.delivered_at ? new Date(ship.delivered_at).getTime() : 0;
    return dt && now - dt < HISTORIA_MS ? 'wyslane' : null; // po 5 dniach: zamknięte
  }
  if (nadana(ship)) return 'wyslane';

  const gotowe = !jestPrzelew(w) || w.paid;
  if (!gotowe) return jestPrzelew(w) ? 'czeka_na_platnosc' : null;
  return 'do_spakowania';
}

// Zamówienie „w grze" (już realizowane) — filtruje szkice/wyceny bez wysyłki.
function realizowane(w, shipments) {
  return w.form_status === 'SUBMITTED' || (shipments && shipments.length > 0) || w.paid;
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
    miejsce: placeOf(w),
    items: serializeItems(w.items, cennikBySku),
    shipment: ship ? {
      id: ship.shipment_id,
      tracking_number: ship.tracking_number || '',
      status: ship.status,
      raw_status: ship.raw_status || '',
      nadana_at: ship.nadana_at || null,
      delivered_at: ship.delivered_at || null,
      cod_amount: ship.cod_amount || null,
    } : null,
    brak_etykiety: !ship, // gotowe do spakowania, ale przesyłki jeszcze nie ma (zagranica / świeżo opłacone)
  };
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
        .neq('source', 'shopify').neq('source', 'import')
        .order('created_at', { ascending: false });
      if (error) throw error;

      const rows = (wyceny || []).filter(jestNasze);
      const ids = rows.map((w) => w.id);
      let shipments = [];
      if (ids.length) {
        const { data, error: sErr } = await supabase.from('wyceny_shipments')
          .select('*').in('wycena_id', ids).order('created_at', { ascending: true });
        if (sErr) throw sErr;
        shipments = data || [];
      }
      const shipByWycena = new Map();
      shipments.forEach((s) => {
        if (!shipByWycena.has(s.wycena_id)) shipByWycena.set(s.wycena_id, []);
        shipByWycena.get(s.wycena_id).push(s);
      });

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
      const out = { do_spakowania: [], czeka_na_platnosc: [], wyslane: [] };
      rows.forEach((w) => {
        const sh = shipByWycena.get(w.id) || [];
        if (!realizowane(w, sh)) return;
        const bucket = bucketOf(w, przesylkaZamowienia(sh), now);
        if (!bucket) return;
        out[bucket].push(serializeOrder(w, sh, bucket, cennikBySku));
      });
      // „do spakowania": najstarsze u góry (najdłużej czekają); reszta: najnowsze u góry.
      out.do_spakowania.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
      res.json({ data: out });
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
      if (w.source === 'shopify' || w.source === 'import') {
        return res.status(400).json({ error: 'To zamówienie ma własny fulfillment (sklep/import) — nie oznaczamy go tutaj.' });
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
