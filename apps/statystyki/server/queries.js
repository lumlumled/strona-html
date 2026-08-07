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
// manual_stracony / wycena_stracona = ręczne domknięcie tematu z powodem
// (i jego odbicie od strony wyceny) — decyzja handlowca, nie rozmowa.
const NIE_TELEFON_ZRODLA = new Set(['notatka_handlowca', 'manual_akcja', 'manual_crm', 'manual_stracony', 'wycena_stracona', 'wycena_sprzedana', 'sms_stracony', 'facebook_lead_webhook']);

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

// ── Zegar biznesowy 9:00–21:00 Europe/Warsaw (decyzja Antoniego 2026-07-13) ──
// Speed-to-lead liczy TYLKO minuty w oknie 9–21: lead z nocy startuje o 9:00.
const BIZ_START_MIN = 9 * 60;
const BIZ_END_MIN = 21 * 60;
const WARSAW_WALL = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
// Ściana zegara w Warszawie: 'YYYY-MM-DD' + minuta dnia.
function warsawWall(ts) {
  const s = WARSAW_WALL.format(ts); // 'YYYY-MM-DD HH:mm'
  return { day: s.slice(0, 10), min: Number(s.slice(11, 13)) * 60 + Number(s.slice(14, 16)) };
}
// UTC (ms) danej ściany zegara warszawskiego. Dwie iteracje domykają offset
// (CET/CEST); wystarcza, bo offsety to pełne godziny.
function utcAtWarsaw(dayKey, minOfDay) {
  const [y, m, d] = dayKey.split('-').map(Number);
  let guess = Date.UTC(y, m - 1, d, Math.floor(minOfDay / 60), minOfDay % 60);
  for (let i = 0; i < 2; i++) {
    const w = warsawWall(guess);
    const wallAsUtc = Date.UTC(...w.day.split('-').map((v, j) => (j === 1 ? Number(v) - 1 : Number(v))), 0, w.min);
    const targetAsUtc = Date.UTC(y, m - 1, d, 0, minOfDay);
    guess += targetAsUtc - wallAsUtc;
  }
  return guess;
}
// Minuty biznesowe (9–21 Warszawa) między dwoma timestampami. Cap 62 dni —
// powyżej i tak raportujemy "dni", nie minuty.
function bizMinutes(t0, t1) {
  if (!(t1 > t0)) return 0;
  let total = 0;
  let dayKey = warsawWall(t0).day;
  for (let i = 0; i < 62; i++) {
    const winStart = utcAtWarsaw(dayKey, BIZ_START_MIN);
    const winEnd = utcAtWarsaw(dayKey, BIZ_END_MIN);
    total += Math.max(0, Math.min(t1, winEnd) - Math.max(t0, winStart));
    const next = utcAtWarsaw(dayKey, 24 * 60 + 60); // 01:00 następnego dnia (odporne na DST)
    dayKey = warsawWall(next).day;
    if (winStart > t1) break;
  }
  return Math.round(total / 60000);
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Okno czasu z API: okres '1d'|'3d'|'7d'|'30d'|'90d' ALBO from/to (ISO; `to`
// date-only = koniec dnia). Brak = null (całość).
function resolveWindow({ okres, from, to } = {}) {
  if (from || to) {
    const f = from ? new Date(from).getTime() : null;
    let t = to ? new Date(to).getTime() : null;
    if (t != null && /^\d{4}-\d{2}-\d{2}$/.test(String(to).trim())) t += 86400000 - 1;
    return { fromTs: Number.isFinite(f) ? f : null, toTs: Number.isFinite(t) ? t : null };
  }
  const days = { '1d': 1, '3d': 3, '7d': 7, '30d': 30, '90d': 90 }[okres];
  if (!days) return { fromTs: null, toTs: null };
  return { fromTs: Date.now() - days * 86400000, toTs: null };
}
const inWindow = (ts, { fromTs, toTs }) => ts != null
  && (fromTs == null || ts >= fromTs) && (toTs == null || ts <= toTs);

// Hook z ad_name (konwencja Mety w bazie: "Robi wrażenie [FB] B2C - Nowi - …" —
// człon przed pierwszym " - " to kreacja; [FB]/[IG] to platforma).
function parseHook(adName) {
  const first = String(adName || '').split(' - ')[0].trim();
  const m = /\[(FB|IG)\]/i.exec(first);
  return {
    hook: first.replace(/\s*\[(FB|IG)\]\s*/i, ' ').replace(/\s+/g, ' ').trim() || '(bez nazwy)',
    platforma: m ? m[1].toUpperCase() : null,
  };
}

// Przychód zamówienia = "cena, którą klient realnie płaci": kwota sprzedaży,
// jeśli zapisana, inaczej proponowana − rabat czasowy (jedno źródło prawdy:
// wyceny-cena.js). Wymaga rabat24h_kwota w selectach karmiących revenue().
const { cenaFinalna } = require('../../shared/server/wyceny-cena');
const revenue = (r) => num(cenaFinalna(r));

// ── A. SPRZEDAŻ ──────────────────────────────────────────────────────────────
async function sprzedaz(db, params = {}) {
  const { owner } = params;
  let q = db.from(WYCENY)
    .select('id,created_at,kwota_sprzedazy_brutto,kwota_proponowana_brutto,rabat24h_kwota,owner,invoice_company_nip,telefon_digits,source')
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

  // Okno czasu z selektora panelu (okres/from/to) — count/suma/AOV w oknie.
  const win = resolveWindow(params);
  let okno = null;
  if (win.fromTs != null || win.toTs != null) {
    const w = rows.filter((r) => r.created_at && inWindow(new Date(r.created_at).getTime(), win));
    const wVal = w.filter((r) => revenue(r) > 0);
    okno = { count: w.length, suma: sum(w), aov: wVal.length ? Math.round(sum(wVal) / wVal.length) : null };
  }

  return {
    total: { count: rows.length, suma: sum(rows) },
    tenMiesiac: { count: ten.length, suma: sum(ten) },
    poprzedniMiesiac: { count: prev.length, suma: prevSuma },
    okno,
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
    db.from(LOG).select('telefon,data_zmiany,zrodlo,disposition,kierunek,status_przed,status_po,handlowiec,czas_trwania_s'),
    db.from(LEADY).select('"Phone number","Deal stage","Owner"'),
    db.from(WYCENY).select('id,created_at,telefon_digits,telefon_e164,kwota_proponowana_brutto').eq('typ', 'WYCENA').eq('status', 'Open'),
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

  // Średni/mediana czasu rozmowy (odebrane, >0 s) — czas_trwania_s pisze webhook
  // Zadarmy (apps/backlog-b2c/server/server.js) i zadarma-poll.
  const rozmowy = okno.filter((r) => r.disposition === 'answered' && num(r.czas_trwania_s) > 0)
    .map((r) => num(r.czas_trwania_s));
  const czasRozmowy = {
    n: rozmowy.length,
    sredni_s: rozmowy.length ? Math.round(rozmowy.reduce((a, b) => a + b, 0) / rozmowy.length) : null,
    mediana_s: rozmowy.length ? Math.round(median(rozmowy)) : null,
  };

  // MINA: wiersze zadarma_poll mają data_zmiany = czas INSERTU (nocny backfill),
  // nie czas połączenia, i nie mają kierunek/handlowiec. Do metryk zależnych od
  // GODZINY/autora bierzemy tylko wiersze z `kierunek` (webhook = realny czas).
  const telRowsCzasowe = telRows.filter((r) => r.kierunek);

  // Telefony per handlowiec w oknie (webhookowe; bez filtra handlowca — porównanie).
  const oknoAll = (from || to)
    ? telRowsCzasowe.filter((r) => inWin(r.data_zmiany))
    : telRowsCzasowe.filter((r) => r.data_zmiany && new Date(r.data_zmiany).getTime() >= weekAgo);
  const perHandlowiec = {};
  oknoAll.forEach((r) => {
    const h = (r.handlowiec || '').trim() || 'nieznany';
    perHandlowiec[h] = perHandlowiec[h] || { proby: 0, odebrane: 0 };
    perHandlowiec[h].proby += 1;
    if (r.disposition === 'answered') perHandlowiec[h].odebrane += 1;
  });

  // Profil godzinowy dodzwanialności (pasma 2h, 9–21 Warszawa) — CAŁA historia
  // telefonów webhookowych (profil, nie wolumen okna); poza 9–21 → 'inne'.
  const BANDS = [[9, 11], [11, 13], [13, 15], [15, 17], [17, 19], [19, 21]];
  const godziny = BANDS.map(([a, b]) => ({ label: `${a}–${b}`, proby: 0, odebrane: 0 }));
  const inne = { label: 'poza 9–21', proby: 0, odebrane: 0 };
  telRowsCzasowe.forEach((r) => {
    if (!r.data_zmiany) return;
    const h = warsawWall(new Date(r.data_zmiany).getTime()).min / 60;
    const band = BANDS.findIndex(([a, b]) => h >= a && h < b);
    const slot = band >= 0 ? godziny[band] : inne;
    slot.proby += 1;
    if (r.disposition === 'answered') slot.odebrane += 1;
  });
  const godzinyDodzwonien = [...godziny, inne].map((g) => ({ ...g, pct: g.proby ? round(g.odebrane / g.proby) : null }));

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

  // Martwe wyceny: otwarta wycena starsza niż 14 dni. Tknięta = jej telefon
  // dostał połączenie w ostatnich 7 dniach (dowód pracy po pipeline 270k);
  // NIEodgrzana = bez telefonu w 7 dni (licznik + suma kwot → cena zaniedbania).
  const DEAD_AGE_MS = 14 * 86400000;
  const martwe = wyceny.filter((w) => w.created_at && (now - new Date(w.created_at).getTime()) > DEAD_AGE_MS);
  const tknieta = (w) => { const p = phone9(w.telefon_digits || w.telefon_e164); return p && callPhones7d.has(p); };
  const martweWycenyTkniete7d = martwe.filter(tknieta).length;
  const nieodgrzane = martwe.filter((w) => !tknieta(w));
  const martweNieodgrzane = {
    count: nieodgrzane.length,
    suma: round(nieodgrzane.reduce((a, w) => a + num(w.kwota_proponowana_brutto), 0)),
  };

  // Poprzedni pełny tydzień (7–14 dni temu) — delta dla "trzech liczb wejściowych".
  const twoWeeks = now - 14 * 86400000;
  const telefonyPoprzedniTydzien = calls.filter((r) => {
    if (!r.data_zmiany) return false;
    const t = new Date(r.data_zmiany).getTime();
    return t >= twoWeeks && t < week;
  }).length;

  // Speed-to-lead BIZNESOWY (9–21): event 'Nowy' → 1. telefon wychodzący,
  // liczony w minutach zegara 9–21 (lead z nocy startuje o 9:00 — decyzja
  // Antoniego 2026-07-13). Log zmian ma krótkie okno (webhook Zadarmy od
  // 2026-07) → często za mało punktów; null gdy n<5.
  const stl = speedToLead(log);

  // Nowy → pierwszy ruch statusu (mediana h, zegar ścienny) — jak szybko lead
  // w ogóle rusza z miejsca. Ten sam krótki horyzont Log zmian co wyżej.
  const ruch = nowyDoRuchu(log);

  return {
    telefony_dzis: dzis.length,
    telefony_tydzien: tydzien.length,
    telefony_poprzedni_tydzien: telefonyPoprzedniTydzien,
    telefony_okno: okno.length,
    kierunek: { wychodzace: okno.filter((r) => r.kierunek === 'wychodzące').length, przychodzace: okno.filter((r) => r.kierunek === 'przychodzące').length },
    pct_dodzwonien: pctDodzwonien,
    czas_rozmowy: czasRozmowy,
    telefony_per_handlowiec: perHandlowiec,
    godziny_dodzwonien: godzinyDodzwonien,
    speed_to_lead_med_min: stl.n >= 5 ? stl.median_min : null,
    speed_to_lead_n: stl.n,
    nowy_do_ruchu_med_h: ruch.n >= 5 ? ruch.median_h : null,
    nowy_do_ruchu_n: ruch.n,
    leady_nowe: leadyNowe,
    leady_nie_odebral: leadyNieOdebral,
    leady_nietkniete: leadyNietkniete,
    martwe_wyceny_tkniete_7d: martweWycenyTkniete7d,
    martwe_wyceny_nieodgrzane: martweNieodgrzane,
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

// Powstanie leada w Log zmian: webhook FB ALBO realna zmiana NA 'Nowy'.
// Echo zadarma_poll (status_przed == status_po == 'Nowy', czas insertu) NIE
// jest powstaniem leada.
const jestPowstaniem = (r) => r.zrodlo === 'facebook_lead_webhook'
  || (r.status_po === 'Nowy' && r.status_przed !== 'Nowy');

function speedToLead(log) {
  const created = new Map(); // phone → min ts powstania leada
  const firstOut = new Map(); // phone → min ts telefonu wychodzącego
  log.forEach((r) => {
    const p = phone9(r.telefon); if (!p || !r.data_zmiany) return;
    const t = new Date(r.data_zmiany).getTime();
    if (jestPowstaniem(r)) created.set(p, Math.min(created.get(p) ?? Infinity, t));
    // kierunek jest tylko na wierszach webhooka = realny czas połączenia
    if (r.kierunek === 'wychodzące' && !NIE_TELEFON_ZRODLA.has(r.zrodlo)) firstOut.set(p, Math.min(firstOut.get(p) ?? Infinity, t));
  });
  const diffs = [];
  // Minuty BIZNESOWE 9–21 (bizMinutes): lead z nocy zaczyna tykać o 9:00.
  created.forEach((tc, p) => { const tf = firstOut.get(p); if (tf && tf >= tc) diffs.push(bizMinutes(tc, tf)); });
  if (!diffs.length) return { median_min: null, n: 0 };
  return { median_min: Math.round(median(diffs)), n: diffs.length };
}

// Nowy → pierwszy ruch statusu: mediana godzin (zegar ścienny) od powstania
// leada do pierwszej zmiany statusu na inny niż 'Nowy'.
function nowyDoRuchu(log) {
  const created = new Map(); // phone → min ts powstania leada
  const firstMove = new Map(); // phone → min ts REALNEJ zmiany statusu na ≠ Nowy
  log.forEach((r) => {
    const p = phone9(r.telefon); if (!p || !r.data_zmiany) return;
    const t = new Date(r.data_zmiany).getTime();
    if (jestPowstaniem(r)) created.set(p, Math.min(created.get(p) ?? Infinity, t));
    // Ruch = status faktycznie SIĘ ZMIENIŁ (echo zadarma_poll ma przed==po).
    else if (r.status_po && r.status_po !== 'Nowy' && r.status_po !== r.status_przed) {
      firstMove.set(p, Math.min(firstMove.get(p) ?? Infinity, t));
    }
  });
  const diffs = [];
  created.forEach((tc, p) => { const tm = firstMove.get(p); if (tm && tm >= tc) diffs.push((tm - tc) / 3600000); });
  if (!diffs.length) return { median_h: null, n: 0 };
  return { median_h: Math.round(median(diffs) * 10) / 10, n: diffs.length };
}

async function outreach(db, params = {}) {
  const raw = await fetchOutreachRaw(db);
  const win = resolveWindow(params); // okres '1d/3d/7d/30d/90d' albo from/to
  return outreachCompute(raw, {
    from: win.fromTs ?? undefined,
    to: win.toTs ?? undefined,
    handlowiec: params.handlowiec,
  });
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

// ── KONWERSJE (kohorta forward, jedna klasyfikacja → wiele metryk) ───────────
// Klucz ISTNIEJE: konwersja to ten sam id przeskakujący WYCENA→ZAMÓWIENIE
// (kod: wyceny-endpoints.js:759; paid_at = moment domknięcia). Liczymy TYLKO
// wyceny zrobione w panelu (source ≠ import/shopify). Historia (import) to dwa
// NIEPOWIĄZANE worki — liczenie po niej dałoby fałszywe ~66%.
// Z jednej klasyfikacji wygrana/przegrana/otwarta wychodzi: close rate,
// krzywa umierania, ściana cenowa, dowód telefonu, czas do domknięcia.
const HISTORIA = new Set(['import', 'shopify']); // stary system + self-serve = nie wyceny z panelu
const WINDOW_MS = 30 * 86400000; // okno konwersji phone-match

async function konwersje(db) {
  const [wRes, logRes] = await Promise.all([
    db.from(WYCENY)
      .select('id,typ,status,source,created_at,paid_at,telefon_digits,kwota_proponowana_brutto,kwota_sprzedazy_brutto,rabat24h_kwota')
      .neq('typ', 'NOTATKA'),
    db.from(LOG).select('telefon,data_zmiany,zrodlo'),
  ]);
  if (wRes.error) throw wRes.error;
  if (logRes.error) throw logRes.error;
  const rows = wRes.data || [];
  const log = logRes.data || [];

  // Wszystkie ZAMÓWIENIA (DOWOLNE źródło, też shopify/import) → telefon: kiedy kupił.
  const orderTsByPhone = new Map();
  rows.forEach((r) => {
    if (r.typ !== 'ZAMÓWIENIE') return;
    const p = phone9(r.telefon_digits); if (!p || !r.created_at) return;
    const arr = orderTsByPhone.get(p) || [];
    arr.push(new Date(r.created_at).getTime());
    orderTsByPhone.set(p, arr);
  });
  const firstOrderInWindow = (w) => {
    const p = phone9(w.telefon_digits); if (!p || !w.created_at) return null;
    const t = new Date(w.created_at).getTime();
    const arr = orderTsByPhone.get(p); if (!arr) return null;
    const hits = arr.filter((ot) => ot >= t && ot <= t + WINDOW_MS);
    return hits.length ? Math.min(...hits) : null;
  };

  const cohort = rows.filter((r) => !HISTORIA.has(r.source));
  const now = Date.now();

  // Klasyfikacja per wycena kohorty: won (same-id flip / phone-match), lost, open.
  const wycenki = cohort.map((r) => {
    const t = r.created_at ? new Date(r.created_at).getTime() : null;
    if (r.typ === 'ZAMÓWIENIE') {
      const wonAt = r.paid_at ? new Date(r.paid_at).getTime() : null;
      return { ...r, _t: t, wynik: 'won', won_via: 'same_id', won_at: wonAt };
    }
    const phoneWonAt = firstOrderInWindow(r);
    if (phoneWonAt != null) return { ...r, _t: t, wynik: 'won', won_via: 'phone', won_at: phoneWonAt };
    if (r.status === 'Stracone') return { ...r, _t: t, wynik: 'lost' };
    return { ...r, _t: t, wynik: 'open' };
  });

  const won = wycenki.filter((w) => w.wynik === 'won');
  const domknieteSameId = won.filter((w) => w.won_via === 'same_id').length;
  const domkniete = won.length;
  const stracone = wycenki.filter((w) => w.wynik === 'lost').length;
  const otwarteRows = wycenki.filter((w) => w.wynik === 'open' && w.status === 'Open');
  const dojrzewajace = otwarteRows.filter((w) => w._t && (now - w._t) < WINDOW_MS).length;

  const rozstrzygniete = domkniete + stracone;
  const MIN_PROBA = 15;
  const gotowe = rozstrzygniete >= MIN_PROBA;
  const close_rate = {
    metoda: 'forward kohortowy: ten sam id WYCENA→ZAMÓWIENIE (twardy klucz) + phone-match ZAMÓWIENIA w 30 dni (inny kanał, np. Shopify)',
    wyceny_w_panelu: cohort.length,
    domkniete,
    domkniete_ten_sam_id: domknieteSameId,
    domkniete_inny_kanal: domkniete - domknieteSameId,
    stracone,
    otwarte: otwarteRows.length,
    dojrzewajace,
    close_rate: gotowe ? round(domkniete / rozstrzygniete) : null,
    status: gotowe ? 'ok' : `buduje się — za mało rozstrzygniętych wycen (${rozstrzygniete}/${MIN_PROBA})`,
    _uwaga: 'Liczony TYLKO z wycen z panelu (source ≠ import/shopify). Domknięta = ten sam id stał się ZAMÓWIENIEM LUB ten telefon ma ZAMÓWIENIE (dowolny kanał) w 30 dni od wyceny. Mianownik = domknięte + jawnie Stracone; otwarte (w tym „dojrzewające" <30 dni) poza mianownikiem. Historia (import) nieodtwarzalna.',
  };

  // Krzywa umierania: po ilu dniach od wystawienia wyceny pada domknięcie.
  // Timing: same-id → paid_at; phone-match → created_at pasującego zamówienia.
  const czasy = won
    .filter((w) => w._t && w.won_at && w.won_at >= w._t)
    .map((w) => (w.won_at - w._t) / 86400000);
  const KRZYWA_BUCKETS = [
    { label: '0–3 dni', max: 3 }, { label: '4–7 dni', max: 7 },
    { label: '8–14 dni', max: 14 }, { label: '15–30 dni', max: 30 },
    { label: '31+ dni', max: Infinity },
  ];
  const krzywa_umierania = {
    n: czasy.length,
    status: czasy.length >= 5 ? 'ok' : `buduje się — ${czasy.length}/5 domknięć z timestampem`,
    przedzialy: KRZYWA_BUCKETS.map((b, i) => {
      const min = i === 0 ? -1 : KRZYWA_BUCKETS[i - 1].max;
      const n = czasy.filter((d) => d > min && d <= b.max).length;
      return { label: b.label, n, pct: czasy.length ? round(n / czasy.length) : null };
    }),
  };
  const czas_do_domkniecia = {
    mediana_dni: czasy.length ? Math.round(median(czasy) * 10) / 10 : null,
    n: czasy.length,
  };

  // Ściana cenowa: close rate per przedział kwoty (szukamy progu, powyżej
  // którego domykanie się załamuje). Tylko rozstrzygnięte; min 5 na przedział.
  const kwotaW = (w) => (w.typ === 'ZAMÓWIENIE' ? revenue(w) : num(w.kwota_proponowana_brutto));
  const CENA_BUCKETS = [
    { label: 'do 1 tys.', max: 1000 }, { label: '1–2 tys.', max: 2000 },
    { label: '2–5 tys.', max: 5000 }, { label: '5 tys.+', max: Infinity },
  ];
  const rozstrz = wycenki.filter((w) => w.wynik === 'won' || w.wynik === 'lost');
  const sciana_cenowa = {
    n: rozstrz.length,
    status: rozstrz.length >= 15 ? 'ok' : `buduje się — ${rozstrz.length}/15 rozstrzygniętych`,
    przedzialy: CENA_BUCKETS.map((b, i) => {
      const min = i === 0 ? -Infinity : CENA_BUCKETS[i - 1].max;
      const grupa = rozstrz.filter((w) => { const k = kwotaW(w); return k > min && k <= b.max; });
      const dom = grupa.filter((w) => w.wynik === 'won').length;
      return { label: b.label, rozstrzygniete: grupa.length, domkniete: dom, close_rate: grupa.length >= 5 ? round(dom / grupa.length) : null };
    }),
  };

  // Dowód telefonu: close rate wycen TKNIĘTYCH telefonem w 7 dni od wystawienia
  // vs NIEtkniętych. Uczciwie tylko dla wycen powstałych PO starcie Log zmian
  // (webhook Zadarmy ~2026-07) — starsze mają 0 wierszy, choć dzwoniono.
  const telTs = log
    .filter((r) => !NIE_TELEFON_ZRODLA.has(r.zrodlo) && phone9(r.telefon) && r.data_zmiany)
    .map((r) => ({ p: phone9(r.telefon), t: new Date(r.data_zmiany).getTime() }));
  const minLogTs = telTs.length ? Math.min(...telTs.map((r) => r.t)) : null;
  const callsByPhone = new Map();
  telTs.forEach((r) => { const arr = callsByPhone.get(r.p) || []; arr.push(r.t); callsByPhone.set(r.p, arr); });
  const tknieta = (w) => {
    const p = phone9(w.telefon_digits); if (!p || !w._t) return false;
    const arr = callsByPhone.get(p); if (!arr) return false;
    return arr.some((t) => t >= w._t && t <= w._t + 7 * 86400000);
  };
  const badane = minLogTs == null ? [] : wycenki.filter((w) => w._t && w._t >= minLogTs && w.wynik !== 'open');
  const grupaT = badane.filter(tknieta);
  const grupaN = badane.filter((w) => !tknieta(w));
  const rate = (g) => {
    const dom = g.filter((w) => w.wynik === 'won').length;
    return { rozstrzygniete: g.length, domkniete: dom, close_rate: g.length >= 5 ? round(dom / g.length) : null };
  };
  const dowod_telefonu = {
    od: minLogTs ? new Date(minLogTs).toISOString().slice(0, 10) : null,
    tkniete_7d: rate(grupaT),
    nietkniete: rate(grupaN),
    status: (grupaT.length >= 5 && grupaN.length >= 5) ? 'ok'
      : `buduje się — ${grupaT.length} tkniętych / ${grupaN.length} nietkniętych rozstrzygniętych (od startu logu telefonów)`,
  };

  return { close_rate, krzywa_umierania, czas_do_domkniecia, sciana_cenowa, dowod_telefonu };
}

// Zgodność wstecz: close-rate jako samodzielna grupa (/api/stats/close-rate).
async function closeRate(db) {
  return (await konwersje(db)).close_rate;
}

// ── H. B2B RADAR „powinien już zamówić" ──────────────────────────────────────
// Monterzy/wykonawcy kupują cyklicznie. Per NIP: typowy odstęp zamówień →
// firmy po terminie własnego cyklu = najtańsze telefony w firmie.
// Historia importu tu POMAGA (realne zamówienia B2B), więc bez filtra source.
async function b2bRadar(db) {
  const { data, error } = await db.from(WYCENY)
    .select('id,created_at,invoice_company_nip,invoice_company_name,telefon_e164,telefon_digits,kwota_sprzedazy_brutto,kwota_proponowana_brutto,rabat24h_kwota')
    .eq('typ', 'ZAMÓWIENIE');
  if (error) throw error;
  const rows = data || [];
  const now = Date.now();

  const byNip = new Map();
  rows.forEach((r) => {
    const nip = String(r.invoice_company_nip || '').replace(/\D/g, '');
    if (!nip || !r.created_at) return;
    const arr = byNip.get(nip) || [];
    arr.push(r);
    byNip.set(nip, arr);
  });

  const firmy = [...byNip.entries()].map(([nip, zam]) => {
    zam.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const ts = zam.map((r) => new Date(r.created_at).getTime());
    const odstepy = ts.slice(1).map((t, i) => (t - ts[i]) / 86400000);
    const cykl = odstepy.length ? Math.round(median(odstepy)) : null;
    const dniOdOstatniego = Math.floor((now - ts[ts.length - 1]) / 86400000);
    const last = zam[zam.length - 1];
    const nazwa = [...zam].reverse().map((r) => (r.invoice_company_name || '').trim()).find(Boolean) || `NIP ${nip}`;
    // przeterminowany = po własnym cyklu ×1,25; jednorazowy >90 dni = do odezwania.
    const status = (zam.length >= 2 && cykl && dniOdOstatniego > cykl * 1.25) ? 'przeterminowany'
      : (zam.length === 1 && dniOdOstatniego > 90) ? 'do_odezwania' : 'ok';
    return {
      nip, nazwa, zamowien: zam.length,
      przychod: round(zam.reduce((a, r) => a + revenue(r), 0)),
      cykl_dni: cykl, dni_od_ostatniego: dniOdOstatniego,
      telefon: last.telefon_e164 || last.telefon_digits || null,
      status,
    };
  });

  const rank = { przeterminowany: 0, do_odezwania: 1, ok: 2 };
  firmy.sort((a, b) => (rank[a.status] - rank[b.status]) || (b.przychod - a.przychod));
  return {
    firmy_n: firmy.length,
    z_powtorka_n: firmy.filter((f) => f.zamowien >= 2).length,
    przeterminowane_n: firmy.filter((f) => f.status === 'przeterminowany').length,
    do_odezwania_n: firmy.filter((f) => f.status === 'do_odezwania').length,
    lista: firmy.slice(0, 25),
    _uwaga: 'B2B = zamówienie z NIP. Przeterminowany = od ostatniego zamówienia minęło >1,25× typowego odstępu tej firmy. Jednorazowy >90 dni = „do odezwania".',
  };
}

// ── I. FAKTURY (wyceny_invoices — inFakt) ────────────────────────────────────
async function faktury(db) {
  const { data, error } = await db.from('wyceny_invoices')
    .select('kind,status,gross,paid_at,created_at').neq('status', 'deleted');
  if (error) throw error;
  const rows = data || [];
  const now = Date.now();
  const nieopl = rows.filter((r) => r.status === 'sent' || r.status === 'issued');
  const najstarszaDni = nieopl.length
    ? Math.max(...nieopl.map((r) => Math.floor((now - new Date(r.created_at).getTime()) / 86400000)))
    : null;
  const mies = warsawMonth(new Date());
  const oplaconeMtd = rows.filter((r) => r.paid_at && warsawMonth(r.paid_at) === mies);
  return {
    wystawione: rows.length,
    oplacone: rows.filter((r) => r.status === 'paid').length,
    nieoplacone: { count: nieopl.length, suma: round(nieopl.reduce((a, r) => a + num(r.gross), 0)), najstarsza_dni: najstarszaDni },
    oplacone_mtd: { count: oplaconeMtd.length, suma: round(oplaconeMtd.reduce((a, r) => a + num(r.gross), 0)) },
  };
}

// ── J. MARŻA REALNA (items × sku_cennik.koszty) ──────────────────────────────
// PUŁAPKA (audyt 2026-07-13): zamówienie NIE zapisuje snapshotu kosztu —
// liczymy wg DZISIEJSZEGO cennika (szacunek). Pozycje bez SKU/bez dopasowania
// oraz zamówienia bez items → blended 74% (guardrails §1).
const MARZA_BLENDED = 0.74;
async function marzaRealna(db) {
  const [skuRes, zamRes] = await Promise.all([
    db.from('sku_cennik').select('sku,koszty,vat'),
    db.from(WYCENY).select('id,created_at,items,kwota_sprzedazy_brutto,kwota_proponowana_brutto,rabat24h_kwota').eq('typ', 'ZAMÓWIENIE'),
  ]);
  if (skuRes.error) throw skuRes.error;
  if (zamRes.error) throw zamRes.error;
  const kosztBySku = new Map();
  (skuRes.data || []).forEach((r) => {
    const zakup = r.koszty && Number(r.koszty.zakup_netto);
    if (r.sku && Number.isFinite(zakup)) kosztBySku.set(String(r.sku).trim(), { zakup, vat: num(r.vat) || 23 });
  });

  const zakres = (rows) => {
    let marza = 0, znaneBrutto = 0, nieznaneBrutto = 0;
    rows.forEach((r) => {
      const items = Array.isArray(r.items) ? r.items : [];
      if (!items.length) {
        const brutto = revenue(r);
        nieznaneBrutto += brutto;
        marza += (brutto / 1.23) * MARZA_BLENDED;
        return;
      }
      items.forEach((it) => {
        const qty = num(it.quantity) || 1;
        const brutto = num(it.price) * qty;
        const vat = 1 + (num(it.VAT) || 23) / 100;
        const netto = brutto / vat;
        const sku = kosztBySku.get(String(it.SKU || '').trim());
        if (sku) { marza += netto - sku.zakup * qty; znaneBrutto += brutto; }
        else { marza += netto * MARZA_BLENDED; nieznaneBrutto += brutto; }
      });
    });
    const przychodBrutto = round(znaneBrutto + nieznaneBrutto);
    const przychodNetto = przychodBrutto / 1.23;
    return {
      przychod_brutto: przychodBrutto,
      marza_netto_szac: round(marza),
      pct_marzy: przychodNetto ? round(marza / przychodNetto) : null,
      pokrycie_sku_pct: przychodBrutto ? round(znaneBrutto / przychodBrutto) : null,
    };
  };

  const rows = zamRes.data || [];
  const mies = warsawMonth(new Date());
  return {
    mtd: zakres(rows.filter((r) => r.created_at && warsawMonth(r.created_at) === mies)),
    total: zakres(rows),
    _uwaga: 'Koszt wg DZISIEJSZEGO cennika (sku_cennik.koszty.zakup_netto) — zamówienie nie snapshotuje kosztu. Pozycje bez SKU i zamówienia bez items liczone po blended 74%.',
  };
}

// ── K. TIKTOK ŻYWY (kom_tiktok_stats — komunikator zbiera codziennie) ────────
// `plays` to licznik SKUMULOWANY per film w dniu pomiaru → przyrost = różnica
// między pierwszym a ostatnim pomiarem filmu w zebranym zakresie.
async function tiktokLive(db) {
  const { data, error } = await db.from('kom_tiktok_stats')
    .select('video_id,date,plays,likes,url,published_at');
  if (error) throw error;
  const rows = data || [];
  const byVideo = new Map();
  rows.forEach((r) => {
    if (!r.video_id || !r.date) return;
    const arr = byVideo.get(r.video_id) || [];
    arr.push(r);
    byVideo.set(r.video_id, arr);
  });
  let przyrost = 0, filmyZPomiarem = 0;
  const wzrosty = [];
  byVideo.forEach((arr) => {
    arr.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (arr.length < 2) return;
    filmyZPomiarem += 1;
    const d = Math.max(0, num(arr[arr.length - 1].plays) - num(arr[0].plays));
    przyrost += d;
    wzrosty.push({ url: arr[0].url, przyrost: d, plays: num(arr[arr.length - 1].plays), od: arr[0].date, do: arr[arr.length - 1].date });
  });
  const daty = rows.map((r) => r.date).filter(Boolean).sort();
  return {
    zakres: { od: daty[0] || null, do: daty[daty.length - 1] || null },
    filmy_obserwowane: byVideo.size,
    filmy_z_pomiarem: filmyZPomiarem,
    przyrost_wyswietlen: przyrost,
    top_wzrosty: wzrosty.sort((a, b) => b.przyrost - a.przyrost).slice(0, 3),
    status: filmyZPomiarem ? 'ok' : 'zbiera się — potrzebne ≥2 dni pomiarów tego samego filmu',
  };
}

// ── L. AI / OPERACJE (kom_suggestions — czy sugestie AI są używane) ──────────
async function aiOps(db) {
  const { data, error } = await db.from('kom_suggestions').select('status');
  if (error) throw error;
  const rozklad = {};
  (data || []).forEach((r) => { const s = r.status || 'null'; rozklad[s] = (rozklad[s] || 0) + 1; });
  const rozstrzygniete = (data || []).filter((r) => r.status && r.status !== 'pending').length;
  return { n: (data || []).length, rozstrzygniete, rozklad };
}

// ── E. KAMPANIE / HOOKI (paid: ad_name → lead → telefon → wycena → PRZYCHÓD) ─
// Pytanie biznesowe: która reklama robi KASĘ, nie leady (guardrails §3).
// Bez spendu (dosył od Antoniego) nie ma CPL/CAC/ROAS — sam lejek do przychodu.
async function kampanie(db, params = {}) {
  const win = resolveWindow(params);
  const [ldRes, wRes] = await Promise.all([
    db.from(LEADY).select('"Date",ad_name,"Phone number"'),
    db.from(WYCENY)
      .select('id,typ,status,source,created_at,telefon_digits,kwota_proponowana_brutto,kwota_sprzedazy_brutto,rabat24h_kwota')
      .neq('typ', 'NOTATKA'),
  ]);
  if (ldRes.error) throw ldRes.error;
  if (wRes.error) throw wRes.error;

  // Leady w oknie, dedupe po telefonie (FB Lead Ads dubluje formularze —
  // guardrails §2.6); telefon → najwcześniejszy lead.
  const byPhone = new Map();
  (ldRes.data || []).forEach((r) => {
    const p = phone9(r['Phone number']); if (!p) return;
    const d = parseLeadDate(r['Date']);
    const t = d ? d.getTime() : null;
    if (t == null || !inWindow(t, win)) return;
    const prev = byPhone.get(p);
    if (!prev || t < prev.t) byPhone.set(p, { t, ad: (r.ad_name || '').trim() });
  });

  const groups = new Map(); // ad_name → agregat
  let bezReklamy = 0;
  byPhone.forEach(({ ad }) => {
    if (!ad) { bezReklamy += 1; return; }
    const g = groups.get(ad) || { leady: 0, wyceny: 0, zamowienia: 0, przychod: 0 };
    g.leady += 1;
    groups.set(ad, g);
  });

  // Wyceny/zamówienia dopięte do leada po telefonie; liczymy tylko zdarzenia
  // PO wpadnięciu leada (retarg celuje w starych klientów — wcześniejsze
  // zakupy nie są zasługą tej reklamy).
  (wRes.data || []).forEach((r) => {
    const p = phone9(r.telefon_digits); if (!p) return;
    const lead = byPhone.get(p); if (!lead || !lead.ad) return;
    const g = groups.get(lead.ad); if (!g) return;
    const t = r.created_at ? new Date(r.created_at).getTime() : null;
    if (t == null || t < lead.t) return;
    if (r.typ === 'WYCENA' || (r.typ === 'ZAMÓWIENIE' && !HISTORIA.has(r.source))) g.wyceny += 1;
    if (r.typ === 'ZAMÓWIENIE') { g.zamowienia += 1; g.przychod = round(g.przychod + revenue(r)); }
  });

  const lista = [...groups.entries()].map(([ad, g]) => ({ kampania: ad, ...parseHook(ad), ...g }))
    .sort((a, b) => (b.przychod - a.przychod) || (b.leady - a.leady));

  // Rollup po HOOKU (kreacji) — viral się nie powtarza, typ kreacji tak.
  const hooki = new Map();
  lista.forEach((k) => {
    const h = hooki.get(k.hook) || { hook: k.hook, leady: 0, wyceny: 0, zamowienia: 0, przychod: 0 };
    h.leady += k.leady; h.wyceny += k.wyceny; h.zamowienia += k.zamowienia; h.przychod = round(h.przychod + k.przychod);
    hooki.set(k.hook, h);
  });

  return {
    okno: { od: win.fromTs ? new Date(win.fromTs).toISOString().slice(0, 10) : null, do: win.toTs ? new Date(win.toTs).toISOString().slice(0, 10) : null },
    leady_w_oknie: byPhone.size,
    z_reklamy: byPhone.size - bezReklamy,
    bez_reklamy: bezReklamy,
    kampanie: lista,
    hooki: [...hooki.values()].sort((a, b) => (b.przychod - a.przychod) || (b.leady - a.leady)),
    _uwaga: 'Atrybucja po telefonie leada; liczone tylko wyceny/zamówienia PO dacie leada. Bez spendu nie ma CPL/CAC/ROAS — dorzuć wydatki per kampania (dzienny eksport z Ads Managera), to dojdą.',
  };
}

// ── M. FORWARD (prognoza + cena zaniedbania + trzy liczby wejściowe) ─────────
// "Patrzymy w przód, nie w tył" (Antoni 2026-07-13): zamiast lusterka
// wstecznego — na ile jedziemy i ile kosztuje bezczynność.
async function forward(db, pre = {}) {
  const [sp, pipe, out, kv, wRes] = await Promise.all([
    pre.sp || sprzedaz(db),
    pre.pipe || pipeline(db),
    pre.out || outreach(db),
    pre.kv || konwersje(db),
    db.from(WYCENY).select('id,typ,source,created_at').neq('typ', 'NOTATKA'),
  ]);
  if (wRes.error) throw wRes.error;

  const cr = kv.close_rate.close_rate;
  const zalozenieCr = cr == null;
  const crEff = cr ?? 0.25; // cel 25–35% z guardrails §1 — konserwatywny brzeg
  const aovEff = sp.aov || 1600; // referencyjny AOV z guardrails §1
  const MARZA = MARZA_BLENDED;

  // Prognoza końca miesiąca z bieżącego tempa (bez podwójnego liczenia
  // pipeline'u — ważony pipeline pokazujemy OSOBNO, nie dosypujemy do tempa).
  const nowW = new Date();
  const [y, m] = warsawMonth(nowW).split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const daysElapsed = sp.tempo.daysElapsed;
  const mtd = sp.tenMiesiac.suma;
  const prognozaTempo = daysElapsed ? round((mtd / daysElapsed) * daysInMonth) : null;

  const forecast = {
    mtd,
    dzien: `${daysElapsed}/${daysInMonth}`,
    prognoza_tempo: prognozaTempo,
    poprzedni_miesiac: sp.poprzedniMiesiac.suma,
    pipeline_wazony: round(pipe.suma * crEff),
    pipeline_wazony_marza: round(pipe.suma * crEff * MARZA),
    zalozenie_cr: zalozenieCr ? `close rate przyjęty ${crEff} (własny jeszcze się buduje)` : null,
  };

  // Cena zaniedbania = oczekiwana marża leżąca w (1) nietkniętych leadach
  // wczesnego lejka i (2) martwym pipeline bez telefonu od 7 dni.
  const skladnikLeady = round(out.leady_nietkniete * crEff * aovEff * MARZA);
  const skladnikPipeline = round(out.martwe_wyceny_nieodgrzane.suma * crEff * MARZA);
  const cena_zaniedbania = {
    razem: round(skladnikLeady + skladnikPipeline),
    leady_nietkniete: { n: out.leady_nietkniete, marza_szac: skladnikLeady },
    martwy_pipeline_nieodgrzany: { n: out.martwe_wyceny_nieodgrzane.count, suma_wycen: out.martwe_wyceny_nieodgrzane.suma, marza_szac: skladnikPipeline },
    zalozenia: `close rate ${crEff}${zalozenieCr ? ' (przyjęty)' : ' (własny)'} · AOV ${aovEff} zł · marża ${MARZA}`,
  };

  // Trzy liczby wejściowe tygodnia — jedyne, na które masz wpływ RĘKAMI;
  // przychód jest ich opóźnionym skutkiem.
  const now = Date.now();
  const week = now - 7 * 86400000, twoWeeks = now - 14 * 86400000;
  const panelWyceny = (wRes.data || []).filter((r) => !HISTORIA.has(r.source) && r.created_at);
  const inRange = (r, a, b) => { const t = new Date(r.created_at).getTime(); return t >= a && t < b; };
  const wejscia = {
    telefony: { teraz: out.telefony_tydzien, poprzedni: out.telefony_poprzedni_tydzien },
    wyceny_wyslane: {
      teraz: panelWyceny.filter((r) => inRange(r, week, now + 1)).length,
      poprzedni: panelWyceny.filter((r) => inRange(r, twoWeeks, week)).length,
    },
    followupy_martwych: { teraz: out.martwe_wyceny_tkniete_7d },
  };

  return { forecast, cena_zaniedbania, wejscia };
}

// ── G. SNAPSHOT (rollup firmy na jeden strzał — front + fasada /api/stats) ───
// owner (opcjonalnie): scoping widoku per handlowiec (Kokpit dla nie-admina).
// Bez owner = firmowo (endpoint maszynowy dla zewnętrznych konsumentów).
// Uwaga: owner w `wyceny` to artefakt migracji (guardrails §2.3) — to scoping
// WIDOKU, nie raport wyników.
async function snapshot(db, { owner } = {}) {
  const [sp, pipe, out, ld, kv, radar, fakt, marza] = await Promise.all([
    sprzedaz(db, { owner }), pipeline(db, { limit: 10, owner }), outreach(db, { handlowiec: owner }),
    leady(db), konwersje(db), b2bRadar(db), faktury(db), marzaRealna(db),
  ]);
  const fwd = await forward(db, { sp, pipe, out, kv });
  const cr = kv.close_rate;
  // Nie-admin (owner ustawiony) NIE dostaje bloków firmowych: radar B2B,
  // faktury, marża — sprzedaże są prywatne (decyzja 2026-07-13, wyceny-endpoints).
  const scoped = Boolean(owner && owner !== 'all');

  const alerty = [];
  if (fwd.cena_zaniedbania.razem > 0) alerty.push(`Cena zaniedbania: ~${fwd.cena_zaniedbania.razem.toLocaleString('pl-PL')} zł oczekiwanej marży leży w nietkniętych leadach i nieodgrzanym pipeline (${fwd.cena_zaniedbania.zalozenia}).`);
  if (pipe.suma > 100000) alerty.push(`${pipe.suma.toLocaleString('pl-PL')} zł leży w ${pipe.count} otwartych wycenach (śr. wiek ${pipe.sredni_wiek_dni} dni).`);
  if (pipe.count > 0 && out.martwe_wyceny_tkniete_7d === 0) alerty.push('Żadna otwarta wycena >14 dni nie dostała telefonu w ostatnie 7 dni — nikt nie odgrzewa pipeline’u.');
  if (!scoped && radar.przeterminowane_n > 0) alerty.push(`${radar.przeterminowane_n} firm B2B po terminie własnego cyklu zamówień — najtańsze telefony w firmie (radar B2B).`);
  if (out.leady_nietkniete > 0) alerty.push(`${out.leady_nietkniete} leadów wczesnego lejka (Nowy/Nie odebrał) bez zarejestrowanego telefonu — do przedzwonienia.`);
  if (out.leady_nie_odebral > 0) alerty.push(`${out.leady_nie_odebral} leadów w statusie „Nie odebrał" — nigdy nie dobrzwonione.`);
  if (out.leady_nowe > 0) alerty.push(`${out.leady_nowe} nowych leadów czeka na pierwszy kontakt.`);
  if (out.telefony_dzis === 0) alerty.push('Dziś zero wykonanych telefonów.');
  if (!scoped && fakt.nieoplacone.count > 0 && fakt.nieoplacone.najstarsza_dni > 7) alerty.push(`${fakt.nieoplacone.count} nieopłaconych faktur na ${fakt.nieoplacone.suma.toLocaleString('pl-PL')} zł (najstarsza ${fakt.nieoplacone.najstarsza_dni} dni).`);

  return {
    _status: 'ready',
    generated_at: new Date().toISOString(),
    sprzedaz: {
      przychod_mies: sp.tenMiesiac, delta_do_tempa: round(sp.tenMiesiac.suma - sp.tempo.poprzedniDoTempa),
      aov: sp.aov,
      marza_mtd: scoped ? undefined : marza.mtd, // szacunek wg dzisiejszego cennika (patrz marzaRealna._uwaga)
      close_rate: cr.close_rate, // forward (wyceny z panelu); null dopóki próbka mała
      close_rate_status: cr.status,
      close_rate_wyceny_w_panelu: cr.wyceny_w_panelu,
      b2b_pct: sp.b2b.pct_zamowien, powroty_pct: sp.powroty.pct,
    },
    forecast: fwd.forecast,
    cena_zaniedbania: fwd.cena_zaniedbania,
    wejscia_tygodnia: fwd.wejscia,
    pipeline_otwarty: { count: pipe.count, suma: pipe.suma, sredni_wiek_dni: pipe.sredni_wiek_dni, top_do_dzwonienia: pipe.top_do_dzwonienia },
    outreach: {
      telefony_dzis: out.telefony_dzis, telefony_tydzien: out.telefony_tydzien,
      pct_dodzwonien: out.pct_dodzwonien, czas_rozmowy: out.czas_rozmowy,
      speed_to_lead_med_min: out.speed_to_lead_med_min, // minuty BIZNESOWE 9–21
      nowy_do_ruchu_med_h: out.nowy_do_ruchu_med_h,
      telefony_per_handlowiec: out.telefony_per_handlowiec,
      leady_nowe: out.leady_nowe, leady_nie_odebral: out.leady_nie_odebral,
      leady_nietkniete: out.leady_nietkniete, martwe_wyceny_tkniete_7d: out.martwe_wyceny_tkniete_7d,
      martwe_wyceny_nieodgrzane: out.martwe_wyceny_nieodgrzane,
    },
    konwersje: {
      krzywa_umierania: kv.krzywa_umierania, czas_do_domkniecia: kv.czas_do_domkniecia,
      sciana_cenowa: kv.sciana_cenowa, dowod_telefonu: kv.dowod_telefonu,
    },
    b2b_radar: scoped ? undefined : {
      firmy_n: radar.firmy_n, przeterminowane_n: radar.przeterminowane_n,
      do_odezwania_n: radar.do_odezwania_n, top: radar.lista.slice(0, 5),
    },
    faktury: scoped ? undefined : fakt,
    leady: { lejek: ld.lejek, zrodlo: ld.zrodlo },
    alerty,
  };
}

// ── F. ORGANIK (marketing organiczny: FB + IG + TikTok) ──────────────────────
// Źródło: marketing_organic_daily (FB+TikTok dzienne) + marketing_organic_posts
// (IG+TikTok per-post). Rok z eksportów Meta/TikTok. migracja 006.
async function organik(db, params = {}) {
  const win = resolveWindow(params);
  const [dRes, pRes, ttZywy] = await Promise.all([
    db.from('marketing_organic_daily').select('platform,date,metrics'),
    db.from('marketing_organic_posts').select('platform,post_id,title,url,published_at,views,likes,comments,shares,saves'),
    tiktokLive(db),
  ]);
  if (dRes.error) throw dRes.error;
  if (pRes.error) throw pRes.error;
  const windowed = win.fromTs != null || win.toTs != null;
  const daily = (dRes.data || []).filter((r) => !windowed || (r.date && inWindow(new Date(r.date).getTime(), win)));
  const posts = (pRes.data || []).filter((r) => !windowed || (r.published_at && inWindow(new Date(r.published_at).getTime(), win)));
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
    okno_filtra: windowed ? { od: win.fromTs ? new Date(win.fromTs).toISOString().slice(0, 10) : null, do: win.toTs ? new Date(win.toTs).toISOString().slice(0, 10) : null } : null,
    razem_wyswietlenia,
    platformy,
    szereg_miesieczny: szereg,
    top_posty,
    tiktok_zywy: ttZywy, // kom_tiktok_stats — przyrosty między dziennymi pomiarami
  };
}

// ── PRZEGLĄD (panel główny): momentum + KORELACJA zasięg↔sprzedaż bez leada ──
// MODEL (poprawka rundy 2, docs/statystyki-poprawki-spec.md §2): organik NIE
// robi śledzonych leadów — robi SPRZEDAŻE NIEPRZYPISANE (ludzie widzą materiał,
// dzwonią/piszą, kupują bez wejścia w lejek). Sprzedaż bez leada =
// typ=ZAMÓWIENIE AND lead_id IS NULL AND source ∉ {shopify, import}.
// Tygodnie KALENDARZOWE pon–nd (Europe/Warsaw), nie 7 dni kroczących (§1);
// ostatni kubełek = bieżący tydzień od poniedziałku (częściowy).
function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length); if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (!sxx || !syy) return null;
  return Math.round((sxy / Math.sqrt(sxx * syy)) * 100) / 100;
}
// Test tasowania dla korelacji: w ilu % losowych permutacji serii pieniędzy
// |r| wychodzi ≥ |r obserwowanego|. Stały seed (mulberry32) → wynik stabilny
// między odświeżeniami panelu.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function permutacjaPct(xs, ys, rObs, iters = 200) {
  if (rObs == null) return null;
  const rnd = mulberry32(1337);
  const pool = ys.slice();
  let hits = 0;
  for (let k = 0; k < iters; k++) {
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    const r = pearson(xs, pool);
    if (r != null && Math.abs(r) >= Math.abs(rObs)) hits++;
  }
  return Math.round((hits / iters) * 100);
}
// Arytmetyka na kluczach dni (DST-odporna: liczby na dacie ściennej).
function keyMinusDays(key, days) {
  const [a, b, c] = key.split('-').map(Number);
  return new Date(Date.UTC(a, b - 1, c - days)).toISOString().slice(0, 10);
}
const keyLabel = (key) => `${key.slice(8, 10)}.${key.slice(5, 7)}`;

// WYDARZENIA zakłócające SERIĘ PIENIĘDZY (werdykt Rady AI 07.08: flagi w DANYCH,
// nie dekoracja na osi) — tygodnie objęte incydentem są WYKLUCZANE z korelacji
// formatów/platform (Pearson, placebo, tasowanie). Dopisywać kolejne incydenty.
const WYDARZENIA = [
  { od: '2026-07-12', do: '2026-07-13', label: 'Migracja wycen z Make — tydzień może być zawyżony kumulacją' },
  { od: '2026-07-30', do: '2026-08-03', label: 'Awaria przekierowania telefonu — sprzedaż stłumiona (nie przez content)' },
];
function wydarzeniaTygodnie(weekKeys) {
  return WYDARZENIA.map((e) => {
    const weeks = [];
    for (let i = 0; i < weekKeys.length; i++) {
      const wkStart = weekKeys[i], wkEnd = keyMinusDays(weekKeys[i], -6);
      if (e.od <= wkEnd && e.do >= wkStart) weeks.push(i);
    }
    return { ...e, tygodnie: weeks };
  }).filter((e) => e.tygodnie.length);
}
// Pary (xs[i], ys[i+shift]) z pominięciem par, których TYDZIEŃ PIENIĘDZY (ys)
// jest skażony wydarzeniem — skażona jest seria money, nie zasięg.
function paryBezSkazonych(xs, ys, shift, badY) {
  const a = [], b = [];
  for (let i = 0; i < xs.length; i++) {
    const j = i + shift;
    if (j < 0 || j >= ys.length || (badY && badY.has(j))) continue;
    a.push(xs[i]); b.push(ys[j]);
  }
  return [a, b];
}

// Siatka tygodni pon–nd (Europe/Warsaw). Domyślnie: W ostatnich tygodni od dziś.
// Z {from,to} = WŁASNY zakres dat (panel /kreacje): kotwica = tydzień z `to`
// (przycięty do dziś), długość = pełne tygodnie od `from`; cap 56 tyg.
function siatkaTygodni({ weeks = 12, from, to } = {}, now = Date.now()) {
  const dzisKey = warsawWall(now).day;
  const mondayOf = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
    return keyMinusDays(key, dow);
  };
  let mondayKey, W;
  const dayOk = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (dayOk(from) && dayOk(to) && from <= to) {
    mondayKey = mondayOf(to < dzisKey ? to : dzisKey);
    W = Math.round((Date.parse(mondayKey) - Date.parse(mondayOf(from))) / (7 * 86400000)) + 1;
    W = Math.max(2, Math.min(56, W));
  } else {
    mondayKey = mondayOf(dzisKey);
    W = Math.max(2, Math.min(56, Number(weeks) || 12));
  }
  const weekKeys = Array.from({ length: W }, (_, i) => keyMinusDays(mondayKey, 7 * (W - 1 - i)));
  const bounds = weekKeys.map((k) => utcAtWarsaw(k, 0));
  bounds.push(utcAtWarsaw(keyMinusDays(mondayKey, -7), 0));
  const idx = (ts) => { if (ts == null || ts < bounds[0] || ts >= bounds[W]) return -1; let i = 0; while (i < W - 1 && ts >= bounds[i + 1]) i++; return i; };
  return { W, mondayKey, weekKeys, bounds, idx };
}

async function przeglad(db, { weeks = 12 } = {}) {
  const W = Math.max(2, Math.min(26, Number(weeks) || 12));
  const now = Date.now();
  const [leadyR, wycR, dailyR, postsR] = await Promise.all([
    db.from(LEADY).select('"Date",ad_name'),
    db.from(WYCENY).select('created_at,kwota_sprzedazy_brutto,kwota_proponowana_brutto,rabat24h_kwota,lead_id,source').eq('typ', 'ZAMÓWIENIE'),
    db.from('marketing_organic_daily').select('date,metrics'),
    db.from('marketing_organic_posts').select('platform,published_at,title,url,views,likes'),
  ]);
  if (leadyR.error) throw leadyR.error;
  if (wycR.error) throw wycR.error;

  // Poniedziałek bieżącego tygodnia (Warszawa) → granice W tygodni pon–nd.
  const dzisKey = warsawWall(now).day;
  const [yy, mm, dd] = dzisKey.split('-').map(Number);
  const isoDow = (new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay() + 6) % 7; // 0=pon
  const mondayKey = keyMinusDays(dzisKey, isoDow);
  const weekKeys = Array.from({ length: W }, (_, i) => keyMinusDays(mondayKey, 7 * (W - 1 - i)));
  const bounds = weekKeys.map((k) => utcAtWarsaw(k, 0));
  bounds.push(utcAtWarsaw(keyMinusDays(mondayKey, -7), 0)); // koniec bieżącego tygodnia
  const idx = (ts) => {
    if (ts == null || ts < bounds[0] || ts >= bounds[W]) return -1;
    let i = 0;
    while (i < W - 1 && ts >= bounds[i + 1]) i++;
    return i;
  };

  const bins = weekKeys.map((k) => ({
    label: keyLabel(k), // poniedziałek tygodnia
    leady: 0, sprzedaz_n: 0, sprzedaz_zl: 0,
    bez_leada_n: 0, bez_leada_zl: 0, z_leada_n: 0, z_leada_zl: 0, zasieg: 0,
  }));
  (leadyR.data || []).forEach((r) => { const d = parseLeadDate(r['Date']); if (!d) return; const i = idx(d.getTime()); if (i >= 0) bins[i].leady++; });
  (wycR.data || []).forEach((r) => {
    if (!r.created_at) return;
    const i = idx(new Date(r.created_at).getTime()); if (i < 0) return;
    const zl = revenue(r);
    bins[i].sprzedaz_n++; bins[i].sprzedaz_zl += zl;
    const maLeada = r.lead_id != null && String(r.lead_id).trim() !== '';
    if (maLeada) { bins[i].z_leada_n++; bins[i].z_leada_zl += zl; }
    // „Kanał prywatny/organik": bez leada i nie e-commerce/historia.
    else if (!HISTORIA.has(r.source)) { bins[i].bez_leada_n++; bins[i].bez_leada_zl += zl; }
  });
  (dailyR.data || []).forEach((r) => { const i = idx(r.date ? new Date(r.date).getTime() : null); if (i >= 0) bins[i].zasieg += num(r.metrics && r.metrics.views); });
  (postsR.data || []).forEach((r) => { if (!r.published_at) return; const i = idx(new Date(r.published_at).getTime()); if (i >= 0) bins[i].zasieg += num(r.views); });

  const reach = bins.map((b) => b.zasieg);
  const bezL = bins.map((b) => b.bez_leada_zl);
  const zLead = bins.map((b) => b.z_leada_zl);
  const korelacja = {
    zasieg_sprzedaz_bez_leada: pearson(reach, bezL),
    zasieg_sprzedaz_bez_leada_lag1: pearson(reach.slice(0, -1), bezL.slice(1)), // zasięg t → sprzedaż t+1
    zasieg_sprzedaz_z_leada: pearson(reach, zLead), // kontrast: lejek leadowy
    zasieg_leady: pearson(reach, bins.map((b) => b.leady)), // kontekst (leady ≈ paid)
  };

  const teraz = bins[W - 1], poprz = bins[W - 2] || {};
  const delta = (a, b) => (b ? Math.round((a - b) / b * 100) : (a ? 100 : 0));
  const mom = (a, b) => ({ teraz: Math.round(a || 0), poprzedni: Math.round(b || 0), delta_pct: delta(a || 0, b || 0) });
  const momentum = {
    leady: mom(teraz.leady, poprz.leady),
    sprzedaz_zl: mom(teraz.sprzedaz_zl, poprz.sprzedaz_zl),
    bez_leada_zl: mom(teraz.bez_leada_zl, poprz.bez_leada_zl),
    zasieg: mom(teraz.zasieg, poprz.zasieg),
    sprzedaz_n: mom(teraz.sprzedaz_n, poprz.sprzedaz_n),
    _uwaga: `bieżący tydzień od pon. ${teraz.label} (częściowy) vs poprzedni pełny pon–nd`,
  };

  // Szczyt sprzedaży BEZ leada + content, który mógł go napędzić (tydzień szczytu + poprzedni — lag).
  let best = 0; bins.forEach((b, i) => { if (b.bez_leada_zl > bins[best].bez_leada_zl) best = i; });
  const wStart = bounds[best] - 7 * 86400000, wEnd = bounds[best + 1];
  const top_content = (postsR.data || [])
    .filter((r) => { if (!r.published_at) return false; const t = new Date(r.published_at).getTime(); return t >= wStart && t < wEnd; })
    .sort((a, b) => num(b.views) - num(a.views)).slice(0, 3)
    .map((r) => ({ platform: r.platform, title: r.title, url: r.url, views: num(r.views), likes: num(r.likes) }));

  const sil = (c) => c == null ? 'brak danych' : (Math.abs(c) >= 0.6 ? 'silna' : Math.abs(c) >= 0.3 ? 'umiarkowana' : 'słaba');
  const sgn = (n2) => (n2 >= 0 ? '+' : '') + n2;
  const wnioski = [];
  if (korelacja.zasieg_sprzedaz_bez_leada != null) {
    wnioski.push(`Zasięg organiczny ↔ sprzedaż BEZ leada (kanał prywatny): korelacja ${sgn(korelacja.zasieg_sprzedaz_bez_leada)} (${sil(korelacja.zasieg_sprzedaz_bez_leada)})${korelacja.zasieg_sprzedaz_bez_leada_lag1 != null ? `, z opóźnieniem tygodnia ${sgn(korelacja.zasieg_sprzedaz_bez_leada_lag1)}` : ''}. Kontrast — sprzedaż z lejka leadów: ${korelacja.zasieg_sprzedaz_z_leada == null ? 'brak danych' : sgn(korelacja.zasieg_sprzedaz_z_leada)}.`);
  }
  wnioski.push(`Bieżący tydzień (od pon. ${teraz.label}) vs poprzedni pełny: sprzedaż bez leada ${sgn(momentum.bez_leada_zl.delta_pct)}%, sprzedaż razem ${sgn(momentum.sprzedaz_zl.delta_pct)}%, leady ${sgn(momentum.leady.delta_pct)}%, zasięg ${sgn(momentum.zasieg.delta_pct)}%.`);
  if (bins[best].bez_leada_zl > 0 && top_content[0]) {
    const t0 = String(top_content[0].title || '').replace(/\s+/g, ' ').slice(0, 64) || 'film bez opisu';
    wnioski.push(`Szczyt sprzedaży bez leada: tydzień od ${bins[best].label} (${Math.round(bins[best].bez_leada_zl).toLocaleString('pl-PL')} zł, ${bins[best].bez_leada_n} szt.). Najmocniejszy content z tego okna: „${t0}…" (${top_content[0].views.toLocaleString('pl-PL')} wyśw.).`);
  }

  return {
    tydzien: 'kalendarzowy pon–nd (Europe/Warsaw); ostatni = bieżący od poniedziałku (częściowy)',
    weeks: W,
    tygodnie: bins,
    momentum,
    korelacja,
    najlepszy_tydzien: { label: bins[best].label, bez_leada_zl: round(bins[best].bez_leada_zl), bez_leada_n: bins[best].bez_leada_n, top_content },
    wnioski,
  };
}

// ── FORMAT → EFEKT: czy format SPRZEDAJE, czy tylko robi ZASIĘG ───────────────
// Rozszerza model przeglad() o wymiar FORMATU (marketing_video_analysis.format,
// 285 rolek). MONEY-SIDE = WYCENY + SPRZEDAŻE (typ IN WYCENA,ZAMÓWIENIE) po
// created_at — NIE „sprzedaż bez leada" (feedback Antoniego 06.08: historycznie
// leady nie istniały przed wyceną, więc lead_id NULL to artefakt, nie sygnał).
// Rekordy source='import' WCHODZĄ do serii (decyzja Antoniego 06.08 wieczorem):
// mają prawdziwe daty (154 różne dni, II 2025 → 11.07.2026), a bez nich seria
// pieniędzy to schodek ~0 zł → 20-60 tys./tydz. w momencie migracji z Make i
// korelacje mierzą start systemu, nie sprzedaż. Panele KPI liczą po staremu.
// Trzy warstwy uczciwości:
//  • ODPORNA: produkcja/zasięg/eng per format (join format ← video_id=post_id →
//    marketing_organic_posts.views) — zawsze wiarygodne.
//  • KRUCHA (kierunkowa): Pearson(tyg. zasięg formatu ↔ tyg. wyceny+sprzedaż) + lag
//    1 tyg. Brak atrybucji per-rolka → sygnał kohortowy po czasie, NIE dowód.
//  • ANTY-ZŁUDZENIOWA: placebo (zasięg t ↔ pieniądze t-1 — treść nie może
//    powodować przeszłej sprzedaży; placebo ≈ korelacja ⇒ trend, nie efekt)
//    + test tasowania (w ilu % losowych permutacji |r| wychodzi ≥ obserwowanego).
async function formatEfekt(db, { weeks = 12, platforms = ['tiktok'], from, to } = {}) {
  const plats = Array.isArray(platforms) && platforms.length ? platforms : ['tiktok'];
  const now = Date.now();
  const [vaR, postsR, wycR, fmtR] = await Promise.all([
    db.from('marketing_video_analysis').select('platform,video_id,format,published_at,cover_url,url,hook').in('platform', plats).eq('status', 'done'),
    db.from('marketing_organic_posts').select('platform,post_id,views,likes,comments,shares,saves,title,url,published_at').in('platform', plats),
    db.from(WYCENY).select('created_at,typ,kwota_sprzedazy_brutto,kwota_proponowana_brutto,rabat24h_kwota,source').in('typ', ['WYCENA', 'ZAMÓWIENIE']),
    db.from('marketing_content_formats').select('slug,name').eq('active', true).order('sort_order'),
  ]);
  if (vaR.error) throw vaR.error;
  if (postsR.error) throw postsR.error;
  if (wycR.error) throw wycR.error;

  const metr = new Map(); // `${platform}:${post_id}` → metryki rolki (TT i IG mają osobne przestrzenie id)
  (postsR.data || []).forEach((p) => metr.set(`${p.platform}:${p.post_id}`, {
    views: num(p.views), eng: num(p.likes) + num(p.comments) + num(p.shares) + num(p.saves),
    title: p.title, url: p.url, published_at: p.published_at,
  }));
  const fmtName = new Map((fmtR.data || []).map((f) => [f.slug, f.name]));

  // Tygodnie kalendarzowe pon–nd (Europe/Warsaw) — wspólna siatka (presety/custom zakres).
  const { W, mondayKey, weekKeys, idx } = siatkaTygodni({ weeks, from, to }, now);
  const oknoKrotkie = W < 8; // za mało punktów na werdykty (4 tyg. = 4 punkty = horoskop)
  const wyd = wydarzeniaTygodnie(weekKeys);
  const skazone = new Set(wyd.flatMap((e) => e.tygodnie)); // tygodnie pieniędzy poza korelacją

  // Pieniądze per tydzień: WYCENY+SPRZEDAŻE (moneyWk) i sama sprzedaż (salesWk), po created_at.
  // Import wchodzi (prawdziwe daty historyczne) — patrz nagłówek funkcji.
  const moneyWk = Array(W).fill(0);
  const salesWk = Array(W).fill(0);
  (wycR.data || []).forEach((r) => {
    if (!r.created_at) return;
    const i = idx(new Date(r.created_at).getTime()); if (i < 0) return;
    const zl = revenue(r);
    moneyWk[i] += zl;
    if (r.typ === 'ZAMÓWIENIE') salesWk[i] += zl;
  });
  const moneyTotal = moneyWk.reduce((a, b) => a + b, 0);
  const salesTotal = salesWk.reduce((a, b) => a + b, 0);

  const rows = vaR.data || [];
  const mkey = (r) => `${r.platform}:${r.video_id}`;
  let totalViews = 0;
  const weekReach = Array(W).fill(0); // suma zasięgu WSZYSTKICH rolek (wszystkie żądane platformy) w tygodniu
  const reelEntries = [];             // {platform, video_id, url, cover_url, format, name, views, wk}
  const byFmt = new Map();
  for (const r of rows) {
    const m = metr.get(mkey(r)) || {};
    const pub = r.published_at || m.published_at;
    const i = pub ? idx(new Date(pub).getTime()) : -1;
    if (i < 0) continue; // TYLKO okno W tyg. — totals formatu spójne z korelacją i etykietą „okno"
    // (inaczej wirale spoza okna, np. wrześniowa rolka IG 3,1 mln, zawyżają udział/avg).
    const slug = r.format || 'inne';
    const views = num(m.views);
    let g = byFmt.get(slug);
    if (!g) { g = { slug, name: fmtName.get(slug) || (slug === 'inne' ? 'inne / niesklasyfikowane' : slug), rolek: 0, views: 0, eng: 0, weekly: Array(W).fill(0), byPlat: {}, byPlatN: {} }; byFmt.set(slug, g); }
    g.rolek += 1; g.views += views; g.eng += num(m.eng);
    g.byPlat[r.platform] = (g.byPlat[r.platform] || 0) + views;
    g.byPlatN[r.platform] = (g.byPlatN[r.platform] || 0) + 1;
    g.weekly[i] += views; weekReach[i] += views;
    totalViews += views;
    reelEntries.push({ platform: r.platform, video_id: r.video_id, url: r.url || m.url, cover_url: r.cover_url, format: slug, name: g.name, views, wk: i });
  }

  // Proxy zł per format (w oknie): udział zasięgu rolki w tygodniu × pieniądze
  // (tydzień + następny), zsumowany po rolkach formatu → zł/1000 wyśw. To JĘZYK
  // PLANOWANIA dla SMM zamiast gołego Pearsona (dalej szacunek, nie atrybucja).
  const fmtProxy = new Map(); // slug → { szac, views }
  for (const e of reelEntries) {
    const wr = weekReach[e.wk] || 1;
    const okno = (moneyWk[e.wk] || 0) + (e.wk + 1 < W ? (moneyWk[e.wk + 1] || 0) : 0);
    const p = fmtProxy.get(e.format) || { szac: 0, views: 0 };
    p.szac += e.views / wr * okno; p.views += e.views;
    fmtProxy.set(e.format, p);
  }

  const formaty = [...byFmt.values()].map((g) => {
    // Pary bez tygodni skażonych wydarzeniami (skażona jest strona pieniędzy).
    const [cx0, cy0] = paryBezSkazonych(g.weekly, moneyWk, 0, skazone);
    const [cxL, cyL] = paryBezSkazonych(g.weekly, moneyWk, 1, skazone);  // zasięg t → pieniądze t+1
    const [cxP, cyP] = paryBezSkazonych(g.weekly, moneyWk, -1, skazone); // placebo: zasięg t → pieniądze t-1
    const corr = pearson(cx0, cy0);
    const corrLag = pearson(cxL, cyL);
    const corrPlacebo = pearson(cxP, cyP);
    const nObs = g.weekly.filter((v) => v > 0).length; // tygodni z publikacją tego formatu (w oknie W)
    const bestIdx = (corrLag != null && (corr == null || corrLag > corr)) ? 1 : 0;
    const best = bestIdx === 1 ? corrLag : corr;
    const przypadek_pct = bestIdx === 1 ? permutacjaPct(cxL, cyL, best) : permutacjaPct(cx0, cy0, best);
    const udzial = totalViews ? round(g.views / totalViews * 100) : 0;
    const pewnosc = nObs < 3 ? 'za mało danych' : (nObs < 6 ? 'słaba (mała próba)' : 'orientacyjna');
    // Sygnał zdrowy = placebo wyraźnie niższe od właściwej korelacji; placebo w tej
    // samej lidze co korelacja ⇒ obie mierzą trend tła, nie efekt treści.
    const sygnal = (best == null || nObs < 3 || oknoKrotkie) ? null
      : (corrPlacebo != null && corrPlacebo >= Math.max(0.15, best - 0.1)) ? 'podejrzany (trend)' : 'zdrowy';
    // Werdykt: dużo zasięgu + brak/ujemna zbieżność = PRZEPALA; dodatnia zbieżność
    // = CIĄGNIE, ale tylko gdy przeżyje placebo. Okno <8 tyg. = bez werdyktów.
    let werdykt = 'neutralny';
    if (oknoKrotkie) werdykt = 'okno za krótkie';
    else if (nObs >= 3) {
      if (best != null && best >= 0.3) werdykt = sygnal === 'podejrzany (trend)' ? 'niepewny (trend?)' : 'ciągnie sprzedaż';
      else if (udzial >= 10 && (best == null || best < 0.1)) werdykt = 'przepala zasięg';
    } else werdykt = 'za mało danych';
    const proxy = fmtProxy.get(g.slug);
    return {
      slug: g.slug, name: g.name, rolek: g.rolek, views: g.views,
      udzial_zasiegu_pct: udzial, avg_views: g.rolek ? Math.round(g.views / g.rolek) : 0,
      eng_rate_pct: g.views ? round(g.eng / g.views * 100) : 0,
      korelacja: corr, korelacja_lag1: corrLag, korelacja_placebo: corrPlacebo,
      przypadek_pct, sygnal, n_tygodni: nObs, pewnosc, werdykt,
      szac_zl_okno: proxy ? Math.round(proxy.szac) : 0,
      views_okno: proxy ? Math.round(proxy.views) : 0,
      zl_per_1k: proxy && proxy.views > 0 ? round(proxy.szac / proxy.views * 1000) : null,
      weekly: g.weekly.map((v) => Math.round(v)),
      reach_by_platform: g.byPlat,  // {tiktok: X, instagram: Y} — split zasięgu formatu per platforma
      rolek_by_platform: g.byPlatN, // {tiktok: n, instagram: m} — do porównywarki formatów
    };
  }).sort((a, b) => b.views - a.views);

  // ROLKI Z NAJWIĘKSZĄ ZBIEŻNOŚCIĄ SPRZEDAŻOWĄ (prośba Antoniego). PROXY (nie atrybucja):
  // udział zasięgu rolki w jej tygodniu × (pieniądze w tym tygodniu + następnym/lag).
  const topReels = reelEntries.map((e) => {
    const wr = weekReach[e.wk] || 1;
    const okno = (moneyWk[e.wk] || 0) + (e.wk + 1 < W ? (moneyWk[e.wk + 1] || 0) : 0);
    return {
      platform: e.platform, video_id: e.video_id, url: e.url, cover_url: e.cover_url,
      format: e.format, format_name: fmtName.get(e.format) || e.format,
      views: e.views, tydzien: keyLabel(weekKeys[e.wk]),
      szac_sprzedaz: Math.round(e.views / wr * okno),
    };
  }).filter((e) => e.szac_sprzedaz > 0).sort((a, b) => b.szac_sprzedaz - a.szac_sprzedaz).slice(0, 12);

  // Reality-check „zasięg ≠ sprzedaż": najgłośniejsza rolka w oknie (z reelEntries).
  let topReel = null;
  for (const e of reelEntries) {
    if (topReel && e.views <= topReel.views) continue;
    const m = metr.get(`${e.platform}:${e.video_id}`) || {};
    topReel = { platform: e.platform, video_id: e.video_id, views: e.views, title: m.title, url: e.url, format: e.format, cover_url: e.cover_url };
  }

  const sgn = (n2) => (n2 >= 0 ? '+' : '') + n2;
  const wnioski = [];
  const reachTop = formaty.find((f) => f.udzial_zasiegu_pct > 0);
  if (reachTop) wnioski.push(`Najwięcej zasięgu robi „${reachTop.name}" (${reachTop.udzial_zasiegu_pct}% wyświetleń, ${reachTop.rolek} rolek) — zbieżność z wycenami+sprzedażą: ${reachTop.korelacja == null ? 'brak danych' : sgn(reachTop.korelacja)} (${reachTop.pewnosc}).`);
  const puller = formaty.filter((f) => f.werdykt === 'ciągnie sprzedaż').sort((a, b) => (Math.max(b.korelacja || 0, b.korelacja_lag1 || 0)) - (Math.max(a.korelacja || 0, a.korelacja_lag1 || 0)))[0];
  if (puller) wnioski.push(`Najlepiej ZBIEGA się ze sprzedażą: „${puller.name}"${puller.zl_per_1k != null ? ` — 1000 wyśw. ≈ ${Math.round(puller.zl_per_1k)} zł wycen (szac.)` : ''} (korelacja ${sgn(puller.korelacja)}${puller.korelacja_lag1 != null ? `, z opóźnieniem tyg. ${sgn(puller.korelacja_lag1)}` : ''}, placebo ${puller.korelacja_placebo == null ? '—' : sgn(puller.korelacja_placebo)}${puller.przypadek_pct != null ? `, przypadkiem wychodzi w ~${puller.przypadek_pct} na 100 tasowań` : ''}; ${puller.n_tygodni} tyg. — ${puller.pewnosc}).`);
  const burner = formaty.find((f) => f.werdykt === 'przepala zasięg');
  if (burner) wnioski.push(`Uwaga „zasięg≠sprzedaż": „${burner.name}" bierze ${burner.udzial_zasiegu_pct}% zasięgu, a nie zbiega się ze sprzedażą${burner.zl_per_1k != null ? ` (1000 wyśw. ≈ ${Math.round(burner.zl_per_1k)} zł szac.)` : ''} — kandydat do ograniczenia.`);
  const trendy = formaty.filter((f) => f.werdykt === 'niepewny (trend?)');
  if (trendy.length) wnioski.push(`Test placebo ostrzega przy: ${trendy.map((f) => `„${f.name}"`).join(', ')} — korelacja podobna do „korelacji" z pieniędzmi z PRZESZŁEGO tygodnia, czyli prawdopodobnie wspólny trend, nie efekt treści.`);
  wnioski.push(`Wyceny+sprzedaże w oknie ${W} tyg.: ${Math.round(moneyTotal).toLocaleString('pl-PL')} zł (w tym sprzedaż ${Math.round(salesTotal).toLocaleString('pl-PL')} zł; pełna seria z importem — daty prawdziwe). ⚠️ Brak atrybucji per-rolka — to zbieżność w czasie, nie dowód; patrz „N tyg. / pewność".`);

  return {
    metoda: `format ← video_id=post_id → views (${plats.join('+')}); korelacja tygodniowa (pon–nd Warsaw) zasięgu formatu ↔ WYCENY+SPRZEDAŻE (typ IN WYCENA,ZAMÓWIENIE po created_at, Z importem — prawdziwe daty historyczne); okno ${W} tyg. BEZ atrybucji per-rolka. Tygodnie z wydarzeniami (${skazone.size}) WYKLUCZONE z korelacji/placebo/tasowania. Kontrole: placebo (zasięg t ↔ pieniądze t-1) + test tasowania (200 permutacji, stały seed). zł/1000 wyśw. i ranking rolek = proxy: udział zasięgu w tygodniu × pieniądze (tydzień+następny).`,
    platforms: plats,
    weeks: W,
    okno_krotkie: oknoKrotkie,
    skazone_tygodnie: wyd,
    tydzien_labels: weekKeys.map((k) => keyLabel(k)),
    pieniadze_tyg: moneyWk.map((v) => Math.round(v)),
    pieniadze_suma: Math.round(moneyTotal),
    sprzedaz_suma: Math.round(salesTotal),
    rolek: rows.length, zasieg_total: totalViews,
    formaty,
    top_reels: topReels,
    top_reel: topReel,
    wnioski,
  };
}

// ── KREACJE (osobny panel /kreacje dla SMM): SPLIT platform + TIMELINE treść↔sprzedaż
//    + KATALOG rolek + format→sprzedaż. Reużywa formatEfekt() (TikTok format/korelacja);
//    dokłada zasięg Instagram (per-post) i Facebook (daily agregat), timeline tygodniowy
//    3 platform nałożony na wyceny+sprzedaże, split platformowy i pełny katalog rolek.
//    UWAGA: format/okładki ma na razie TYLKO TikTok — IG/FB w Fazie 2/3 (patrz inwentarz).
async function kreacje(db, { weeks = 26, from, to } = {}) {
  // Format→sprzedaż liczymy z TikTok+IG (Faza 2 dała IG formaty) — więcej danych.
  const fe = await formatEfekt(db, { weeks, from, to, platforms: ['tiktok', 'instagram'] });
  const now = Date.now();
  const [vaR, postsR, dailyR, wycR] = await Promise.all([
    db.from('marketing_video_analysis').select('platform,video_id,format,format_source,published_at,cover_url,url,hook,caption,duration_s,summary:visual->>summary').in('platform', ['tiktok', 'instagram']).eq('status', 'done'),
    db.from('marketing_organic_posts').select('platform,post_id,views,likes,comments,shares,saves,title,url,published_at').in('platform', ['tiktok', 'instagram']),
    db.from('marketing_organic_daily').select('platform,date,metrics'),
    db.from(WYCENY).select('created_at,typ,kwota_sprzedazy_brutto,kwota_proponowana_brutto,rabat24h_kwota,source').in('typ', ['WYCENA', 'ZAMÓWIENIE']),
  ]);
  if (vaR.error) throw vaR.error;
  if (postsR.error) throw postsR.error;

  // Tygodnie kalendarzowe pon–nd (Europe/Warsaw) — TA SAMA siatka co w formatEfekt
  // (te same parametry weeks/from/to ⇒ identyczne weekKeys).
  const { W, mondayKey, weekKeys, idx } = siatkaTygodni({ weeks, from, to }, now);

  const posts = postsR.data || [];
  const daily = dailyR.data || [];
  // TIMELINE: tygodniowy zasięg per platforma (TikTok+IG z per-postów po published_at; FB z daily) + pieniądze.
  const reachTT = Array(W).fill(0), reachIG = Array(W).fill(0), reachFB = Array(W).fill(0);
  posts.forEach((p) => { const i = p.published_at ? idx(new Date(p.published_at).getTime()) : -1; if (i < 0) return; if (p.platform === 'tiktok') reachTT[i] += num(p.views); else if (p.platform === 'instagram') reachIG[i] += num(p.views); });
  daily.forEach((r) => { if (r.platform !== 'facebook') return; const i = r.date ? idx(new Date(r.date).getTime()) : -1; if (i >= 0) reachFB[i] += num(r.metrics && r.metrics.views); });
  const moneyWk = Array(W).fill(0), salesWk = Array(W).fill(0);
  // Import wchodzi (prawdziwe daty) — spójnie z formatEfekt(), patrz jego nagłówek.
  (wycR.data || []).forEach((r) => { if (!r.created_at) return; const i = idx(new Date(r.created_at).getTime()); if (i < 0) return; const zl = revenue(r); moneyWk[i] += zl; if (r.typ === 'ZAMÓWIENIE') salesWk[i] += zl; });

  // SPLIT platformowy (w oknie W tyg.).
  const inWin = (p) => p.published_at && idx(new Date(p.published_at).getTime()) >= 0;
  const totTT = reachTT.reduce((a, b) => a + b, 0), totIG = reachIG.reduce((a, b) => a + b, 0), totFB = reachFB.reduce((a, b) => a + b, 0);
  const nTT = posts.filter((p) => p.platform === 'tiktok' && inWin(p)).length;
  const nIG = posts.filter((p) => p.platform === 'instagram' && inWin(p)).length;
  const totalReach = (totTT + totIG + totFB) || 1;
  const split = [
    { platform: 'tiktok', label: 'TikTok', reach: Math.round(totTT), posty: nTT, ma_format: true, udzial_pct: round(totTT / totalReach * 100) },
    { platform: 'instagram', label: 'Instagram', reach: Math.round(totIG), posty: nIG, ma_format: true, udzial_pct: round(totIG / totalReach * 100) },
    { platform: 'facebook', label: 'Facebook', reach: Math.round(totFB), posty: null, ma_format: false, udzial_pct: round(totFB / totalReach * 100) },
  ];

  // KATALOG: wszystkie rolki TikTok+IG z formatem/okładką + zbieżność sprzedażowa (proxy jak formatEfekt).
  // Metryki per platforma (TT i IG mają osobne przestrzenie id) + zasięg tygodnia liczony
  // w OBRĘBIE platformy rolki (IG rolka = udział w zasięgu IG w jej tygodniu), żeby nie
  // mieszać zasięgów cross-postów między platformami.
  const metrByKey = new Map();
  posts.forEach((p) => metrByKey.set(`${p.platform}:${p.post_id}`, { views: num(p.views), eng: num(p.likes) + num(p.comments) + num(p.shares) + num(p.saves), published_at: p.published_at, url: p.url }));
  const reachOfPlat = (plat, wk) => (plat === 'instagram' ? reachIG[wk] : reachTT[wk]) || 1;
  const fmtName = new Map((fe.formaty || []).map((f) => [f.slug, f.name]));
  const katalog = (vaR.data || []).map((r) => {
    const plat = r.platform;
    const m = metrByKey.get(`${plat}:${r.video_id}`) || {};
    const pub = r.published_at || m.published_at;
    const wk = pub ? idx(new Date(pub).getTime()) : -1;
    const wr = wk >= 0 ? reachOfPlat(plat, wk) : 1;
    const okno = wk >= 0 ? ((moneyWk[wk] || 0) + (wk + 1 < W ? (moneyWk[wk + 1] || 0) : 0)) : 0;
    const views = num(m.views);
    return {
      video_id: r.video_id, platform: plat, url: r.url || m.url, cover_url: r.cover_url,
      format: r.format || 'inne', format_name: fmtName.get(r.format) || (r.format || 'inne'),
      format_source: r.format_source || null,
      views, eng_rate_pct: views ? round(num(m.eng) / views * 100) : 0,
      tydzien: wk >= 0 ? keyLabel(weekKeys[wk]) : null, wk_idx: wk >= 0 ? wk : null,
      szac_sprzedaz: wk >= 0 ? Math.round(views / wr * okno) : 0,
      // Karta rolki (drawer w panelu — zamiast odsyłania od razu do platformy):
      data: pub ? warsawDay(pub) : null, duration_s: r.duration_s || null,
      hook: r.hook || null, summary: r.summary || null, caption: r.caption || null,
      udzial_tyg_pct: wk >= 0 && views ? round(views / wr * 100) : null,
      okno_zl: wk >= 0 ? Math.round(okno) : null,
    };
  }).sort((a, b) => b.szac_sprzedaz - a.szac_sprzedaz);

  // ŚWIEŻOŚĆ danych per platforma (zamiast baneru zaszytego na sztywno w HTML).
  const maxKey = (arr) => arr.reduce((acc, v) => (v && (!acc || v > acc) ? v : acc), null);
  const dane_do = {
    tiktok: maxKey(posts.filter((p) => p.platform === 'tiktok' && p.published_at).map((p) => warsawDay(p.published_at))),
    instagram: maxKey(posts.filter((p) => p.platform === 'instagram' && p.published_at).map((p) => warsawDay(p.published_at))),
    facebook: maxKey(daily.filter((r) => r.platform === 'facebook' && num(r.metrics && r.metrics.views) > 0).map((r) => r.date)),
  };

  // WYDARZENIA zakłócające serię pieniędzy — lista modułowa (WYDARZENIA na górze
  // pliku, tam dopisywać incydenty). Tu: indeksy tygodni pod nakładki UI, a niżej
  // wykluczenie z korelacji platform (formaty wykluczają w formatEfekt).
  const wydarzenia = wydarzeniaTygodnie(weekKeys);
  const skazone = new Set(wydarzenia.flatMap((e) => e.tygodnie));

  // PLATFORMA → SPRZEDAŻ (prośba Antoniego 07.08: „czasem sprzedaje film z FB,
  // czasem z TikToka — musimy zobaczyć tę różnicę"). Korelacja tygodniowego
  // zasięgu KAŻDEJ platformy z pieniędzmi, bez tygodni skażonych; FB dodatkowo
  // bez tygodni po ostatnim dniu danych CSV (braki ≠ zera).
  const badFB = new Set(skazone);
  for (let i = 0; i < W; i++) { const wkEnd = keyMinusDays(weekKeys[i], -6); if (!dane_do.facebook || wkEnd > dane_do.facebook) badFB.add(i); }
  const platformy_korelacja = [
    { platform: 'tiktok', weekly: reachTT, bad: skazone },
    { platform: 'instagram', weekly: reachIG, bad: skazone },
    { platform: 'facebook', weekly: reachFB, bad: badFB },
  ].map(({ platform, weekly, bad }) => {
    const [a0, b0] = paryBezSkazonych(weekly, moneyWk, 0, bad);
    const [aL, bL] = paryBezSkazonych(weekly, moneyWk, 1, bad);
    const [aP, bP] = paryBezSkazonych(weekly, moneyWk, -1, bad);
    const corr = pearson(a0, b0), lag = pearson(aL, bL), placebo = pearson(aP, bP);
    const bestIdx = (lag != null && (corr == null || lag > corr)) ? 1 : 0;
    const best = bestIdx === 1 ? lag : corr;
    const przypadek_pct = bestIdx === 1 ? permutacjaPct(aL, bL, best) : permutacjaPct(a0, b0, best);
    return {
      platform, reach: Math.round(weekly.reduce((x, y) => x + y, 0)),
      korelacja: corr, korelacja_lag1: lag, korelacja_placebo: placebo, przypadek_pct,
      n_tygodni: a0.length,
    };
  });

  return {
    weeks: W,
    okno_od: weekKeys[0], okno_do: keyMinusDays(mondayKey, -6),
    split,
    timeline: {
      labels: weekKeys.map((k) => keyLabel(k)),
      reach: { tiktok: reachTT.map((v) => Math.round(v)), instagram: reachIG.map((v) => Math.round(v)), facebook: reachFB.map((v) => Math.round(v)) },
      wyceny_zl: moneyWk.map((v) => Math.round(v)),
      sprzedaz_zl: salesWk.map((v) => Math.round(v)),
    },
    formaty: fe.formaty,
    katalog,
    top_reel: fe.top_reel,
    pieniadze_suma: fe.pieniadze_suma,
    sprzedaz_suma: fe.sprzedaz_suma,
    wnioski: fe.wnioski,
    metoda: fe.metoda,
    okno_krotkie: fe.okno_krotkie,
    platformy_korelacja,
    dane_do,
    wydarzenia,
    inwentarz: { tiktok_rolek_okno: nTT, instagram_rolek_okno: nIG, facebook: 'tylko dzienny zasięg (brak per-rolka)', format_dla: 'TikTok + Instagram (FB w Fazie 3)' },
  };
}

module.exports = {
  sprzedaz, pipeline, outreach, leady, closeRate, snapshot, organik, przeglad, formatEfekt, kreacje,
  konwersje, kampanie, b2bRadar, faktury, marzaRealna, tiktokLive, aiOps, forward,
  // do testów jednostkowych (zegar biznesowy, okna, parser hooków)
  _internal: { bizMinutes, utcAtWarsaw, warsawWall, resolveWindow, parseHook, median, phone9 },
};
