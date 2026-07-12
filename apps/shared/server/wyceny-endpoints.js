// ── Wspólne endpointy wycen (zakładka Wyceny w CRM + panel Sprzedaże) ────────
// Jedna implementacja rejestrowana przez oba serwery — ta sama zasada co
// leady-endpoints.js: karta wyceny nigdy się nie rozjeżdża między appkami.
//
// Własność (docs/plan-wlasnosc-zasobow.md): filtr server-side — nie-admin
// widzi wyłącznie wyceny z owner = własne imię. Kolumny kosztów/marż z
// sku_cennik (jsonb `koszty`) wychodzą TYLKO do admina (zasada jak w
// kb-import-sku.js).
//
// Rabat NIE jest kolumną: discount = kwota_proponowana_brutto − Σ(price×qty),
// identycznie jak w webhooku GET Make ("Zniżka kwota") — jedno źródło prawdy,
// panel i formularz zawsze pokazują tę samą liczbę.

const WYCENY_STATUSY = ['Open', 'Waiting for payment', 'Fulfilled', 'Closed', 'Stracone'];
const WYCENY_TYPY = ['WYCENA', 'ZAMÓWIENIE', 'NOTATKA'];

// Publiczny link formularza dla klienta (podmieniany na formularz-test w testach).
function formularzLink(wycena) {
  const base = process.env.FORMULARZ_URL || 'https://lumlum.co/pages/formularz';
  const token = wycena.form_token ? `&t=${wycena.form_token}` : '';
  return `${base}?id=${wycena.id}${token}`;
}

function num(v) {
  const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

// Suma pozycji liczona jak w Make (FunctionAggregator: price * quantity).
function sumaPozycji(items) {
  return (Array.isArray(items) ? items : [])
    .reduce((acc, p) => acc + num(p.price) * num(p.quantity || 1), 0);
}

function computeDiscount(wycena) {
  const suma = sumaPozycji(wycena.items);
  const kwota = wycena.kwota_proponowana_brutto;
  if (kwota === null || kwota === undefined || !suma) return 0;
  return Math.round((num(kwota) - suma) * 100) / 100;
}

function decorate(wycena) {
  const suma = Math.round(sumaPozycji(wycena.items) * 100) / 100;
  return {
    ...wycena,
    _suma_pozycji: suma,
    _discount: computeDiscount(wycena),
    _link: formularzLink(wycena),
    _rabat24h_aktywny: Boolean(
      wycena.rabat24h_kwota && wycena.rabat24h_wazny_do
      && new Date(wycena.rabat24h_wazny_do).getTime() > Date.now()
    ),
  };
}

// Pozycja z linkiem do zdjęcia trafia do cennika (baza SKU) — decyzja
// Antoniego: własna pozycja z linkiem dopisuje się do bazy. Idempotentne i
// nienadpisujące: znany SKU zostawiamy w spokoju (nie psujemy ceny w cenniku),
// brak SKU dopasowujemy po nazwie, a dopiero nowość dostaje wygenerowany SKU.
async function syncItemsToCennik(supabase, items) {
  if (!Array.isArray(items) || !items.length) return items;
  for (const p of items) {
    const nazwa = String(p.name || '').trim();
    const image = String(p.image_url || '').trim();
    if (!nazwa || !image) continue; // tylko pozycje z linkiem do zdjęcia
    let sku = String(p.SKU || '').trim();
    if (sku) {
      const { data: ex } = await supabase.from('sku_cennik').select('sku').eq('sku', sku).limit(1);
      if (ex && ex.length) continue; // znany produkt — nie nadpisujemy cennika
    } else {
      const { data: ex } = await supabase.from('sku_cennik').select('sku').ilike('nazwa', nazwa).limit(1);
      if (ex && ex.length) { p.SKU = ex[0].sku; continue; }
      sku = `C-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
      p.SKU = sku;
    }
    const { error } = await supabase.from('sku_cennik').insert({
      sku,
      nazwa,
      price_brutto: p.price !== undefined && p.price !== '' ? num(p.price) : null,
      vat: Number.parseInt(p.VAT, 10) || 23,
      unit: p.unit || 'szt',
      image_url: image,
      active: true,
    });
    if (error) console.error(`Cennik insert (${sku}) błąd:`, error.message);
  }
  return items;
}

async function logEvent(supabase, wycenaId, kind, payload) {
  const { error } = await supabase
    .from('wyceny_events')
    .insert({ wycena_id: wycenaId, kind, payload: payload || null });
  if (error) console.error(`Błąd zapisu zdarzenia ${kind} wyceny ${wycenaId}:`, error.message);
}

// Pola edytowalne z panelu ("żyjąca wycena" — decyzja Antoniego 2026-07-11).
// Owner celowo POZA listą — zmienia go tylko admin (osobna ścieżka niżej).
const EDITABLE_WYCENA_FIELDS = [
  'typ', 'status', 'imie_nazwisko', 'telefon_e164', 'email', 'adres',
  'opis_zamowienia', 'komentarz', 'dane_do_faktury', 'partner', 'prowizja_status',
  'items', 'kwota_proponowana_brutto', 'kwota_sprzedazy_brutto',
  'rabat24h_kwota', 'rabat24h_wazny_do', 'lead_id',
  'payment_method', 'delivery_method', 'punkt_odbioru', 'punkt_odbioru_adres',
  'first_name', 'last_name', 'ship_street', 'ship_house_no', 'ship_flat_no',
  'ship_postcode', 'ship_city', 'ship_country',
  'invoice_company_nip', 'invoice_company_name',
];

function registerWycenyEndpoints(app, { getClient, requireView, requireEdit, isAdmin }) {
  function handleError(res, err, fallbackStatus = 400) {
    console.error(err);
    res.status(fallbackStatus).json({ error: err.message || 'Wewnętrzny błąd serwera' });
  }

  // Widoczność (decyzja Antoniego 2026-07-13): SPRZEDAŻE (typ ZAMÓWIENIE) są
  // PRYWATNE — nie-admin widzi wyłącznie swoje. WYCENY/notatki są OTWARTE —
  // cały zespół (Antoni + Lorenzo) widzi wszystkie; kolumna owner służy tu
  // tylko do oznaczenia autora i filtra w UI, nie ogranicza widoku. Filtr
  // siedzi w zapytaniu (nie w JS — cudze sprzedaże nie opuszczają bazy) i
  // działa jednakowo dla list, pojedynczego GET oraz zapisów (update … where
  // id): nie-admin nie ruszy cudzej sprzedaży, ale wyceny są wspólne.
  function scoped(query, req) {
    if (isAdmin(req.user)) return query;
    const name = String(req.user.name || '').trim();
    if (!name) return query.neq('typ', 'ZAMÓWIENIE');
    return query.or(`typ.neq.ZAMÓWIENIE,owner.ilike.${name}`);
  }

  async function fetchList(req, { typ, excludeTyp } = {}) {
    const supabase = getClient();
    let q = scoped(supabase.from('wyceny').select('*'), req).order('id', { ascending: false });
    if (typ) q = q.eq('typ', typ);
    if (excludeTyp) q = q.neq('typ', excludeTyp);
    const { data: wyceny, error } = await q;
    if (error) throw error;

    const ids = (wyceny || []).map((w) => w.id);
    let shipments = [], invoices = [];
    if (ids.length) {
      const [s, i] = await Promise.all([
        supabase.from('wyceny_shipments').select('*').in('wycena_id', ids).order('created_at', { ascending: true }),
        supabase.from('wyceny_invoices').select('*').in('wycena_id', ids).order('created_at', { ascending: true }),
      ]);
      if (s.error) throw s.error;
      if (i.error) throw i.error;
      shipments = s.data || [];
      invoices = i.data || [];
    }
    const shipByWycena = new Map();
    shipments.forEach((s) => {
      if (!shipByWycena.has(s.wycena_id)) shipByWycena.set(s.wycena_id, []);
      shipByWycena.get(s.wycena_id).push(s);
    });
    const invByWycena = new Map();
    invoices.forEach((i) => {
      if (!invByWycena.has(i.wycena_id)) invByWycena.set(i.wycena_id, []);
      invByWycena.get(i.wycena_id).push(i);
    });
    return (wyceny || []).map((w) => ({
      ...decorate(w),
      _shipments: shipByWycena.get(w.id) || [],
      _invoices: invByWycena.get(w.id) || [],
    }));
  }

  // GET /api/wyceny[?typ=ZAMÓWIENIE][?bez_typ=ZAMÓWIENIE] — lista z
  // przesyłkami/fakturami. `bez_typ` wyklucza dany typ (zakładka Wyceny B2C
  // woła ?bez_typ=ZAMÓWIENIE — sprzedaże mają własny panel Sprzedaże).
  app.get('/api/wyceny', requireView, async (req, res) => {
    try {
      const typ = WYCENY_TYPY.includes(req.query.typ) ? req.query.typ : undefined;
      const excludeTyp = WYCENY_TYPY.includes(req.query.bez_typ) ? req.query.bez_typ : undefined;
      const data = await fetchList(req, { typ, excludeTyp });
      const typy = excludeTyp ? WYCENY_TYPY.filter((t) => t !== excludeTyp) : WYCENY_TYPY;
      res.json({ data, statusy: WYCENY_STATUSY, typy, editableFields: EDITABLE_WYCENA_FIELDS });
    } catch (err) {
      handleError(res, err, 502);
    }
  });

  // GET /api/wyceny/cennik — SKU do edytora; koszty/marże tylko dla admina.
  app.get('/api/wyceny/cennik', requireView, async (req, res) => {
    try {
      const { data, error } = await getClient()
        .from('sku_cennik').select('*').eq('active', true).order('nazwa');
      if (error) throw error;
      const admin = isAdmin(req.user);
      res.json({
        data: (data || []).map((r) => (admin ? r : { ...r, koszty: undefined })),
      });
    } catch (err) {
      handleError(res, err, 502);
    }
  });

  // GET /api/sprzedaze/stats[?owner=Lorenzo] — nagłówek panelu Sprzedaże.
  // "Sprzedaż" = typ ZAMÓWIENIE; kwota = kwota_sprzedazy_brutto, fallback
  // proponowana. Param `owner` (TYLKO admin) zawęża statystyki do jednego
  // właściciela — przełącznik A/L w panelu przełącza też widok statystyk.
  // Nie-admin ma scoped() do siebie, więc param i tak jest bez znaczenia.
  app.get('/api/sprzedaze/stats', requireView, async (req, res) => {
    try {
      const supabase = getClient();
      let q = scoped(
        supabase.from('wyceny').select('id,typ,created_at,kwota_sprzedazy_brutto,kwota_proponowana_brutto,paid'),
        req
      ).eq('typ', 'ZAMÓWIENIE');
      const ownerParam = String(req.query.owner || '').trim();
      if (ownerParam && isAdmin(req.user)) q = q.ilike('owner', ownerParam);
      const { data, error } = await q;
      if (error) throw error;
      const rows = data || [];
      const warsaw = (d) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit' }).format(new Date(d));
      const thisMonth = warsaw(new Date()); // "YYYY-MM"
      const [ty, tm] = thisMonth.split('-').map(Number);
      const prevMonth = tm === 1 ? `${ty - 1}-12` : `${ty}-${String(tm - 1).padStart(2, '0')}`;
      const kwota = (r) => num(r.kwota_sprzedazy_brutto ?? r.kwota_proponowana_brutto);
      const sum = (arr) => Math.round(arr.reduce((a, r) => a + kwota(r), 0) * 100) / 100;
      const inMonth = (m) => rows.filter((r) => r.created_at && warsaw(r.created_at) === m);
      const prevSuma = sum(inMonth(prevMonth));

      // Porównanie do TEMPA, nie do całej kwoty: uśredniamy obrót zeszłego
      // miesiąca na dzień i skalujemy liczbą dni, które już minęły w tym
      // miesiącu. Dzięki temu 1. dnia nie jesteś "−100%", tylko relacja do
      // oczekiwanego tempa (decyzja Antoniego 2026-07-12).
      const [py, pm] = prevMonth.split('-').map(Number);
      const daysInPrevMonth = new Date(py, pm, 0).getDate();
      const daysElapsed = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', day: 'numeric' }).format(new Date()));
      const poprzedniDoTempa = daysInPrevMonth
        ? Math.round((prevSuma / daysInPrevMonth) * daysElapsed * 100) / 100
        : 0;

      res.json({
        total: { count: rows.length, suma: sum(rows) },
        tenMiesiac: { count: inMonth(thisMonth).length, suma: sum(inMonth(thisMonth)) },
        poprzedniMiesiac: { count: inMonth(prevMonth).length, suma: prevSuma },
        tempo: { daysElapsed, daysInPrevMonth, poprzedniDoTempa },
      });
    } catch (err) {
      handleError(res, err, 502);
    }
  });

  // GET /api/wyceny/:id — pełna karta + zdarzenia pipeline.
  app.get('/api/wyceny/:id(\\d+)', requireView, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const supabase = getClient();
      const { data, error } = await scoped(supabase.from('wyceny').select('*'), req).eq('id', id).limit(1);
      if (error) throw error;
      if (!data || !data.length) return res.status(404).json({ error: 'Nie znaleziono wyceny' });
      const [s, i, e] = await Promise.all([
        supabase.from('wyceny_shipments').select('*').eq('wycena_id', id).order('created_at', { ascending: true }),
        supabase.from('wyceny_invoices').select('*').eq('wycena_id', id).order('created_at', { ascending: true }),
        supabase.from('wyceny_events').select('*').eq('wycena_id', id).order('created_at', { ascending: false }).limit(200),
      ]);
      if (s.error) throw s.error;
      if (i.error) throw i.error;
      if (e.error) throw e.error;
      res.json({
        data: {
          ...decorate(data[0]),
          _shipments: s.data || [],
          _invoices: i.data || [],
          _events: e.data || [],
        },
      });
    } catch (err) {
      handleError(res, err, 502);
    }
  });

  // GET /api/wyceny/:id/rozmowy — wszystko, co wiemy o kliencie: wpisy z
  // "Log zmian" dopasowane po numerze telefonu wyceny (rozmowy Zadarmy z
  // transkrypcją, notatki handlowca). Najnowsze na górze. Zastępuje przycisk
  // "Realizuj zamówienie" na karcie — handlowiec widzi kontekst, nie akcję.
  app.get('/api/wyceny/:id(\\d+)/rozmowy', requireView, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const supabase = getClient();
      const { data, error } = await scoped(supabase.from('wyceny').select('telefon_digits,telefon_e164'), req)
        .eq('id', id).limit(1);
      if (error) throw error;
      if (!data || !data.length) return res.status(404).json({ error: 'Nie znaleziono wyceny' });
      const digits = String(data[0].telefon_digits || String(data[0].telefon_e164 || '').replace(/\D/g, '').replace(/^48/, '')).trim();
      if (!digits) return res.json({ rozmowy: [] });
      const { data: log, error: logErr } = await supabase
        .from('Log zmian').select('*').eq('telefon', digits)
        .order('data_zmiany', { ascending: false }).limit(200);
      if (logErr) throw logErr;
      res.json({ rozmowy: log || [] });
    } catch (err) {
      handleError(res, err, 502);
    }
  });

  // POST /api/wyceny — nowa wycena z panelu (edytor / szybkie dodanie /
  // przycisk na karcie leada). ID z sekwencji arkusza, owner z sesji.
  app.post('/api/wyceny', requireEdit, async (req, res) => {
    try {
      const supabase = getClient();
      const body = req.body || {};
      const patch = {};
      EDITABLE_WYCENA_FIELDS.forEach((f) => { if (body[f] !== undefined) patch[f] = body[f]; });
      if (!patch.items && !body.items) patch.items = [];
      const maKontakt = String(patch.telefon_e164 || '').trim() || String(patch.email || '').trim();
      if (!maKontakt && !patch.lead_id) {
        return res.status(400).json({ error: 'Wycena wymaga telefonu lub e-maila (albo podpięcia pod leada)' });
      }
      if (patch.telefon_e164) patch.telefon_digits = String(patch.telefon_e164).replace(/\D/g, '').replace(/^48/, '');
      if (patch.items) await syncItemsToCennik(supabase, patch.items);
      const { data: idData, error: idErr } = await supabase.rpc('wyceny_next_id');
      if (idErr) throw idErr;
      const id = idData;
      const crypto = require('crypto');
      const row = {
        id,
        owner: String(req.user.name || 'Antoni'),
        source: body.source === 'quick-add' ? 'quick-add' : 'panel',
        form_token: crypto.randomBytes(12).toString('base64url'),
        ...patch,
      };
      const { data, error } = await supabase.from('wyceny').insert(row).select('*');
      if (error) throw error;
      await logEvent(supabase, id, 'wycena.created', { source: row.source, user: req.user.name });
      res.json({ data: decorate(data[0]) });
    } catch (err) {
      handleError(res, err, 502);
    }
  });

  // PUT /api/wyceny/:id — edycja "żyjącej" wyceny (whitelist pól).
  // Formularz kliencki zawsze czyta świeży stan, więc edycja działa też po
  // wysłaniu linku. Zmiana ownera: tylko admin.
  app.put('/api/wyceny/:id(\\d+)', requireEdit, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const supabase = getClient();
      const body = req.body || {};
      const patch = {};
      EDITABLE_WYCENA_FIELDS.forEach((f) => { if (body[f] !== undefined) patch[f] = body[f]; });
      if (body.owner !== undefined && isAdmin(req.user)) patch.owner = String(body.owner).trim();
      if (patch.telefon_e164 !== undefined) {
        patch.telefon_digits = String(patch.telefon_e164 || '').replace(/\D/g, '').replace(/^48/, '') || null;
      }
      if (patch.typ && !WYCENY_TYPY.includes(patch.typ)) delete patch.typ;
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'Brak zmian do zapisania' });
      if (patch.items) await syncItemsToCennik(supabase, patch.items);
      patch.updated_at = new Date().toISOString();

      const { data, error } = await scoped(supabase.from('wyceny').update(patch), req)
        .eq('id', id).select('*');
      if (error) throw error;
      if (!data || !data.length) return res.status(404).json({ error: 'Nie znaleziono wyceny' });
      await logEvent(supabase, id, 'wycena.edited', { fields: Object.keys(patch), user: req.user.name });
      res.json({ data: decorate(data[0]) });
    } catch (err) {
      handleError(res, err, 502);
    }
  });

  // POST /api/wyceny/:id/wyslij-link — kopiowanie linku w panelu oznacza
  // etap FORM_SENT (tylko z NEW — późniejsze kopiowania nie cofają stanu).
  app.post('/api/wyceny/:id(\\d+)/wyslij-link', requireEdit, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const supabase = getClient();
      const { data, error } = await scoped(supabase.from('wyceny').select('*'), req).eq('id', id).limit(1);
      if (error) throw error;
      if (!data || !data.length) return res.status(404).json({ error: 'Nie znaleziono wyceny' });
      const wycena = data[0];
      if (wycena.process_stage === 'NEW') {
        const { error: upErr } = await supabase.from('wyceny')
          .update({ process_stage: 'FORM_SENT', updated_at: new Date().toISOString() })
          .eq('id', id);
        if (upErr) throw upErr;
        await logEvent(supabase, id, 'form.link_sent', { user: req.user.name });
      }
      res.json({ link: formularzLink(wycena) });
    } catch (err) {
      handleError(res, err, 502);
    }
  });

  // ── Szybkie dodanie (pole tekstowe -> GPT -> podgląd -> zapis) ────────────

  // POST /api/wyceny/parsuj { tekst } -> { parsed, row, match }
  // Sam parsing + dopasowanie istniejącej wyceny; NIC nie zapisuje — panel
  // pokazuje podgląd do zatwierdzenia (przewaga nad Telegramem).
  app.post('/api/wyceny/parsuj', requireEdit, async (req, res) => {
    try {
      const tekst = String(req.body?.tekst || '').trim();
      if (!tekst) return res.status(400).json({ error: 'Wpisz treść wyceny' });
      const parser = require('./wyceny-parser');
      const parsed = await parser.parseWycenaText(tekst);
      const row = parser.parsedToRow(parsed, tekst);
      const match = await parser.findMatch(getClient(), parsed);
      res.json({ parsed, row, match });
    } catch (err) {
      handleError(res, err, 502);
    }
  });

  // POST /api/wyceny/zapisz-parsowane { tekst, row, decyzja, matchId }
  // decyzja: 'nowa' (nowy wiersz) | 'podmien' (FULL_REPLACE na istniejącej —
  // podmiana items+kwoty, kontakt zostaje, log dopisany).
  app.post('/api/wyceny/zapisz-parsowane', requireEdit, async (req, res) => {
    try {
      const supabase = getClient();
      const { tekst, row, decyzja, matchId } = req.body || {};
      if (!row || typeof row !== 'object') return res.status(400).json({ error: 'Brak danych wyceny' });

      if (decyzja === 'podmien' && matchId) {
        const { data: oldData, error: oldErr } = await scoped(supabase.from('wyceny').select('*'), req)
          .eq('id', Number(matchId)).limit(1);
        if (oldErr) throw oldErr;
        if (!oldData || !oldData.length) return res.status(404).json({ error: 'Nie znaleziono wyceny do podmiany' });
        const old = oldData[0];
        const patch = {
          items: Array.isArray(row.items) && row.items.length ? row.items : old.items,
          kwota_proponowana_brutto: row.kwota_proponowana_brutto ?? old.kwota_proponowana_brutto,
          typ: row.typ === 'ZAMÓWIENIE' ? 'ZAMÓWIENIE' : old.typ,
          rabat24h_kwota: row.rabat24h_kwota ?? old.rabat24h_kwota,
          rabat24h_wazny_do: row.rabat24h_wazny_do ?? old.rabat24h_wazny_do,
          history_log: [old.history_log, row.history_log].filter(Boolean).join('\n'),
          updated_at: new Date().toISOString(),
        };
        const { data, error } = await supabase.from('wyceny').update(patch).eq('id', old.id).select('*');
        if (error) throw error;
        await logEvent(supabase, old.id, 'wycena.edited', { source: 'quick-add', mode: 'FULL_REPLACE', user: req.user.name });
        return res.json({ data: decorate(data[0]), updated: true });
      }

      // nowa wycena
      const maKontakt = String(row.telefon_e164 || '').trim() || String(row.email || '').trim();
      if (!maKontakt && !row.lead_id) {
        return res.status(400).json({ error: 'Wycena wymaga telefonu lub e-maila (albo podpięcia pod leada)' });
      }
      const { data: idData, error: idErr } = await supabase.rpc('wyceny_next_id');
      if (idErr) throw idErr;
      const crypto = require('crypto');
      const insert = {
        id: idData,
        owner: String(req.user.name || 'Antoni'),
        source: 'quick-add',
        form_token: crypto.randomBytes(12).toString('base64url'),
      };
      EDITABLE_WYCENA_FIELDS.forEach((f) => { if (row[f] !== undefined) insert[f] = row[f]; });
      insert.status = row.status || 'Open';
      insert.history_log = row.history_log || null;
      if (insert.items) await syncItemsToCennik(supabase, insert.items);
      if (insert.telefon_e164) insert.telefon_digits = String(insert.telefon_e164).replace(/\D/g, '').replace(/^48/, '');
      const { data, error } = await supabase.from('wyceny').insert(insert).select('*');
      if (error) throw error;
      await logEvent(supabase, idData, 'wycena.created', { source: 'quick-add', user: req.user.name, tekst: String(tekst || '').slice(0, 500) });
      res.json({ data: decorate(data[0]), created: true });
    } catch (err) {
      handleError(res, err, 502);
    }
  });

  // ── Pipeline z panelu ─────────────────────────────────────────────────────

  // POST /api/wyceny/:id/reship — "Zamów kuriera ponownie": nowa przesyłka
  // ShipX na te same dane, BEZ faktury i bez zmiany statusów (kind 'reship').
  app.post('/api/wyceny/:id(\\d+)/reship', requireEdit, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const supabase = getClient();
      const { data, error } = await scoped(supabase.from('wyceny').select('id'), req).eq('id', id).limit(1);
      if (error) throw error;
      if (!data || !data.length) return res.status(404).json({ error: 'Nie znaleziono wyceny' });
      const { reship } = require('./wyceny-pipeline');
      const shipment = await reship(supabase, id);
      res.json({ data: shipment });
    } catch (err) {
      handleError(res, err, 502);
    }
  });

  // POST /api/wyceny/:id/realizuj — "Realizuj zamówienie" bez formularza
  // (sprzedaż domknięta telefonicznie): wymaga płatności i adresu/paczkomatu,
  // zamyka formularz i odpala ten sam pipeline co submit.
  app.post('/api/wyceny/:id(\\d+)/realizuj', requireEdit, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const supabase = getClient();
      const { data, error } = await scoped(supabase.from('wyceny').select('*'), req).eq('id', id).limit(1);
      if (error) throw error;
      if (!data || !data.length) return res.status(404).json({ error: 'Nie znaleziono wyceny' });
      const w = data[0];
      if (!w.payment_method) return res.status(400).json({ error: 'Ustaw metodę płatności (transfer/cod) w edycji wyceny' });
      const maLocker = String(w.punkt_odbioru || '').replace(/[,\s]/g, '').length > 3;
      const maAdres = w.ship_street && w.ship_postcode && w.ship_city;
      if (!maLocker && !maAdres) return res.status(400).json({ error: 'Uzupełnij adres dostawy albo paczkomat w edycji wyceny' });
      if (!w.first_name && !w.imie_nazwisko) return res.status(400).json({ error: 'Uzupełnij imię i nazwisko odbiorcy' });
      await supabase.from('wyceny').update({
        form_status: 'SUBMITTED',
        form_submitted_at: w.form_submitted_at || new Date().toISOString(),
        typ: 'ZAMÓWIENIE',
        process_stage: 'SUBMITTED',
        first_name: w.first_name || String(w.imie_nazwisko || '').split(' ')[0],
        last_name: w.last_name || String(w.imie_nazwisko || '').split(' ').slice(1).join(' '),
        updated_at: new Date().toISOString(),
      }).eq('id', id);
      await logEvent(supabase, id, 'form.submitted', { source: 'panel-realizuj', user: req.user.name });
      const { startPipeline } = require('./wyceny-pipeline');
      const result = await startPipeline(supabase, id);
      res.json({ ok: true, ...result });
    } catch (err) {
      handleError(res, err, 502);
    }
  });

  // Proxy plików: PDF faktury (inFakt) i etykiety (ShipX) wymagają naszych
  // sekretów — panel dostaje je przez te endpointy, nic nie idzie na Drive.
  app.get('/api/wyceny/invoice-pdf/:uuid', requireView, async (req, res) => {
    try {
      const infakt = require('./wyceny-infakt');
      const pdf = await infakt.downloadPdf(String(req.params.uuid));
      res.type('application/pdf').set('Content-Disposition', 'inline; filename="faktura.pdf"').send(pdf);
    } catch (err) {
      handleError(res, err, 502);
    }
  });

  app.get('/api/wyceny/label/:shipmentId', requireView, async (req, res) => {
    try {
      const shipx = require('./wyceny-shipx');
      const pdf = await shipx.downloadLabel(String(req.params.shipmentId));
      res.type('application/pdf').set('Content-Disposition', 'inline; filename="etykieta.pdf"').send(pdf);
    } catch (err) {
      handleError(res, err, 502);
    }
  });

  // POST /api/wyceny/:id/otworz-formularz — odblokowanie jednorazowego
  // formularza (np. klient pomylił adres). Historia submitu zostaje w events.
  app.post('/api/wyceny/:id(\\d+)/otworz-formularz', requireEdit, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const supabase = getClient();
      const { data, error } = await scoped(
        supabase.from('wyceny').update({ form_status: 'NEW', updated_at: new Date().toISOString() }),
        req
      ).eq('id', id).select('id,form_token');
      if (error) throw error;
      if (!data || !data.length) return res.status(404).json({ error: 'Nie znaleziono wyceny' });
      await logEvent(supabase, id, 'form.reopened', { user: req.user.name });
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err, 502);
    }
  });
}

module.exports = {
  registerWycenyEndpoints,
  formularzLink,
  computeDiscount,
  sumaPozycji,
  logEvent,
  WYCENY_STATUSY,
  WYCENY_TYPY,
  EDITABLE_WYCENA_FIELDS,
};
