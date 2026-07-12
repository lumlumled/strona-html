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

module.exports = {
  FEEDBACK_WATCH_TABLE,
  warsawParts,
  warsawDateStr,
  warsawToIso,
  plDateToIso,
  setWatch,
  resolveWatch,
  getOpenWatches,
};
