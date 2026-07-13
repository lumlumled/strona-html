// ── Statystyki: wszystkie definicje metryk w JEDNYM miejscu (guardrails §1) ──
// Read-only. Źródła KANONICZNE: `wyceny` (NIE "Wyceny B2C" legacy!), "Leady B2C",
// "Log zmian". Zgodne z docs/statystyki-doradca-build-guardrails.md.
// Zweryfikowane na żywej bazie 2026-07-13: pipeline 120/270079/76d, AOV 1699.

const WYCENY = 'wyceny';
const LEADY = 'Leady B2C';
const LOG = 'Log zmian';

// Źródła w "Log zmian", które NIE są telefonami (src of truth:
// apps/shared/server/leady-endpoints.js). Telefon = wiersz spoza tego zbioru.
// facebook_lead_webhook = wpis "powstał nowy lead", nie połączenie.
const NIE_TELEFON_ZRODLA = new Set(['notatka_handlowca', 'manual_akcja', 'manual_crm', 'facebook_lead_webhook']);

// Statusy leada, które są "domknięte/martwe" — nie licz jako aktywny lejek.
const LEAD_ZAMKNIETE = new Set(['Sprzedane', 'Stracony', 'Błędne dane']);
// Etapy wczesne dla "leady nietknięte": Log zmian ma telefony dopiero od webhooka
// Zadarmy (~2026-07), więc "0 wierszy telefonicznych" na CAŁEJ bazie zawyżałoby
// (leady sprzed webhooka mają 0, choć dzwoniono). Liczymy tylko wczesny lejek
// (spec SEGMENT 2: ~93/407 = Nowy/Nie odebrał z 0 telefonami).
const LEAD_NIETKNIETE_ETAPY = new Set(['Nowy', 'Nie odebrał']);
// Lead, który dostał już wycenę (dowolna pisownia z bazy).
const LEAD_WYCENA_WYSLANA = 'Wycena wysłana';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round = (n) => Math.round(n * 100) / 100;

// Telefon → ostatnie 9 cyfr (ujednolica prefiks 48 i formatowanie). Jedyny
// łącznik leady↔wyceny (brak FK, guardrails §2.5).
function phone9(v) {
  if (v == null) return '';
  return String(v).replace(/\D/g, '').slice(-9);
}

// "DD.MM.YYYY[ HH:mm]" PRZED new Date() (guardrails §2.4 — daty w Leady B2C to TEXT).
function parseLeadDate(value) {
  if (!value) return null;
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T](\d{1,2}):(\d{2}))?/.exec(String(value).trim());
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4] || 0), Number(m[5] || 0));
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const warsawMonth = (d) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit' }).format(new Date(d));
const warsawDay = (d) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));

// Przychód zamówienia = coalesce(sprzedaz, proponowana) (guardrails §1; ratio 1.000).
const revenue = (r) => num(r.kwota_sprzedazy_brutto) > 0 ? num(r.kwota_sprzedazy_brutto) : num(r.kwota_proponowana_brutto);

// ── A. SPRZEDAŻ ──────────────────────────────────────────────────────────────
async function sprzedaz(db, { owner } = {}) {
  let q = db.from(WYCENY)
    .select('id,created_at,kwota_sprzedazy_brutto,kwota_proponowana_brutto,owner,invoice_company_nip,telefon_digits,source')
    .eq('typ', 'ZAMÓWIENIE');
  if (owner && owner !== 'all') q = q.ilike('owner', owner);
  const { data, error } = await q;
  if (error) throw error;
  const rows = data || [];

  const thisMonth = warsawMonth(new Date());
  const [ty, tm] = thisMonth.split('-').map(Number);
  const prevMonth = tm === 1 ? `${ty - 1}-12` : `${ty}-${String(tm - 1).padStart(2, '0')}`;
  const inMonth = (m) => rows.filter((r) => r.created_at && warsawMonth(r.created_at) === m);
  const sum = (arr) => round(arr.reduce((a, r) => a + revenue(r), 0));

  const ten = inMonth(thisMonth);
  const prev = inMonth(prevMonth);
  const prevSuma = sum(prev);
  // Porównanie do TEMPA miesiąca (decyzja Antoniego 2026-07-12, reuse z /api/sprzedaze/stats).
  const [py, pm] = prevMonth.split('-').map(Number);
  const daysInPrevMonth = new Date(py, pm, 0).getDate();
  const daysElapsed = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', day: 'numeric' }).format(new Date()));
  const poprzedniDoTempa = daysInPrevMonth ? round((prevSuma / daysInPrevMonth) * daysElapsed) : 0;

  const withVal = rows.filter((r) => revenue(r) > 0);
  const aov = withVal.length ? Math.round(sum(withVal) / withVal.length) : null;

  // Big-ticket mix (guardrails: 56% przychodu z ~22% zamówień) — udział WARTOŚCI.
  const totalVal = sum(rows) || 1;
  const valGe = (prog) => round(rows.filter((r) => revenue(r) >= prog).reduce((a, r) => a + revenue(r), 0) / totalVal);

  // B2B = invoice_company_nip niepuste (guardrails §2.7).
  const b2b = rows.filter((r) => r.invoice_company_nip && String(r.invoice_company_nip).trim());
  const b2bSum = sum(b2b);

  // Powroty = grupowanie zamówień po telefon_digits, count>1 (guardrails §2.7).
  const byPhone = new Map();
  rows.forEach((r) => { const p = phone9(r.telefon_digits); if (p) byPhone.set(p, (byPhone.get(p) || 0) + 1); });
  const powracajacy = [...byPhone.values()].filter((c) => c > 1).length;
  const klienciUnikalni = byPhone.size;

  return {
    total: { count: rows.length, suma: sum(rows) },
    tenMiesiac: { count: ten.length, suma: sum(ten) },
    poprzedniMiesiac: { count: prev.length, suma: prevSuma },
    tempo: { daysElapsed, daysInPrevMonth, poprzedniDoTempa },
    aov,
    big_ticket: { pct_wartosci_ge_2k: valGe(2000), pct_wartosci_ge_5k: valGe(5000) },
    b2b: { count: b2b.length, pct_zamowien: rows.length ? round(b2b.length / rows.length) : 0, aov: b2b.length ? Math.round(b2bSum / b2b.length) : null },
    powroty: { klienci_powracajacy: powracajacy, klienci_unikalni: klienciUnikalni, pct: klienciUnikalni ? round(powracajacy / klienciUnikalni) : 0 },
  };
}

// ── B. PIPELINE / WYCENY OTWARTE ─────────────────────────────────────────────
async function pipeline(db, { olderThanDays = 0, minKwota = 0, owner, limit = 10 } = {}) {
  let q = db.from(WYCENY)
    .select('id,kwota_proponowana_brutto,created_at,owner,telefon_e164,telefon_digits,imie_nazwisko,first_name,last_name,lead_id')
    .eq('typ', 'WYCENA').eq('status', 'Open'); // Waiting for payment = ZAMÓWIENIA, nie wyceny (guardrails)
  if (owner && owner !== 'all') q = q.ilike('owner', owner);
  const { data, error } = await q;
  if (error) throw error;
  const rows = data || [];
  const now = Date.now();
  const wiek = (r) => r.created_at ? Math.floor((now - new Date(r.created_at).getTime()) / 86400000) : null;

  const suma = round(rows.reduce((a, r) => a + num(r.kwota_proponowana_brutto), 0));
  const wieki = rows.map(wiek).filter((n) => n != null);
  const sredniWiek = wieki.length ? Math.round(wieki.reduce((a, b) => a + b, 0) / wieki.length) : null;

  const nazwa = (r) => r.imie_nazwisko || [r.first_name, r.last_name].filter(Boolean).join(' ') || null;
  const top = rows
    .filter((r) => (wiek(r) ?? 0) >= olderThanDays && num(r.kwota_proponowana_brutto) >= minKwota)
    .sort((a, b) => num(b.kwota_proponowana_brutto) - num(a.kwota_proponowana_brutto))
    .slice(0, limit)
    .map((r) => ({ id: r.id, kwota: num(r.kwota_proponowana_brutto), telefon: r.telefon_e164 || r.telefon_digits || null, imie: nazwa(r), wiek_dni: wiek(r), owner: r.owner || null }));

  return { count: rows.length, suma, sredni_wiek_dni: sredniWiek, top_do_dzwonienia: top };
}

// ── Wspólny fetch danych outreach (Log zmian + Leady + otwarte wyceny) ──
// Otwarte wyceny są potrzebne do "martwe_wyceny_tkniete_7d" (match po telefonie).
async function fetchOutreachRaw(db) {
  const [logRes, leadyRes, wycenyRes] = await Promise.all([
    db.from(LOG).select('telefon,data_zmiany,zrodlo,disposition,kierunek,status_po,handlowiec'),
    db.from(LEADY).select('"Phone number","Deal stage","Owner"'),
    db.from(WYCENY).select('id,created_at,telefon_digits,telefon_e164').eq('typ', 'WYCENA').eq('status', 'Open'),
  ]);
  if (logRes.error) throw logRes.error;
  if (leadyRes.error) throw leadyRes.error;
  if (wycenyRes.error) throw wycenyRes.error;
  return { log: logRes.data || [], leady: leadyRes.data || [], wyceny: wycenyRes.data || [] };
}

// ── C. OUTREACH / TELEFONY ───────────────────────────────────────────────────
function outreachCompute({ log, leady, wyceny = [] }, { from, to, handlowiec } = {}) {
  // Telefony = wiersze spoza NIE_TELEFON_ZRODLA (guardrails §2.2 — NIE z "Ilość telefonów").
  const telRows = log.filter((r) => !NIE_TELEFON_ZRODLA.has(r.zrodlo) && phone9(r.telefon));
  // Wolumen/dodzwonienia mogą być filtrowane per handlowiec; "nietknięte" i
  // "martwe tknięte" liczymy firmowo (z telRows), niezależnie od filtra.
  let calls = telRows;
  if (handlowiec && handlowiec !== 'all') calls = calls.filter((r) => (r.handlowiec || '') === handlowiec);

  const todayKey = warsawDay(new Date());
  const inWin = (d) => {
    if (!d) return false;
    const t = new Date(d).getTime();
    if (from && t < new Date(from).getTime()) return false;
    if (to && t > new Date(to).getTime()) return false;
    return true;
  };
  const weekAgo = Date.now() - 7 * 86400000;

  const dzis = calls.filter((r) => warsawDay(r.data_zmiany) === todayKey);
  const tydzien = calls.filter((r) => r.data_zmiany && new Date(r.data_zmiany).getTime() >= weekAgo);
  const okno = (from || to) ? calls.filter((r) => inWin(r.data_zmiany)) : tydzien;

  const answered = okno.filter((r) => r.disposition === 'answered').length;
  const noAns = okno.filter((r) => r.disposition === 'no_answer').length;
  const pctDodzwonien = (answered + noAns) ? round(answered / (answered + noAns)) : null;

  // Kadencja: liczba prób per telefon (całość historii), rozkład.
  const perPhone = new Map();
  calls.forEach((r) => { const p = phone9(r.telefon); perPhone.set(p, (perPhone.get(p) || 0) + 1); });

  // Leady wg Deal stage (STABILNE — NIE z krótkiego okna Log zmian, które ma
  // ~3 dni telefonów; guardrails §2.2). "Nowy" = jeszcze nietknięte,
  // "Nie odebrał" = dzwoniono bez kontaktu (znany przeciek: ~93/407).
  const leadyNowe = leady.filter((l) => l['Deal stage'] === 'Nowy').length;
  const leadyNieOdebral = leady.filter((l) => l['Deal stage'] === 'Nie odebrał').length;

  // Telefony FIRMOWO po telefonie (cała historia + ostatnie 7 dni) — do
  // "nietknięte" i "martwe tknięte". Zawsze z telRows (nie filtr handlowca).
  const now = Date.now();
  const week = now - 7 * 86400000;
  const callPhones = new Set();     // telefon dostał kiedykolwiek połączenie
  const callPhones7d = new Set();   // ...w ostatnich 7 dniach
  telRows.forEach((r) => {
    const p = phone9(r.telefon);
    callPhones.add(p);
    if (r.data_zmiany && new Date(r.data_zmiany).getTime() >= week) callPhones7d.add(p);
  });

  // Leady nietknięte (guardrails §4, spec SEGMENT 2): lead wczesnego lejka
  // (Nowy/Nie odebrał) z telefonem, który NIE ma ani jednego wiersza
  // telefonicznego w Log zmian. Ograniczone do wczesnych etapów, bo krótkie
  // okno Log zmian zawyżałoby liczbę na całej bazie (patrz LEAD_NIETKNIETE_ETAPY).
  const leadyNietkniete = leady.filter((l) => {
    if (!LEAD_NIETKNIETE_ETAPY.has(l['Deal stage'])) return false;
    const p = phone9(l['Phone number']);
    return p && !callPhones.has(p);
  }).length;

  // Martwe wyceny tknięte w 7 dni: otwarta wycena starsza niż 14 dni, której
  // telefon dostał połączenie w ostatnich 7 dniach (dowód pracy po pipeline 270k).
  const DEAD_AGE_MS = 14 * 86400000;
  const martweWycenyTkniete7d = wyceny.filter((w) => {
    if (!w.created_at || (now - new Date(w.created_at).getTime()) <= DEAD_AGE_MS) return false;
    const p = phone9(w.telefon_digits || w.telefon_e164);
    return p && callPhones7d.has(p);
  }).length;

  // Speed-to-lead: event 'Nowy' → 1. telefon wychodzący. Log zmian ma krótkie
  // okno (webhook Zadarmy od 2026-07) → często za mało punktów; null gdy n<5.
  const stl = speedToLead(log);

  return {
    telefony_dzis: dzis.length,
    telefony_tydzien: tydzien.length,
    telefony_okno: okno.length,
    kierunek: { wychodzace: okno.filter((r) => r.kierunek === 'wychodzące').length, przychodzace: okno.filter((r) => r.kierunek === 'przychodzące').length },
    pct_dodzwonien: pctDodzwonien,
    speed_to_lead_med_min: stl.n >= 5 ? stl.median_min : null,
    speed_to_lead_n: stl.n,
    leady_nowe: leadyNowe,
    leady_nie_odebral: leadyNieOdebral,
    leady_nietkniete: leadyNietkniete,
    martwe_wyceny_tkniete_7d: martweWycenyTkniete7d,
    kadencja_wsrod_dzwonionych: cadenceBuckets(perPhone),
  };
}

function cadenceBuckets(perPhone) {
  const b = { '0': 0, '1-2': 0, '3-5': 0, '6+': 0 };
  perPhone.forEach((c) => {
    if (c === 0) b['0'] += 1; else if (c <= 2) b['1-2'] += 1; else if (c <= 5) b['3-5'] += 1; else b['6+'] += 1;
  });
  return b;
}

function speedToLead(log) {
  const created = new Map(); // phone → min ts eventu 'Nowy'
  const firstOut = new Map(); // phone → min ts telefonu wychodzącego
  log.forEach((r) => {
    const p = phone9(r.telefon); if (!p || !r.data_zmiany) return;
    const t = new Date(r.data_zmiany).getTime();
    if (r.status_po === 'Nowy') created.set(p, Math.min(created.get(p) ?? Infinity, t));
    if (r.kierunek === 'wychodzące' && !NIE_TELEFON_ZRODLA.has(r.zrodlo)) firstOut.set(p, Math.min(firstOut.get(p) ?? Infinity, t));
  });
  const diffs = [];
  created.forEach((tc, p) => { const tf = firstOut.get(p); if (tf && tf >= tc) diffs.push((tf - tc) / 60000); });
  if (!diffs.length) return { median_min: null, n: 0 };
  diffs.sort((a, b) => a - b);
  const mid = Math.floor(diffs.length / 2);
  const median = diffs.length % 2 ? diffs[mid] : (diffs[mid - 1] + diffs[mid]) / 2;
  return { median_min: Math.round(median), n: diffs.length };
}

async function outreach(db, params = {}) {
  const raw = await fetchOutreachRaw(db);
  return outreachCompute(raw, params);
}

// ── D. LEADY / LEJEK ─────────────────────────────────────────────────────────
async function leady(db) {
  const { data, error } = await db.from(LEADY).select('"Deal stage","Owner",ad_name');
  if (error) throw error;
  const rows = data || [];
  const lejek = {};
  rows.forEach((r) => { const s = r['Deal stage'] || 'Brak'; lejek[s] = (lejek[s] || 0) + 1; });

  // Źródło: marketing_meta jest NULL w całej bazie → sygnał paid to obecność
  // `ad_name` (lead z reklamy). Brak ad_name = organik/bezpośredni.
  let zReklamy = 0, bezReklamy = 0;
  rows.forEach((r) => { if (r.ad_name && String(r.ad_name).trim()) zReklamy += 1; else bezReklamy += 1; });

  return { total: rows.length, lejek, zrodlo: { z_reklamy: zReklamy, bez_reklamy: bezReklamy } };
}

// ── Close rate FORWARD (uczciwy, kohortowy) ──────────────────────────────────
// Klucz ISTNIEJE: konwersja to ten sam id przeskakujący WYCENA→ZAMÓWIENIE
// (kod: wyceny-endpoints.js:759). Liczymy TYLKO wyceny zrobione w panelu
// (source ≠ import/shopify). Historia (import ze starego systemu) to dwa
// NIEPOWIĄZANE worki — 252 zamówienia + 126 wycen zaciągnięte osobno, bez
// zapisanego linku wycena→zamówienie; liczenie po niej dałoby fałszywe ~66%.
async function closeRate(db) {
  const { data, error } = await db.from(WYCENY)
    .select('id,typ,status,source,created_at,telefon_digits').neq('typ', 'NOTATKA');
  if (error) throw error;
  const rows = data || [];
  const HISTORIA = new Set(['import', 'shopify']); // stary system + self-serve = nie wyceny z panelu

  // Wszystkie ZAMÓWIENIA (DOWOLNE źródło, też shopify/import) → telefon: kiedy kupił.
  // Drugi sygnał domknięcia: wycena z panelu, której telefon kupił innym kanałem
  // (np. wystawiona w panelu, opłacona w sklepie) w oknie 30 dni.
  const orderTsByPhone = new Map();
  rows.forEach((r) => {
    if (r.typ !== 'ZAMÓWIENIE') return;
    const p = phone9(r.telefon_digits); if (!p || !r.created_at) return;
    const arr = orderTsByPhone.get(p) || [];
    arr.push(new Date(r.created_at).getTime());
    orderTsByPhone.set(p, arr);
  });
  const WINDOW_MS = 30 * 86400000;
  const kupilInnymKanalem = (w) => {
    const p = phone9(w.telefon_digits); if (!p || !w.created_at) return false;
    const t = new Date(w.created_at).getTime();
    const arr = orderTsByPhone.get(p); if (!arr) return false;
    return arr.some((ot) => ot >= t && ot <= t + WINDOW_MS);
  };

  const cohort = rows.filter((r) => !HISTORIA.has(r.source));
  // (1) twardy klucz: ten sam id po konwersji jest już ZAMÓWIENIEM.
  const domknieteSameId = cohort.filter((r) => r.typ === 'ZAMÓWIENIE').length;
  // (2) phone-match: wycena wciąż typ=WYCENA, ale ten telefon kupił w 30 dni.
  // Zbiory rozłączne (WYCENA vs ZAMÓWIENIE) → brak podwójnego liczenia.
  const wycenaRows = cohort.filter((r) => r.typ === 'WYCENA');
  const wonByPhone = new Set(wycenaRows.filter(kupilInnymKanalem).map((r) => r.id));
  const domkniete = domknieteSameId + wonByPhone.size;

  // Przegrane = jawnie 'Stracone', ale NIE te, które i tak kupiły (phone-match).
  const stracone = wycenaRows.filter((r) => r.status === 'Stracone' && !wonByPhone.has(r.id)).length;
  const otwarte = wycenaRows.filter((r) => r.status === 'Open' && !wonByPhone.has(r.id)).length;
  // Dojrzewające = otwarte młodsze niż 30 dni (okno konwersji jeszcze trwa) — info, poza mianownikiem.
  const now = Date.now();
  const dojrzewajace = wycenaRows.filter((r) => r.status === 'Open' && !wonByPhone.has(r.id)
    && r.created_at && (now - new Date(r.created_at).getTime()) < WINDOW_MS).length;

  const rozstrzygniete = domkniete + stracone;
  const MIN_PROBA = 15;
  const gotowe = rozstrzygniete >= MIN_PROBA;
  return {
    metoda: 'forward kohortowy: ten sam id WYCENA→ZAMÓWIENIE (twardy klucz) + phone-match ZAMÓWIENIA w 30 dni (inny kanał, np. Shopify)',
    wyceny_w_panelu: cohort.length,
    domkniete,
    domkniete_ten_sam_id: domknieteSameId,
    domkniete_inny_kanal: wonByPhone.size,
    stracone,
    otwarte,
    dojrzewajace,
    close_rate: gotowe ? round(domkniete / rozstrzygniete) : null,
    status: gotowe ? 'ok' : `buduje się — za mało rozstrzygniętych wycen (${rozstrzygniete}/${MIN_PROBA})`,
    _uwaga: 'Liczony TYLKO z wycen z panelu (source ≠ import/shopify). Domknięta = ten sam id stał się ZAMÓWIENIEM LUB ten telefon ma ZAMÓWIENIE (dowolny kanał) w 30 dni od wyceny. Mianownik = domknięte + jawnie Stracone; otwarte (w tym „dojrzewające" <30 dni) poza mianownikiem. Historia (import) nieodtwarzalna.',
  };
}

// ── G. SNAPSHOT (rollup dla AI-doradcy) ──────────────────────────────────────
// owner (opcjonalnie): scoping widoku per handlowiec (Kokpit dla nie-admina).
// Bez owner = firmowo (doradca, endpoint maszynowy). Uwaga: owner w `wyceny` to
// artefakt migracji (guardrails §2.3) — to scoping WIDOKU, nie raport wyników.
async function snapshot(db, { owner } = {}) {
  const [sp, pipe, out, ld, cr] = await Promise.all([
    sprzedaz(db, { owner }), pipeline(db, { limit: 10, owner }), outreach(db, { handlowiec: owner }), leady(db), closeRate(db),
  ]);

  const alerty = [];
  if (pipe.suma > 100000) alerty.push(`${pipe.suma.toLocaleString('pl-PL')} zł leży w ${pipe.count} otwartych wycenach (śr. wiek ${pipe.sredni_wiek_dni} dni).`);
  if (pipe.count > 0 && out.martwe_wyceny_tkniete_7d === 0) alerty.push('Żadna otwarta wycena >14 dni nie dostała telefonu w ostatnie 7 dni — nikt nie odgrzewa pipeline’u.');
  if (out.leady_nietkniete > 0) alerty.push(`${out.leady_nietkniete} leadów wczesnego lejka (Nowy/Nie odebrał) bez zarejestrowanego telefonu — do przedzwonienia.`);
  if (out.leady_nie_odebral > 0) alerty.push(`${out.leady_nie_odebral} leadów w statusie „Nie odebrał" — nigdy nie dobrzwonione.`);
  if (out.leady_nowe > 0) alerty.push(`${out.leady_nowe} nowych leadów czeka na pierwszy kontakt.`);
  if (out.telefony_dzis === 0) alerty.push('Dziś zero wykonanych telefonów.');

  return {
    _status: 'ready',
    generated_at: new Date().toISOString(),
    sprzedaz: {
      przychod_mies: sp.tenMiesiac, delta_do_tempa: round(sp.tenMiesiac.suma - sp.tempo.poprzedniDoTempa),
      aov: sp.aov,
      close_rate: cr.close_rate, // forward (wyceny z panelu); null dopóki próbka mała
      close_rate_status: cr.status,
      close_rate_wyceny_w_panelu: cr.wyceny_w_panelu,
      b2b_pct: sp.b2b.pct_zamowien, powroty_pct: sp.powroty.pct,
    },
    pipeline_otwarty: { count: pipe.count, suma: pipe.suma, sredni_wiek_dni: pipe.sredni_wiek_dni, top_do_dzwonienia: pipe.top_do_dzwonienia },
    outreach: {
      telefony_dzis: out.telefony_dzis, telefony_tydzien: out.telefony_tydzien,
      pct_dodzwonien: out.pct_dodzwonien, speed_to_lead_med_min: out.speed_to_lead_med_min,
      leady_nowe: out.leady_nowe, leady_nie_odebral: out.leady_nie_odebral,
      leady_nietkniete: out.leady_nietkniete, martwe_wyceny_tkniete_7d: out.martwe_wyceny_tkniete_7d,
    },
    leady: { lejek: ld.lejek, zrodlo: ld.zrodlo },
    alerty,
  };
}

// ── F. ORGANIK (marketing organiczny: FB + IG + TikTok) ──────────────────────
// Źródło: marketing_organic_daily (FB+TikTok dzienne) + marketing_organic_posts
// (IG+TikTok per-post). Rok z eksportów Meta/TikTok. migracja 006.
async function organik(db) {
  const [dRes, pRes] = await Promise.all([
    db.from('marketing_organic_daily').select('platform,date,metrics'),
    db.from('marketing_organic_posts').select('platform,post_id,title,url,published_at,views,likes,comments,shares,saves'),
  ]);
  if (dRes.error) throw dRes.error;
  if (pRes.error) throw pRes.error;
  const daily = dRes.data || [];
  const posts = pRes.data || [];
  const sumM = (rows, key) => rows.reduce((a, r) => a + (Number(r.metrics && r.metrics[key]) || 0), 0);
  const fbD = daily.filter((r) => r.platform === 'facebook');
  const ttD = daily.filter((r) => r.platform === 'tiktok');
  const igP = posts.filter((r) => r.platform === 'instagram');
  const ttP = posts.filter((r) => r.platform === 'tiktok');
  const sumP = (rows, key) => rows.reduce((a, r) => a + (Number(r[key]) || 0), 0);

  // Sumy per platforma (FB z daily; IG z postów; TikTok z daily + liczba filmów z postów)
  const platformy = {
    facebook: { wyswietlenia: sumM(fbD, 'views'), interakcje: sumM(fbD, 'interactions'), nowi_obserwatorzy: sumM(fbD, 'new_followers'), klikniecia_link: sumM(fbD, 'link_clicks'), postow: null },
    instagram: { wyswietlenia: sumP(igP, 'views'), polubienia: sumP(igP, 'likes'), udostepnienia: sumP(igP, 'shares'), zapisania: sumP(igP, 'saves'), komentarze: sumP(igP, 'comments'), postow: igP.length },
    tiktok: { wyswietlenia: sumM(ttD, 'views'), polubienia: sumM(ttD, 'likes'), udostepnienia: sumM(ttD, 'shares'), nowi_obserwatorzy: sumM(ttD, 'new_followers'), leady: sumM(ttD, 'leads'), klikniecia_strona: sumM(ttD, 'website_clicks'), filmow: ttP.length },
  };
  const razem_wyswietlenia = platformy.facebook.wyswietlenia + platformy.instagram.wyswietlenia + platformy.tiktok.wyswietlenia;

  // Miesięczny szereg wyświetleń per platforma (FB+TikTok z daily po dacie; IG z postów po dacie publikacji).
  const months = new Map(); // 'YYYY-MM' → {facebook, instagram, tiktok}
  const bump = (ym, plat, v) => { if (!ym) return; const m = months.get(ym) || { facebook: 0, instagram: 0, tiktok: 0 }; m[plat] += v || 0; months.set(ym, m); };
  fbD.forEach((r) => bump(String(r.date).slice(0, 7), 'facebook', Number(r.metrics && r.metrics.views) || 0));
  ttD.forEach((r) => bump(String(r.date).slice(0, 7), 'tiktok', Number(r.metrics && r.metrics.views) || 0));
  igP.forEach((r) => bump(r.published_at ? String(r.published_at).slice(0, 7) : null, 'instagram', Number(r.views) || 0));
  const szereg = [...months.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, m]) => ({ month, ...m }));

  // Top posty (IG + TikTok) po wyświetleniach.
  const top_posty = [...igP, ...ttP]
    .sort((a, b) => (Number(b.views) || 0) - (Number(a.views) || 0))
    .slice(0, 12)
    .map((r) => ({ platform: r.platform, title: r.title, url: r.url, views: Number(r.views) || 0, likes: Number(r.likes) || 0, published_at: r.published_at }));

  const daty = daily.map((r) => r.date).filter(Boolean).sort();
  return {
    zakres: { od: daty[0] || null, do: daty[daty.length - 1] || null },
    razem_wyswietlenia,
    platformy,
    szereg_miesieczny: szereg,
    top_posty,
  };
}

module.exports = { sprzedaz, pipeline, outreach, leady, closeRate, snapshot, organik };
