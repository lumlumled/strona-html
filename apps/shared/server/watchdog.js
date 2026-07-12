// ── Watchdog "temat ucieka" — warstwa danych (docs/plan-watchdog-feedback.md) ─
// Jedna tabela feedback_watch trzyma terminy feedbacku wycen i leadów
// (obietnice z wiadomości żyją w kom_commitments — unia w dispatcherze).
// Max jeden OTWARTY watch per obiekt (unikalny indeks częściowy) — nowy termin
// superseduje stary. Ten moduł nie woła AI: ekstraktor/ocena temperatury i
// dispatcher są nadbudową i używają tych samych funkcji zapisu.

const FEEDBACK_WATCH_TABLE = 'feedback_watch';

// ── Europe/Warsaw (wzorzec z leady-endpoints.js — daty zawsze liczone w PL) ──

function warsawParts(date = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Warsaw', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), hh: parts.hour, mm: parts.minute };
}

function warsawDateStr(date = new Date()) {
  const { y, m, d } = warsawParts(date);
  return `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`;
}

// "YYYY-MM-DD" (+ opcjonalnie "HH:mm") w strefie Europe/Warsaw -> ISO UTC.
// Offset PL bywa +01:00/+02:00 — zgadujemy UTC i korygujemy po odczycie
// z Intl (dwa przebiegi wystarczają, DST przesuwa o pełną godzinę).
function warsawToIso(dateStr, timeStr = '09:00') {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!dm) return null;
  const tm = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr || '').trim()) || [null, '9', '00'];
  const [y, mo, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
  const [hh, mm] = [Number(tm[1]), Number(tm[2])];
  let guess = Date.UTC(y, mo - 1, d, hh, mm) - 60 * 60 * 1000; // start od CET (+1)
  for (let i = 0; i < 2; i += 1) {
    const p = warsawParts(new Date(guess));
    const diff = Date.UTC(y, mo - 1, d, hh, mm) - Date.UTC(p.y, p.m - 1, p.d, Number(p.hh), Number(p.mm));
    if (!diff) break;
    guess += diff;
  }
  return new Date(guess).toISOString();
}

// "DD.MM.YYYY [HH:mm]" (format leadów) -> ISO UTC.
function plDateToIso(value, fallbackTime = '09:00') {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}:\d{2}))?/.exec(String(value || '').trim());
  if (!m) return null;
  const date = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return warsawToIso(date, m[4] || fallbackTime);
}

// "YYYY-MM-DD" dzisiejszej daty Warsaw przesunięte o N dni.
function warsawDatePlusDays(days) {
  const { y, m, d } = warsawParts();
  const dt = new Date(Date.UTC(y, m - 1, d + Number(days || 0)));
  return dt.toISOString().slice(0, 10);
}

// ── Zapis/odczyt watchy ──────────────────────────────────────────────────────

// Ustawia termin feedbacku obiektu. Otwarty watch tego obiektu zostaje
// zamknięty jako 'superseded' (chyba że identyczny due_at/visible — wtedy nic).
async function setWatch(supabase, {
  objectType, objectId, owner, dueAt, reason, setBy, visible = false,
  source, backlogTarget = 'b2c',
}) {
  const id = String(objectId);
  const { data: open, error: openErr } = await supabase
    .from(FEEDBACK_WATCH_TABLE).select('*')
    .eq('object_type', objectType).eq('object_id', id)
    .is('resolved_at', null).limit(1);
  if (openErr) throw openErr;
  const existing = open && open[0];
  if (existing
    && new Date(existing.due_at).getTime() === new Date(dueAt).getTime()
    && existing.visible === Boolean(visible)) {
    return existing; // ten sam termin — nie resetujemy baseline ani alertu
  }
  if (existing) {
    const { error } = await supabase.from(FEEDBACK_WATCH_TABLE)
      .update({ resolved_at: new Date().toISOString(), resolution: 'superseded' })
      .eq('id', existing.id);
    if (error) throw error;
  }
  const { data, error } = await supabase.from(FEEDBACK_WATCH_TABLE).insert({
    object_type: objectType,
    object_id: id,
    owner: owner || null,
    due_at: dueAt,
    reason: reason || null,
    set_by: setBy,
    visible: Boolean(visible),
    source: source || null,
    backlog_target: backlogTarget === 'b2b' ? 'b2b' : 'b2c',
  }).select('*');
  if (error) throw error;
  return data[0];
}

// Zamyka otwarty watch obiektu (resolution: 'cancelled' | 'done' | 'activity').
async function resolveWatch(supabase, { objectType, objectId, resolution = 'cancelled' }) {
  const { data, error } = await supabase.from(FEEDBACK_WATCH_TABLE)
    .update({ resolved_at: new Date().toISOString(), resolution })
    .eq('object_type', objectType).eq('object_id', String(objectId))
    .is('resolved_at', null)
    .select('id');
  if (error) throw error;
  return (data || []).length;
}

// Otwarte watche dla listy obiektów -> Map(object_id -> watch).
async function getOpenWatches(supabase, objectType, objectIds) {
  const ids = (objectIds || []).map(String);
  const map = new Map();
  if (!ids.length) return map;
  const { data, error } = await supabase.from(FEEDBACK_WATCH_TABLE)
    .select('*').eq('object_type', objectType).in('object_id', ids)
    .is('resolved_at', null);
  if (error) throw error;
  (data || []).forEach((w) => map.set(w.object_id, w));
  return map;
}

// ── AI: jawna przesłanka terminu + ocena temperatury (jedno wywołanie) ──────
// Wzorzec 1:1 z analyzeNotatka (leady-endpoints.js): gpt-5-mini, JSON wymuszony,
// reasoning minimal, daty względne przelicza model od DZISIAJ (Warsaw).

const WATCHDOG_MODEL = process.env.WATCHDOG_MODEL || 'gpt-5-mini';
const DUE_DAYS_MIN = 2;
const DUE_DAYS_MAX = 21;

function buildWycenaWatchPrompt(dzisiaj) {
  return `Jesteś asystentem CRM firmy LumLum (oświetlenie LED premium).
Dostajesz dane WYCENY wysłanej klientowi. Zdecyduj, KIEDY handlowiec powinien
wrócić do klienta, jeśli ten nie odezwie się sam. Zwróć WYŁĄCZNIE jeden obiekt
JSON. Bez komentarzy, bez markdownu, bez tekstu przed ani po.

DZISIAJ: ${dzisiaj}

===== KROK 1: JAWNA PRZESŁANKA =====
Szukaj w opisie/komentarzu/historii KONKRETNEGO terminu przyszłego kontaktu
("odezwę się za tydzień", "decyzja po świętach", "klient wraca z urlopu 20.07",
"zadzwonić w piątek"). Jeśli jest:
- data_feedbacku = ta data przeliczona względem DZISIAJ, format DD.MM.YYYY
  (data PRZESZŁA względem DZISIAJ → potraktuj jak brak przesłanki),
- reason = krótki cytat/parafraza przesłanki (max 12 słów).
Terminy niezwiązane z kontaktem (dostawa, koniec budowy) → to NIE przesłanka.

===== KROK 2: BRAK PRZESŁANKI — TEMPERATURA =====
data_feedbacku = null i oceń temperaturę tematu:
- GORĄCY (duża kwota, świeża wycena, konkretne pytania, dopięte szczegóły,
  aktywny dialog) → due_days = 3
- NORMALNY → due_days = 7
- CHŁODNY (mała kwota, ogólnikowy opis, stary temat, brak reakcji w historii)
  → due_days = 14
Dozwolony zakres due_days: ${DUE_DAYS_MIN}-${DUE_DAYS_MAX}.
reason = jedno krótkie zdanie po polsku, dlaczego taki termin.

===== FORMAT WYJŚCIOWY =====
{
  "data_feedbacku": "DD.MM.YYYY lub null",
  "due_days": 3,
  "reason": "krótkie uzasadnienie"
}`;
}

function wycenaWatchContext(wycena, extra = {}) {
  const parts = [
    `Kwota wyceny (brutto): ${wycena.kwota_proponowana_brutto ?? 'brak'}`,
    `Utworzona: ${String(wycena.created_at || '').slice(0, 10)}`,
    `Status: ${wycena.status || 'Open'}, etap: ${wycena.process_stage || 'NEW'}`,
    `Klient: ${wycena.imie_nazwisko || 'brak nazwy'}`,
    wycena.opis_zamowienia ? `Opis zamówienia: ${String(wycena.opis_zamowienia).slice(0, 800)}` : '',
    wycena.komentarz ? `Komentarz handlowca: ${String(wycena.komentarz).slice(0, 800)}` : '',
    wycena.history_log ? `Historia: ${String(wycena.history_log).slice(-1200)}` : '',
    extra.eventsCount != null ? `Liczba zdarzeń na wycenie: ${extra.eventsCount}` : '',
    extra.rozmowy ? `Ostatnie rozmowy/notatki z leadem:\n${String(extra.rozmowy).slice(0, 1500)}` : '',
  ];
  return parts.filter(Boolean).join('\n');
}

async function analyzeWycenaFeedback(wycena, extra = {}) {
  const fallback = { data_feedbacku: null, due_days: 7, reason: 'domyślny tydzień (AI niedostępne)' };
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) return fallback;
  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: WATCHDOG_MODEL,
        response_format: { type: 'json_object' },
        reasoning_effort: 'minimal',
        messages: [
          { role: 'system', content: buildWycenaWatchPrompt(warsawDateStr()) },
          { role: 'user', content: wycenaWatchContext(wycena, extra) },
        ],
      }),
    });
    if (!aiRes.ok) return fallback;
    const body = await aiRes.json();
    const parsed = JSON.parse(body.choices?.[0]?.message?.content || '');
    return { ...fallback, ...parsed };
  } catch (err) {
    console.warn(`Watchdog: analiza wyceny ${wycena.id} (GPT) nie powiodła się:`, err.message);
    return fallback;
  }
}

// Uzbraja watchdoga na wycenie bez otwartego watcha: jawna przesłanka z treści
// -> visible=true, inaczej cichy termin z oceny temperatury. Wołane przez
// dispatcher (sweep) — pokrywa nowe wyceny, backfill i re-ewaluację po
// aktywności. Zwraca utworzony watch albo null (nic do zrobienia).
async function armWycena(supabase, wycena, extra = {}) {
  if (!wycena || wycena.typ !== 'WYCENA' || wycena.status !== 'Open') return null;
  const open = await getOpenWatches(supabase, 'wycena', [wycena.id]);
  if (open.size) return null;
  const ai = await analyzeWycenaFeedback(wycena, extra);
  let dueAt = ai.data_feedbacku ? plDateToIso(ai.data_feedbacku) : null;
  // Przesłanka z przeszłości / nieparsowalna -> traktuj jak brak przesłanki.
  if (dueAt && new Date(dueAt).getTime() <= Date.now()) dueAt = null;
  const explicit = Boolean(dueAt);
  if (!dueAt) {
    const days = Math.min(DUE_DAYS_MAX, Math.max(DUE_DAYS_MIN, Number(ai.due_days) || 7));
    dueAt = warsawToIso(warsawDatePlusDays(days));
  }
  return setWatch(supabase, {
    objectType: 'wycena',
    objectId: wycena.id,
    owner: wycena.owner || null,
    dueAt,
    reason: ai.reason || null,
    setBy: 'ai',
    visible: explicit,
    source: explicit ? 'notatka' : 'ai_temperatura',
    backlogTarget: 'b2c',
  });
}

// ── AI: cichy termin dla LEADA z transkrypcją rozmowy (docs §4, etap e) ──────
// Osobny przypadek od wyceny: wejściem jest transkrypcja rozmowy telefonicznej
// (Zadarma -> "Treść rozmowy"). Zawsze cichy watch (visible=false) —
// handlowiec, który wpisze jawną "Data Feedbacku", supersedu­je go triggerem
// mirror (migracja 004). Sygnał z rozmowy "klient odezwie się sam / przemyśli /
// zobaczymy" = najmocniejsza przesłanka i raczej KRÓTSZY termin.

const LEAD_DUE_DAYS_MIN = 3;
// Statusy, których nie pilnujemy (zamknięte / śmieciowe). Współdzielone z
// dispatcherem, żeby wstępny filtr i guard armLead miały jedno źródło prawdy.
const LEAD_EXCLUDED_STAGES = new Set(['Sprzedane', 'Stracony', 'Błędne dane']);

// "ID Leada" to numeric i potrafi przyjść jako '400.0' — kanoniczny object_id
// leada to int jako tekst ('400'), identycznie jak trunc(...)::bigint::text
// w triggerze mirror (migracja 004) i jak wyceny.lead_id.
function leadObjectId(lead) {
  const n = Number(lead && lead['ID Leada']);
  return Number.isFinite(n) ? String(Math.trunc(n)) : '';
}

function buildLeadWatchPrompt(dzisiaj) {
  return `Jesteś asystentem CRM firmy LumLum (oświetlenie LED premium).
Dostajesz dane LEADA po rozmowie telefonicznej (transkrypcja). Zdecyduj, ZA ILE
DNI handlowiec powinien wrócić do klienta, jeśli ten nie odezwie się sam. Zwróć
WYŁĄCZNIE jeden obiekt JSON. Bez komentarzy, bez markdownu, bez tekstu przed ani po.

DZISIAJ: ${dzisiaj}

===== JAK OCENIĆ TERMIN (due_days) =====
Czytaj przede wszystkim TREŚĆ ROZMOWY. Ustaw due_days w zakresie ${LEAD_DUE_DAYS_MIN}-${DUE_DAYS_MAX}:
- Klient sam zapowiedział, że się odezwie / przemyśli / "zobaczymy" / wróci po
  czymś konkretnym (wypłata, urlop, decyzja wspólnika) BEZ podania daty
  -> to najsilniejszy sygnał: krótki termin ${LEAD_DUE_DAYS_MIN}-5 dni (przypilnuj, bo łatwo ucieka).
- GORĄCY (konkretne pytania o produkt/cenę, umawianie szczegółów, żywy dialog)
  -> ${LEAD_DUE_DAYS_MIN}-5 dni.
- NORMALNY (zainteresowany, ale bez konkretów) -> 7 dni.
- CHŁODNY (zdawkowa rozmowa, "na razie tylko się rozglądam", wiele prób kontaktu
  bez efektu, temat stary) -> 14 dni.
- Jeśli rozmowa jasno pokazuje BRAK zainteresowania, ale status nie jest
  zamknięty -> najdłuższy termin (do ${DUE_DAYS_MAX}).
Nie wybieraj terminu spoza zakresu ${LEAD_DUE_DAYS_MIN}-${DUE_DAYS_MAX}.
reason = jedno krótkie zdanie po polsku, z czego wynika termin (najlepiej odwołaj
się do tego, co klient powiedział w rozmowie). Bez półpauzy "—", używaj "-".

===== FORMAT WYJŚCIOWY =====
{
  "due_days": 5,
  "reason": "krótkie uzasadnienie z rozmowy"
}`;
}

function leadWatchContext(lead) {
  const parts = [
    `Klient: ${lead.Name || 'brak nazwy'}`,
    `Deal stage: ${lead['Deal stage'] || 'brak'}`,
    `Ilość telefonów (prób kontaktu): ${lead['Ilość telefonów'] ?? 'brak'}`,
    `Ostatni kontakt: ${lead['Ostatni kontakt'] || 'brak'}`,
    lead['Treść rozmowy'] ? `Treść rozmowy (transkrypcja):\n${String(lead['Treść rozmowy']).slice(0, 2500)}` : '',
    lead['Historia rozmów'] ? `Historia rozmów:\n${String(lead['Historia rozmów']).slice(0, 1200)}` : '',
  ];
  return parts.filter(Boolean).join('\n');
}

async function analyzeLeadFeedback(lead) {
  const fallback = { due_days: 7, reason: 'domyślny tydzień (AI niedostępne)' };
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) return fallback;
  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: WATCHDOG_MODEL,
        response_format: { type: 'json_object' },
        reasoning_effort: 'minimal',
        messages: [
          { role: 'system', content: buildLeadWatchPrompt(warsawDateStr()) },
          { role: 'user', content: leadWatchContext(lead) },
        ],
      }),
    });
    if (!aiRes.ok) return fallback;
    const body = await aiRes.json();
    const parsed = JSON.parse(body.choices?.[0]?.message?.content || '');
    return { ...fallback, ...parsed };
  } catch (err) {
    console.warn(`Watchdog: analiza leada ${lead && lead['ID Leada']} (GPT) nie powiodła się:`, err.message);
    return fallback;
  }
}

// Uzbraja CICHY watch AI na leadzie z transkrypcją rozmowy, który nie ma żadnej
// daty feedbacku. Zapis wyłącznie do feedback_watch (do "Leady B2C" nic nie
// piszemy). Filtr pokrycia otwartą wyceną robi dispatcher (potrzebuje zbioru
// wycen). Zwraca utworzony watch albo null (nic do zrobienia).
async function armLead(supabase, lead) {
  if (!lead) return null;
  if (!String(lead['Treść rozmowy'] || '').trim()) return null;
  if (LEAD_EXCLUDED_STAGES.has(String(lead['Deal stage'] || '').trim())) return null;
  if (String(lead['Data Feedbacku'] || '').trim()) return null;
  if (String(lead['Najbliższa akcja termin'] || '').trim()) return null;
  const id = leadObjectId(lead);
  if (!id) return null;
  const open = await getOpenWatches(supabase, 'lead', [id]);
  if (open.size) return null;
  const ai = await analyzeLeadFeedback(lead);
  const days = Math.min(DUE_DAYS_MAX, Math.max(LEAD_DUE_DAYS_MIN, Number(ai.due_days) || 7));
  const dueAt = warsawToIso(warsawDatePlusDays(days));
  return setWatch(supabase, {
    objectType: 'lead',
    objectId: id,
    owner: String(lead.Owner || '').trim() || null,
    dueAt,
    reason: ai.reason || null,
    setBy: 'ai',
    visible: false,
    source: 'ai_temperatura',
    backlogTarget: 'b2c',
  });
}

module.exports = {
  FEEDBACK_WATCH_TABLE,
  LEAD_EXCLUDED_STAGES,
  warsawParts,
  warsawDateStr,
  warsawToIso,
  plDateToIso,
  warsawDatePlusDays,
  setWatch,
  resolveWatch,
  getOpenWatches,
  leadObjectId,
  analyzeWycenaFeedback,
  armWycena,
  analyzeLeadFeedback,
  armLead,
};
