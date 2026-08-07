// Wciąganie ręcznych eksportów dziennych Facebooka (Meta Business Suite →
// Statystyki → eksport CSV) do marketing_organic_daily (platform='facebook').
// Potrzebne, bo Graph API v21 NIE oddaje treściowych metryk strony FB (Meta je
// wycofała) — wchodzą tylko ręcznym eksportem:
//   • Wyświetlenia                    → views      (to czyta panel jako zasięg FB)
//   • Widzowie                        → reach      (unikalni odbiorcy)
//   • Interakcje z zawartością        → interactions
//   • Kliknięcia linku na Facebooku   → link_clicks
// Metryka rozpoznawana po NAGŁÓWKU (2. linia CSV), nie po nazwie pliku; pliki
// „…na Instagramie" pomijane (IG leci automatem z API). MERGE po dacie w kolumnie
// metrics (jsonb): dokładamy/nadpisujemy TYLKO te 4 klucze — visits/new_followers
// z API zostają nietknięte. Rdzeń współdzielony przez CLI (scripts/
// fb-daily-from-csv.js) i upload z panelu /kreacje (POST /kreacje/api/fb-csv).
// Pamięć: project_faza3_meta_api.

// nagłówek (2. linia CSV) → klucz metryki w metrics jsonb
const CLASSIFY = [
  { re: /Wy[śs]wietlenia/i, key: 'views' },
  { re: /Widzowie/i, key: 'reach' },
  { re: /Interakcje/i, key: 'interactions' },
  { re: /Klikni.*Facebook/i, key: 'link_clicks' },
];
const IG_SKIP = /Klikni.*Instagram|na Instagramie/i;

// Bufor CSV (UTF-16LE z BOM albo UTF-8) → { title, data: Map(YYYY-MM-DD → liczba) }
function parseCsvBuffer(buf) {
  const t = (buf[0] === 0xff && buf[1] === 0xfe) ? buf.toString('utf16le') : buf.toString('utf8');
  const lines = t.split(/\r?\n/).filter(Boolean);
  const title = (lines[1] || '').replace(/"/g, '').trim();
  const data = new Map();
  for (const l of lines) {
    const m = l.match(/^"?(\d{4}-\d{2}-\d{2})T[^"]*"?\s*,\s*"?(-?\d+)"?/);
    if (m) data.set(m[1], Number(m[2]));
  }
  return { title, data };
}

// files: [{ name, buffer }] → klasyfikacja bez zapisu (raport per plik).
function analyzeFiles(files) {
  const perMetric = {}; // key → Map(date→value)
  const raporty = [];   // { plik, status: 'ok'|'instagram'|'nierozpoznany', metryka?, title, dni?, od?, do? }
  for (const f of files) {
    const { title, data } = parseCsvBuffer(f.buffer);
    if (IG_SKIP.test(title)) { raporty.push({ plik: f.name, status: 'instagram', title }); continue; }
    const hit = CLASSIFY.find((c) => c.re.test(title));
    if (!hit || !data.size) { raporty.push({ plik: f.name, status: 'nierozpoznany', title }); continue; }
    perMetric[hit.key] = data;
    const dates = [...data.keys()].sort();
    raporty.push({ plik: f.name, status: 'ok', metryka: hit.key, title, dni: data.size, od: dates[0], do: dates[dates.length - 1] });
  }
  return { perMetric, raporty };
}

// Pełny przebieg: parsowanie + MERGE do marketing_organic_daily. `db` = klient
// supabase-js (wstrzykiwany jak w queries.js). Zwraca raport dla UI/CLI.
async function ingest(db, files) {
  const { perMetric, raporty } = analyzeFiles(files);
  const metricKeys = Object.keys(perMetric);
  if (!metricKeys.length) return { raporty, dni: 0, metryki: [], zakres: null };

  const allDates = new Set();
  for (const m of Object.values(perMetric)) for (const d of m.keys()) allDates.add(d);

  const { data: rows, error } = await db.from('marketing_organic_daily').select('date,metrics').eq('platform', 'facebook');
  if (error) throw error;
  const existing = new Map((rows || []).map((r) => [r.date, r.metrics || {}]));

  const now = new Date().toISOString();
  const upserts = [];
  for (const date of allDates) {
    const merged = { ...(existing.get(date) || {}) };
    for (const key of metricKeys) if (perMetric[key].has(date)) merged[key] = perMetric[key].get(date);
    upserts.push({ platform: 'facebook', date, metrics: merged, source: 'meta_api+csv', fetched_at: now, updated_at: now });
  }
  upserts.sort((a, b) => a.date.localeCompare(b.date));
  for (let i = 0; i < upserts.length; i += 200) {
    const { error: e2 } = await db.from('marketing_organic_daily').upsert(upserts.slice(i, i + 200), { onConflict: 'platform,date' });
    if (e2) throw e2;
  }
  return {
    raporty, dni: upserts.length, metryki: metricKeys,
    zakres: upserts.length ? { od: upserts[0].date, do: upserts[upserts.length - 1].date } : null,
  };
}

// Minimalny parser multipart/form-data (bez zależności — busboy/multer nie ma w
// repo, a pliki to małe CSV). body = surowy Buffer, contentType z nagłówka.
// Zwraca [{ name, buffer }] — tylko części z filename (pola tekstowe pomijamy).
function parseMultipart(body, contentType) {
  const bm = /boundary=("?)([^";]+)\1/i.exec(contentType || '');
  if (!bm) throw new Error('brak boundary w Content-Type');
  const boundary = Buffer.from('--' + bm[2]);
  const files = [];
  let pos = body.indexOf(boundary);
  while (pos !== -1) {
    const next = body.indexOf(boundary, pos + boundary.length);
    if (next === -1) break;
    // część = [pos+boundary+CRLF ... next-CRLF]
    const part = body.slice(pos + boundary.length + 2, next - 2);
    const headEnd = part.indexOf('\r\n\r\n');
    if (headEnd !== -1) {
      const head = part.slice(0, headEnd).toString('utf8');
      const fn = /filename="([^"]*)"/i.exec(head);
      if (fn && fn[1]) files.push({ name: fn[1], buffer: part.slice(headEnd + 4) });
    }
    pos = next;
  }
  return files;
}

module.exports = { parseCsvBuffer, analyzeFiles, ingest, parseMultipart, CLASSIFY, IG_SKIP };
