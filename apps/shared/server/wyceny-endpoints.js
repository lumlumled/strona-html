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

// Watchdog feedbacku (docs/plan-watchdog-feedback.md): termin "kiedy wrócić do
// klienta" per wycena. Statusy zamykające temat gaszą watcha.
const watchdog = require('./watchdog');
const WYCENA_CLOSING_STATUSY = new Set(['Fulfilled', 'Closed', 'Stracone']);

// Lejek statusów leada (ten sam co po rozmowie telefonicznej) — utworzenie
// wyceny podbija lead do "Wycena wysłana", ale NIGDY w dół (lead "Sprzedane"
// nie cofa się przez nową wycenę). Patrz linkWycenaToLead.
const { statusRank } = require('./call-analysis');
const LEAD_STATUS_WYCENA = 'Wycena wysłana';

// "Cena, którą klient realnie płaci" — jedno źródło prawdy (rabat czasowy
// obniża cenę ostateczną, nie jest już samym banerem). Patrz wyceny-cena.js.
const { cenaFinalna, rabat24hKwota } = require('./wyceny-cena');

// Publiczny link formularza dla klienta (podmieniany na formularz-test w testach).
// Czysty ?id= bez tokenu — decyzja Antoniego: link ma być krótki. Endpoint GET
// i tak przyjmuje linki bez tokenu (tokenOk zwraca true przy braku t); form_token
// dalej żyje w bazie i chroni publiczne linki PDF etykiety/faktury.
function formularzLink(wycena) {
  const base = process.env.FORMULARZ_URL || 'https://lumlum.co/pages/formularz';
  return `${base}?id=${wycena.id}`;
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
    // Cena po rabacie czasowym = to, co panel/karta pokazują jako "Do zapłaty"
    // i co liczy się jako sprzedaż. Kwota sprzedaży (jeśli zapisana) wygrywa.
    _cena_finalna: cenaFinalna(wycena),
    _rabat24h_kwota: rabat24hKwota(wycena),
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

// Kategoria źródła wyceny (dla filtra na liście — "co jest gdzie"):
//   b2c          — podpięta pod leada B2C (lead_id) LUB tel/mail pasuje do "Leady B2C"
//   wiadomosci   — tel/mail pasuje do kontaktu w komunikatorze (kom_customer_identities)
//   b2b          — placeholder (arkusz Leady B2B jeszcze nie istnieje) — nigdy teraz nie pada
//   nieprzypisane— brak dopasowania (większość na start)
// Priorytet: b2c > wiadomosci > nieprzypisane. Zapytania ograniczone do
// telefonów/maili z bieżącej listy (nie skanują całych tabel).
async function categorizeWyceny(supabase, wyceny) {
  const cat = new Map();
  const rows = wyceny || [];
  if (!rows.length) return cat;
  const digitsOf = (w) => String(w.telefon_digits || String(w.telefon_e164 || '').replace(/\D/g, '').replace(/^48/, '')).trim();
  const emailOf = (w) => String(w.email || '').toLowerCase().trim();

  const phones9 = new Set();
  const emails = new Set();
  rows.forEach((w) => { const d = digitsOf(w); if (d) phones9.add(d); const e = emailOf(w); if (e) emails.add(e); });

  const leadPhones = new Set();
  const leadEmails = new Set();
  // "Leady B2C"."Phone number" bywa z prefiksem 48 (np. 48602366320), a
  // wyceny.telefon_digits jest 9-cyfrowe (602366320) — szukamy OBU postaci.
  const phoneNums = [];
  phones9.forEach((d) => {
    const n9 = Number(d); if (Number.isFinite(n9)) phoneNums.push(n9);
    const n48 = Number(`48${d}`); if (Number.isFinite(n48)) phoneNums.push(n48);
  });
  const komValues = new Set();

  const jobs = [];
  if (phoneNums.length) {
    jobs.push(supabase.from('Leady B2C').select('"Phone number", Email').in('Phone number', phoneNums)
      .then(({ data }) => (data || []).forEach((l) => {
        if (l['Phone number'] != null) leadPhones.add(String(l['Phone number']));
        if (l.Email) leadEmails.add(String(l.Email).toLowerCase().trim());
      })));
  }
  if (emails.size) {
    jobs.push(supabase.from('Leady B2C').select('Email').in('Email', [...emails])
      .then(({ data }) => (data || []).forEach((l) => { if (l.Email) leadEmails.add(String(l.Email).toLowerCase().trim()); })));
  }
  const lookupVals = [...[...phones9].map((d) => `48${d}`), ...emails];
  if (lookupVals.length) {
    jobs.push(supabase.from('kom_customer_identities').select('value').in('value', lookupVals)
      .then(({ data }) => (data || []).forEach((r) => { if (r.value) komValues.add(String(r.value)); })));
  }
  // Kategoryzacja to wygoda UI — pojedynczy błąd (np. brak tabeli) nie może
  // wywalić listy wycen; wtedy wszystko wpada w 'nieprzypisane'.
  await Promise.allSettled(jobs);

  rows.forEach((w) => {
    const d = digitsOf(w); const e = emailOf(w);
    const isB2C = Boolean(w.lead_id) || (d && (leadPhones.has(d) || leadPhones.has(`48${d}`))) || (e && leadEmails.has(e));
    const isMsg = (d && komValues.has(`48${d}`)) || (e && komValues.has(e));
    cat.set(w.id, isB2C ? 'b2c' : (isMsg ? 'wiadomosci' : 'nieprzypisane'));
  });
  return cat;
}

// Właściciel leada B2C po "ID Leada" (numeric w bazie, wyceny.lead_id to text).
async function fetchLeadOwner(supabase, leadId) {
  const id = Number(leadId);
  if (!Number.isFinite(id)) return null;
  const { data, error } = await supabase
    .from('Leady B2C').select('"ID Leada", Owner').eq('ID Leada', id).limit(1);
  if (error) throw error;
  return data && data[0] ? String(data[0].Owner || '').trim() || null : null;
}

// 9-cyfrowy numer wyceny → obie postaci "Phone number" w Leady B2C: część
// wierszy trzyma 48602366320 (z prefiksem), część 602366320 (bez). Zwraca
// listę Number-ów do zapytania IN.
function leadPhoneCandidates(digits) {
  const d = String(digits || '').replace(/\D/g, '');
  if (!d) return [];
  const nine = d.replace(/^48/, '');
  const cands = new Set();
  if (nine) { cands.add(Number(nine)); cands.add(Number(`48${nine}`)); }
  return [...cands].filter((n) => Number.isFinite(n));
}

// Utworzenie/przypięcie wyceny odbija się na powiązanym leadzie B2C (decyzja
// Antoniego 2026-07-14): handlowiec ma na zwiniętym case'ie od razu widzieć,
// że wycena poszła, i mieć do niej link. Robi dwie rzeczy:
//  1. "Link do formularza" leada = link do formularza tej wyceny (najnowsza
//     wygrywa — to miejsce, gdzie backlog pokazuje ↗ zamiast ×).
//  2. "Deal stage" → "Wycena wysłana", ale TYLKO w górę lejka (statusRank) —
//     lead "Sprzedane"/"Stracony" ani późniejszy etap nie cofa się.
// Lead szukany po lead_id, a gdy go brak — po numerze telefonu; dopasowanie
// po telefonie dopisuje wyceny.lead_id, żeby karta leada i kolejne edycje
// znały powiązanie. Ownera NIE rusza (auto-match nie zmienia właściciela).
// Notatki (typ NOTATKA) pomijamy. Nigdy nie wywala zapisu wyceny — błędy
// tylko logujemy. Zwraca lead_id, jeśli dopisano go po telefonie (inaczej null).
async function linkWycenaToLead(supabase, wycena) {
  try {
    if (!wycena || wycena.typ === 'NOTATKA') return null;

    let lead = null;
    let matchedByPhone = false;
    if (wycena.lead_id) {
      const id = Number(wycena.lead_id);
      if (Number.isFinite(id)) {
        const { data } = await supabase
          .from('Leady B2C').select('"ID Leada", "Deal stage", "Link do formularza"')
          .eq('ID Leada', id).limit(1);
        lead = data && data[0];
      }
    }
    if (!lead) {
      const digits = wycena.telefon_digits || String(wycena.telefon_e164 || '').replace(/\D/g, '').replace(/^48/, '');
      const cands = leadPhoneCandidates(digits);
      if (cands.length) {
        const { data } = await supabase
          .from('Leady B2C').select('"ID Leada", "Deal stage", "Link do formularza"')
          .in('Phone number', cands).limit(1);
        lead = data && data[0];
        matchedByPhone = Boolean(lead);
      }
    }
    if (!lead) return null;

    const patch = { 'Link do formularza': formularzLink(wycena) };
    if (statusRank(lead['Deal stage']) < statusRank(LEAD_STATUS_WYCENA)) {
      patch['Deal stage'] = LEAD_STATUS_WYCENA;
    }
    const { error: upErr } = await supabase
      .from('Leady B2C').update(patch).eq('ID Leada', lead['ID Leada']);
    if (upErr) throw upErr;

    // Dopisz powiązanie na wycenie, gdy złapaliśmy leada po telefonie (int-
    // jako-tekst, kanonicznie jak reszta lead_id — patrz backfill z 2026-07-12).
    if (matchedByPhone && !wycena.lead_id && lead['ID Leada'] != null) {
      const leadIdStr = String(lead['ID Leada']);
      await supabase.from('wyceny').update({ lead_id: leadIdStr }).eq('id', wycena.id);
      return leadIdStr;
    }
    return null;
  } catch (err) {
    console.error(`Wycena→lead: błąd linkowania wyceny ${wycena?.id}:`, err.message);
    return null;
  }
}

// Propagacja terminu feedbacku wyceny na leada (decyzja Antoniego 2026-07-12):
// nie dzwonimy "do wyceny", tylko do człowieka — termin wyceny podpiętej pod
// leada wchodzi też w "Data Feedbacku" leada. Wygrywa najbliższy AKTUALNY
// termin: datę leada zostawiamy tylko, gdy jest dzisiejsza/przyszła i nie
// późniejsza od nowej; pustą, przeterminowaną albo późniejszą nadpisujemy.
// Nadpisanie czyści "Godzina Feedbacku" (godzina dotyczyła starej daty).
// Kierunek TYLKO wycena->lead; watch leada z "Data Feedbacku" robi trigger
// mirrorujący (etap e planu watchdoga) — tu go celowo nie tworzymy.
async function propagateFeedbackToLead(supabase, wycena, dueYmd) {
  if (!wycena.lead_id) return;
  const leadId = Number(wycena.lead_id);
  if (!Number.isFinite(leadId)) return;
  const { data, error } = await supabase
    .from('Leady B2C').select('"ID Leada", "Data Feedbacku"').eq('ID Leada', leadId).limit(1);
  if (error) throw error;
  const lead = data && data[0];
  if (!lead) return;
  const cur = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(String(lead['Data Feedbacku'] || '').trim());
  const curYmd = cur ? `${cur[3]}-${cur[2].padStart(2, '0')}-${cur[1].padStart(2, '0')}` : null;
  const today = watchdog.warsawDatePlusDays(0);
  if (curYmd && curYmd >= today && curYmd <= dueYmd) return;
  const [y, m, d] = dueYmd.split('-');
  const { error: upErr } = await supabase
    .from('Leady B2C')
    .update({ 'Data Feedbacku': `${d}.${m}.${y}`, 'Godzina Feedbacku': null })
    .eq('ID Leada', leadId);
  if (upErr) throw upErr;
}

// Zapis terminu feedbacku z edytora (body.feedback_due = "YYYY-MM-DD" albo
// ""/null = wyłącz watchdoga dla wyceny). Jawny termin: visible=true, human.
// Błąd watcha nie może wywalić zapisu wyceny — watchdog to warstwa dodatkowa.
async function applyFeedbackDue(supabase, wycena, feedbackDue, user) {
  try {
    const raw = String(feedbackDue ?? '').trim();
    if (!raw) {
      // Wyłączenie watcha wyceny NIE czyści daty na leadzie — lead może mieć
      // własny termin z innego źródła (rozmowa, notatka, inna wycena).
      await watchdog.resolveWatch(supabase, { objectType: 'wycena', objectId: wycena.id, resolution: 'cancelled' });
      return;
    }
    const dueAt = watchdog.warsawToIso(raw);
    if (!dueAt) return;
    await watchdog.setWatch(supabase, {
      objectType: 'wycena',
      objectId: wycena.id,
      owner: wycena.owner || null,
      dueAt,
      reason: `Termin ustawiony ręcznie w edytorze przez ${user || 'panel'}`,
      setBy: 'human',
      visible: true,
      source: 'edytor',
      backlogTarget: 'b2c',
    });
    await propagateFeedbackToLead(supabase, wycena, raw);
  } catch (err) {
    console.error(`Watchdog: błąd zapisu terminu wyceny ${wycena.id}:`, err.message);
  }
}

// Po przypisaniu wyceny do leada (lead_id ustawione bez nowego feedback_due):
// istniejący otwarty watch wyceny przejmuje ownera (= ownera leada, patrz
// wyżej) i jego termin wchodzi na leada tą samą zasadą najbliższej daty.
// Dzięki temu kolejność "najpierw termin, potem przypięcie" działa tak samo
// jak "najpierw przypięcie, potem termin".
async function adoptWatchAfterAssign(supabase, wycena) {
  try {
    const map = await watchdog.getOpenWatches(supabase, 'wycena', [wycena.id]);
    const watch = map.get(String(wycena.id));
    if (!watch) return;
    if ((watch.owner || null) !== (wycena.owner || null)) {
      const { error } = await supabase.from(watchdog.FEEDBACK_WATCH_TABLE)
        .update({ owner: wycena.owner || null }).eq('id', watch.id);
      if (error) throw error;
    }
    const p = watchdog.warsawParts(new Date(watch.due_at));
    const dueYmd = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    await propagateFeedbackToLead(supabase, wycena, dueYmd);
  } catch (err) {
    console.error(`Watchdog: błąd adopcji watcha po przypisaniu wyceny ${wycena.id}:`, err.message);
  }
}

// Doklejenie otwartego watcha do wierszy listy (chip + edytor). Wygoda UI —
// błąd (np. brak tabeli) nie może położyć listy wycen.
async function attachWatches(supabase, rows) {
  try {
    const map = await watchdog.getOpenWatches(supabase, 'wycena', (rows || []).map((w) => w.id));
    return (rows || []).map((w) => ({ ...w, _watch: map.get(String(w.id)) || null }));
  } catch (err) {
    console.error('Watchdog: błąd odczytu watchy wycen:', err.message);
    return rows || [];
  }
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

// Push „Nowa wycena" — do adminów + ownera wyceny, ale NIGDY do osoby, która ją
// właśnie utworzyła (zero self-pingów za własne kliknięcie). Czyli: gdy Lorenzo
// dodaje wycenę, ping leci do Antoniego; gdy Antoni dodaje, nikogo nie budzi.
// Wzorzec 1:1 z notifyWyceny/notifyFulfillment. Nigdy nie wywala zapisu wyceny —
// błędy tylko logujemy. Notatki (typ NOTATKA) pomijamy.
async function notifyWycenaCreated(db, wycena, actorName) {
  try {
    const push = require('./push');
    if (!push || !push.notifyUser || !wycena || wycena.typ === 'NOTATKA') return;
    const aktor = String(actorName || '').trim().toLowerCase();
    const owner = String(wycena.owner || '').trim().toLowerCase();
    const { data: users } = await db.from('app_users').select('id,name,role').eq('active', true);
    const targets = (users || []).filter((u) => {
      const n = String(u.name || '').trim().toLowerCase();
      if (n === aktor) return false; // nie pinguj twórcy
      return u.role === 'admin' || (owner && n === owner);
    });
    if (!targets.length) return;
    const nazwa = wycena.imie_nazwisko
      || [wycena.first_name, wycena.last_name].filter(Boolean).join(' ').trim();
    const kwota = cenaFinalna(wycena);
    const body = `#${wycena.id}`
      + (nazwa ? ` · ${nazwa}` : '')
      + (kwota != null && kwota !== '' ? ` · ${num(kwota)} zł` : '')
      + (wycena.owner ? ` · ${wycena.owner}` : '');
    for (const u of targets) {
      await push.notifyUser(() => db, u.id, {
        title: 'Nowa wycena', body, url: '/wyceny/', tag: `wycena-created-${wycena.id}`,
      });
    }
  } catch (err) {
    console.warn(`Push nowej wyceny ${wycena?.id} nie wyszedł:`, err.message);
  }
}

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
    const zrodla = await categorizeWyceny(supabase, wyceny);
    const rows = (wyceny || []).map((w) => ({
      ...decorate(w),
      _shipments: shipByWycena.get(w.id) || [],
      _invoices: invByWycena.get(w.id) || [],
      _zrodlo: zrodla.get(w.id) || 'nieprzypisane',
    }));
    return attachWatches(supabase, rows);
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

  // GET /api/wyceny/dla-leada?telefon=&email=&lead_id= — wyceny z NOWEJ tabeli
  // dopasowane do leada (karta leada w CRM/Backlog pokazuje ten sam format ze
  // zdjęciami + edytor; edycja zapisuje tu, więc widać ją też w panelu Wyceny).
  // Match: lead_id, telefon_digits albo e-mail. Scoped jak reszta.
  app.get('/api/wyceny/dla-leada', requireView, async (req, res) => {
    try {
      const supabase = getClient();
      const telefon = String(req.query.telefon || '').replace(/\D/g, '').replace(/^48/, '');
      const email = String(req.query.email || '').toLowerCase().trim();
      const leadId = String(req.query.lead_id || '').trim();
      const ors = [];
      if (leadId) ors.push(`lead_id.eq.${leadId}`);
      if (telefon) ors.push(`telefon_digits.eq.${telefon}`);
      if (email) ors.push(`email.ilike.${email}`);
      if (!ors.length) return res.json({ data: [] });

      const { data: wyceny, error } = await scoped(supabase.from('wyceny').select('*'), req)
        .or(ors.join(',')).order('id', { ascending: false });
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
      const byWycena = (rows) => {
        const m = new Map();
        rows.forEach((r) => { if (!m.has(r.wycena_id)) m.set(r.wycena_id, []); m.get(r.wycena_id).push(r); });
        return m;
      };
      const shipMap = byWycena(shipments);
      const invMap = byWycena(invoices);
      res.json({
        data: await attachWatches(supabase, (wyceny || []).map((w) => ({
          ...decorate(w),
          _shipments: shipMap.get(w.id) || [],
          _invoices: invMap.get(w.id) || [],
        }))),
      });
    } catch (err) {
      handleError(res, err, 502);
    }
  });

  // GET /api/wyceny/szukaj-leada?q= — wyszukiwarka leadów "Leady B2C" do
  // spięcia wyceny z leadem (ustawia lead_id). Szuka po nazwie, e-mailu i
  // telefonie (3 zapytania scalone po "ID Leada"). Wygoda — błąd nie krytyczny.
  app.get('/api/wyceny/szukaj-leada', requireView, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (q.length < 2) return res.json({ data: [] });
      const supabase = getClient();
      const cols = '"ID Leada", Name, "Phone number", Email';
      const out = new Map();
      const add = (rows) => (rows || []).forEach((l) => {
        // "ID Leada" to numeric — potrafi przyjść jako "314.0"; kanoniczny
        // format lead_id w wycenach to liczba całkowita jako tekst ("314").
        const id = Number(l['ID Leada']);
        if (Number.isFinite(id) && !out.has(String(id))) {
          out.set(String(id), {
            id: String(id),
            name: l.Name || '',
            phone: l['Phone number'] != null ? String(l['Phone number']) : '',
            email: l.Email || '',
          });
        }
      });
      const jobs = [
        supabase.from('Leady B2C').select(cols).ilike('Name', `%${q}%`).limit(10).then(({ data }) => add(data)),
        supabase.from('Leady B2C').select(cols).ilike('Email', `%${q}%`).limit(10).then(({ data }) => add(data)),
      ];
      const digits = q.replace(/\D/g, '');
      if (digits.length >= 6) {
        const d9 = digits.replace(/^48/, '').slice(-9);
        // "Phone number" bywa z prefiksem 48 albo bez — szukamy obu postaci.
        const nums = [Number(d9), Number(`48${d9}`)].filter(Number.isFinite);
        if (nums.length) {
          jobs.push(supabase.from('Leady B2C').select(cols).in('Phone number', nums).limit(10).then(({ data }) => add(data)));
        }
      }
      await Promise.allSettled(jobs);
      res.json({ data: [...out.values()].slice(0, 12) });
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
        supabase.from('wyceny').select('id,typ,created_at,kwota_sprzedazy_brutto,kwota_proponowana_brutto,rabat24h_kwota,paid'),
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
      const kwota = (r) => num(cenaFinalna(r));
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
      const [withWatch] = await attachWatches(supabase, [decorate(data[0])]);
      res.json({
        data: {
          ...withWatch,
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
      // Wycena podpięta pod leada przejmuje jego ownera (decyzja Antoniego
      // 2026-07-12: jeden właściciel tematu — kontaktujemy się z leadem, nie
      // z wyceną). Lead bez ownera / nieznaleziony -> owner z sesji jak dotąd.
      let ownerFromLead = null;
      if (patch.lead_id) {
        ownerFromLead = await fetchLeadOwner(supabase, patch.lead_id)
          .catch((err) => { console.error('Owner leada (POST wyceny):', err.message); return null; });
      }
      const { data: idData, error: idErr } = await supabase.rpc('wyceny_next_id');
      if (idErr) throw idErr;
      const id = idData;
      const crypto = require('crypto');
      const row = {
        id,
        owner: ownerFromLead || String(req.user.name || 'Antoni'),
        source: body.source === 'quick-add' ? 'quick-add' : 'panel',
        form_token: crypto.randomBytes(12).toString('base64url'),
        ...patch,
      };
      const { data, error } = await supabase.from('wyceny').insert(row).select('*');
      if (error) throw error;
      await logEvent(supabase, id, 'wycena.created', { source: row.source, user: req.user.name });
      // Odbij wycenę na powiązanym leadzie (status "Wycena wysłana" + link) —
      // jeśli dopisano lead_id po telefonie, zwrotnie uzupełnij obiekt.
      const linkedLeadId = await linkWycenaToLead(supabase, data[0]);
      if (linkedLeadId) data[0].lead_id = linkedLeadId;
      if (body.feedback_due !== undefined) {
        await applyFeedbackDue(supabase, data[0], body.feedback_due, req.user.name);
      }
      await notifyWycenaCreated(supabase, data[0], req.user.name);
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
      const hasFeedbackDue = body.feedback_due !== undefined;
      if (!Object.keys(patch).length && !hasFeedbackDue) {
        return res.status(400).json({ error: 'Brak zmian do zapisania' });
      }
      if (patch.items) await syncItemsToCennik(supabase, patch.items);
      // Przypisanie do leada = przejęcie jego ownera (jeden właściciel tematu;
      // decyzja Antoniego 2026-07-12). Jawna zmiana ownera przez admina w tym
      // samym zapisie wygrywa z automatem. Odpięcie (lead_id=null) nie rusza.
      if (patch.lead_id && patch.owner === undefined) {
        const ownerFromLead = await fetchLeadOwner(supabase, patch.lead_id)
          .catch((err) => { console.error('Owner leada (PUT wyceny):', err.message); return null; });
        if (ownerFromLead) patch.owner = ownerFromLead;
      }
      patch.updated_at = new Date().toISOString();

      const { data, error } = await scoped(supabase.from('wyceny').update(patch), req)
        .eq('id', id).select('*');
      if (error) throw error;
      if (!data || !data.length) return res.status(404).json({ error: 'Nie znaleziono wyceny' });
      await logEvent(supabase, id, 'wycena.edited', { fields: Object.keys(patch), user: req.user.name });
      if (hasFeedbackDue) {
        await applyFeedbackDue(supabase, data[0], body.feedback_due, req.user.name);
      } else if (patch.status && WYCENA_CLOSING_STATUSY.has(patch.status)) {
        // Temat zamknięty (sprzedane/stracone) — watchdog nie ma czego pilnować.
        await watchdog.resolveWatch(supabase, { objectType: 'wycena', objectId: id, resolution: 'done' })
          .catch((err) => console.error(`Watchdog: błąd gaszenia watcha wyceny ${id}:`, err.message));
      } else if (patch.lead_id) {
        await adoptWatchAfterAssign(supabase, data[0]);
      }
      // Ręczne przypięcie wyceny do leada ("Powiązany lead") odbija status
      // "Wycena wysłana" + link na leadzie, tak samo jak utworzenie wyceny.
      if (patch.lead_id) await linkWycenaToLead(supabase, data[0]);
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
      const linkedLeadId = await linkWycenaToLead(supabase, data[0]);
      if (linkedLeadId) data[0].lead_id = linkedLeadId;
      await notifyWycenaCreated(supabase, data[0], req.user.name);
      res.json({ data: decorate(data[0]), created: true });
    } catch (err) {
      handleError(res, err, 502);
    }
  });

  // ── Pipeline z panelu ─────────────────────────────────────────────────────

  // POST /api/wyceny/:id/reship — "Zamów kuriera ponownie": nowa przesyłka
  // ShipX na te same dane, BEZ faktury i bez zmiany statusów (kind 'reship').
  // Body (opcjonalne, z panelu): { codAmount: number|null, email: string|null }
  // — nadpisania parametrów paczki. Brak body => zachowanie jak dawniej
  // (bez pobrania, e-mail z zamówienia).
  app.post('/api/wyceny/:id(\\d+)/reship', requireEdit, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const supabase = getClient();
      const { data, error } = await scoped(supabase.from('wyceny').select('id'), req).eq('id', id).limit(1);
      if (error) throw error;
      if (!data || !data.length) return res.status(404).json({ error: 'Nie znaleziono wyceny' });
      const body = req.body || {};
      let codAmount = null;
      if (body.codAmount != null && body.codAmount !== '') {
        codAmount = Number(String(body.codAmount).replace(',', '.'));
        if (!Number.isFinite(codAmount) || codAmount <= 0) {
          return res.status(400).json({ error: 'Kwota pobrania musi być liczbą > 0' });
        }
      }
      const overrides = { codAmount, email: body.email ? String(body.email).trim() : null };
      const { reship } = require('./wyceny-pipeline');
      const shipment = await reship(supabase, id, overrides);
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
      await watchdog.resolveWatch(supabase, { objectType: 'wycena', objectId: id, resolution: 'done' })
        .catch((err) => console.error(`Watchdog: błąd gaszenia watcha wyceny ${id}:`, err.message));
      const { startPipeline } = require('./wyceny-pipeline');
      const result = await startPipeline(supabase, id);
      res.json({ ok: true, ...result });
    } catch (err) {
      handleError(res, err, 502);
    }
  });

  // POST /api/wyceny/:id/oznacz-oplacone — przelew wpłynął (poza inFakt): oznacz
  // opłacone + utwórz przesyłkę (markPaidAndShip, jak automatyczna płatność) →
  // zamówienie wpada do „Do spakowania". Dostępne we WSZYSTKICH panelach z
  // wyceny-endpoints (Sprzedaże, Wyceny, Fulfillment), bo karta woła je przez
  // opts.apiBase. Sklep (Shopify) ma własny flow — odrzucamy; import dopuszczamy.
  app.post('/api/wyceny/:id(\\d+)/oznacz-oplacone', requireEdit, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const supabase = getClient();
      const { data, error } = await scoped(supabase.from('wyceny').select('*'), req).eq('id', id).limit(1);
      if (error) throw error;
      if (!data || !data.length) return res.status(404).json({ error: 'Nie znaleziono zamówienia' });
      if (data[0].source === 'shopify') {
        return res.status(400).json({ error: 'Zamówienie ze sklepu (Shopify) ma własny fulfillment — nie oznaczamy go tutaj.' });
      }
      const { markPaidAndShip } = require('./wyceny-pipeline');
      const result = await markPaidAndShip(supabase, id);
      await logEvent(supabase, id, 'invoice.paid', { manual: true, source: 'panel-oznacz-oplacone', user: req.user && req.user.name });
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
      const shipmentId = String(req.params.shipmentId);
      // Etykieta wg providera przesyłki: zagranica (Furgonetka) ma własny
      // endpoint etykiet; brak wiersza / provider shipx = InPost jak dotąd.
      const supabase = getClient();
      const { data } = await supabase.from('wyceny_shipments')
        .select('provider').eq('shipment_id', shipmentId).limit(1);
      let pdf;
      if (data && data[0] && data[0].provider === 'furgonetka') {
        const furgonetka = require('./wyceny-furgonetka');
        furgonetka.useTokenStore(furgonetka.makeSupabaseTokenStore(supabase));
        pdf = await furgonetka.downloadLabel(shipmentId);
      } else {
        const shipx = require('./wyceny-shipx');
        pdf = await shipx.downloadLabel(shipmentId);
      }
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
