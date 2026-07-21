// ── Załączniki wiadomości: trwała kopia + analiza AI ────────────────────────
// Trzy fazy, każda idempotentna i odporna na zabicie funkcji w połowie:
//   1. capture  — webhook/sync wpisuje wiersze kom_attachments (tania operacja,
//                 mieści się w budżecie 5 s webhooka Zernio),
//   2. fetch    — worker pobiera plik z CDN Mety / Gmail API do Supabase Storage
//                 (bucket kom-media; CDN Mety wygasa po paru dniach, stąd pośpiech),
//   3. analyze  — wielowarstwowa analiza AI: opis+ekstrakcja → weryfikacja
//                 przeciwstawna tym samym obrazem → finalny JSON z niepewnościami.
//                 Wynik (ai_summary/ai_data) widzi panel przy załączniku, a
//                 sugestie i handlowiec dostają go w kontekście rozmowy.
// Wpięcia: ingest/zernio.js + ingest/gmail.js (capture), /api/cron/media co 2 min
// przez pg_cron + runWorker (fetch+analyze), endpoint sugestii (processThread —
// analiza "na żądanie", gdy Antoni otwiera wątek zanim cron zdążył).

const llm = require('./llm');

const BUCKET = 'kom-media';
const MAX_TRANSCRIBE_BYTES = 24 * 1024 * 1024; // limit OpenAI ~25 MB
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;       // limit Anthropic na obraz
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const STALE_CLAIM_MS = 10 * 60 * 1000;         // po tylu minutach przejmujemy 'fetching'/'running'
const GMAIL_MIN_BYTES = 20 * 1024;             // mniejsze załączniki maili = logo w stopce, pomijamy

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// ── Capture ──────────────────────────────────────────────────────────────────

// Share'y (reel, post, link) mają w payload.url stronę FB/IG, nie plik CDN —
// nie da się ich pobrać; zostają jako link z tytułem.
function isShareLink(url) {
  try {
    const host = new URL(url).hostname;
    return /(^|\.)facebook\.com$|(^|\.)fb\.watch$|(^|\.)instagram\.com$/.test(host);
  } catch {
    return false;
  }
}

// Zernio: msg.attachments = [{type, url?, payload?: {url, title, ...}}].
// direction 'in' → pełna analiza AI; 'out' (zdjęcia wysłane z telefonu przez
// Messengera) → tylko kopia i podgląd, bez AI.
async function captureZernio(db, { messageId, threadId, direction, attachments }) {
  if (!Array.isArray(attachments) || !attachments.length) return { captured: 0 };
  const rows = attachments.map((a, i) => {
    const url = a.url || a.payload?.url || null;
    const title = a.payload?.title || null;
    const undownloadable = a.type === 'fallback' || !url || isShareLink(url);
    const analyzable = direction === 'in' && !undownloadable
      && ['image', 'video', 'audio', 'file'].includes(a.type);
    return {
      message_id: messageId,
      thread_id: threadId,
      position: i,
      type: a.type || 'file',
      original_url: url,
      title,
      status: undownloadable ? 'skipped' : 'pending',
      ai_status: analyzable ? 'pending' : 'skipped',
      ...(undownloadable && title ? { ai_summary: `Udostępniona treść: ${title}` } : {}),
    };
  });
  const { error } = await db.from('kom_attachments')
    .upsert(rows, { onConflict: 'message_id,position', ignoreDuplicates: true });
  if (error) throw error;
  return { captured: rows.length };
}

// Gmail: części z body.attachmentId i nazwą pliku; drobiazgi (<20 KB) to
// niemal zawsze grafiki stopki — pomijamy, nie zaśmiecamy wątku.
function gmailAttachmentParts(payload) {
  const found = [];
  const stack = [payload];
  while (stack.length) {
    const part = stack.shift();
    if (!part) continue;
    if (part.body?.attachmentId && part.filename && (part.body.size || 0) >= GMAIL_MIN_BYTES) {
      found.push({
        attachmentId: part.body.attachmentId,
        filename: part.filename,
        mimeType: part.mimeType || 'application/octet-stream',
        size: part.body.size || null,
      });
    }
    if (part.parts) stack.push(...part.parts);
  }
  return found;
}

function typeFromMime(mime) {
  if (!mime) return 'file';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

async function captureGmail(db, { messageId, threadId, mailbox, gmailMessageId, parts }) {
  if (!parts.length) return { captured: 0 };
  const rows = parts.map((p, i) => {
    const type = typeFromMime(p.mimeType);
    const analyzable = type !== 'file' || p.mimeType === 'application/pdf';
    return {
      message_id: messageId,
      thread_id: threadId,
      position: i,
      type,
      mime: p.mimeType,
      filename: p.filename,
      size_bytes: p.size,
      source: { gmail: { mailbox, gmailMessageId, attachmentId: p.attachmentId } },
      status: 'pending',
      ai_status: analyzable ? 'pending' : 'skipped',
    };
  });
  const { error } = await db.from('kom_attachments')
    .upsert(rows, { onConflict: 'message_id,position', ignoreDuplicates: true });
  if (error) throw error;
  return { captured: rows.length };
}

// ── Fetch (pobieranie do Storage) ────────────────────────────────────────────

let bucketReady = false;
async function ensureBucket(db) {
  if (bucketReady) return;
  const { error } = await db.storage.createBucket(BUCKET, { public: false });
  if (error && !/already exists|duplicate/i.test(error.message)) throw error;
  bucketReady = true;
}

function extFor(mime, url) {
  const byMime = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
    'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/ogg': '.ogg', 'audio/wav': '.wav',
    'application/pdf': '.pdf',
  };
  if (mime && byMime[mime]) return byMime[mime];
  const m = String(url || '').match(/\.([a-z0-9]{2,4})(?:[?#]|$)/i);
  return m ? `.${m[1].toLowerCase()}` : '';
}

// Atomowe przejęcie wiersza (dwa crony mogą chodzić równolegle): UPDATE z
// warunkiem na stary status — kto dostał wiersz z powrotem, ten go ma.
async function claim(db, id, field, from, to) {
  const { data, error } = await db.from('kom_attachments')
    .update({ [field]: to, updated_at: new Date().toISOString() })
    .eq('id', id).eq(field, from).select('*');
  if (error) throw error;
  return data && data[0];
}

async function downloadSource(db, att) {
  if (att.source?.gmail) {
    const gmail = require('./ingest/gmail'); // require w funkcji — cykl media↔gmail
    return gmail.downloadAttachment(db, att.source.gmail);
  }
  const res = await fetch(att.original_url);
  if (res.status === 403 || res.status === 404 || res.status === 410) {
    const err = new Error(`CDN ${res.status} — link wygasł`);
    err.expired = true;
    throw err;
  }
  if (!res.ok) throw new Error(`Pobieranie ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const mime = (res.headers.get('content-type') || '').split(';')[0].trim() || null;
  return { buffer, mime };
}

async function fetchOne(db, att) {
  const { buffer, mime } = await downloadSource(db, att);
  const finalMime = att.mime || mime || 'application/octet-stream';
  const path = `${att.thread_id}/${att.id}${extFor(finalMime, att.original_url)}`;
  const { error: upErr } = await db.storage.from(BUCKET)
    .upload(path, buffer, { contentType: finalMime, upsert: true });
  if (upErr) throw upErr;
  const { error } = await db.from('kom_attachments').update({
    status: 'stored',
    storage_path: path,
    mime: finalMime,
    size_bytes: buffer.length,
    fetch_error: null,
    updated_at: new Date().toISOString(),
  }).eq('id', att.id);
  if (error) throw error;
}

async function fetchPending(db, { limit = 10, threadId = null, deadline = Infinity } = {}) {
  await ensureBucket(db);
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
  let q = db.from('kom_attachments').select('*')
    .or(`status.eq.pending,and(status.eq.fetching,updated_at.lt.${staleBefore})`)
    .order('created_at', { ascending: true }).limit(limit);
  if (threadId) q = q.eq('thread_id', threadId);
  const { data: rows, error } = await q;
  if (error) throw error;

  const result = { fetched: 0, expired: 0, failed: 0 };
  for (const row of rows || []) {
    if (Date.now() > deadline) break;
    const owned = await claim(db, row.id, 'status', row.status, 'fetching');
    if (!owned) continue;
    try {
      await fetchOne(db, owned);
      result.fetched += 1;
    } catch (err) {
      const attempts = (owned.fetch_attempts || 0) + 1;
      const status = err.expired ? 'expired' : (attempts >= 3 ? 'failed' : 'pending');
      if (err.expired) result.expired += 1; else result.failed += 1;
      await db.from('kom_attachments').update({
        status,
        fetch_attempts: attempts,
        fetch_error: String(err.message).slice(0, 500),
        // Bez pliku nie będzie analizy — zamykamy też ai_status, żeby worker
        // nie mielił wiersza w nieskończoność.
        ...(status !== 'pending' ? { ai_status: 'skipped' } : {}),
        updated_at: new Date().toISOString(),
      }).eq('id', row.id);
    }
  }
  return result;
}

// ── Analyze (wielowarstwowa analiza AI) ──────────────────────────────────────

const ANALYZE_SYSTEM = `Jesteś analitykiem załączników dla LumLum - polskiej firmy sprzedającej oświetlenie LED
(cyfrowe taśmy COB do schodów, sufitów i wnęk + sterownik LumControl, lumlum.co). Klienci przysyłają
zdjęcia wnętrz, rendery, rzuty techniczne od architektów i szkice z zaznaczonymi miejscami montażu LED
(często żółte lub kolorowe linie, strzałki, obrysy). Twoja analiza trafia do handlowca i do AI piszącego
odpowiedź klientowi, więc musi być rzetelna:
- NIE ZGADUJ. Liczbę podajesz tylko wtedy, gdy faktycznie ją widzisz na obrazie albo policzyłeś
  z widocznych wymiarów - wtedy pokazujesz obliczenie krok po kroku.
- Na rzutach architektonicznych wymiary bywają ukryte: w łańcuchach wymiarowych na obrzeżach rysunku,
  w osiach ścian, w opisach pomieszczeń (nazwa + powierzchnia m2). Szukaj ich tam zanim uznasz,
  że wymiarów nie ma. Zwróć uwagę na jednostki (cm vs m vs mm).
- Na zdjęciach z budowy/remontu AKTYWNIE wypatruj śladów PRZYGOTOWANIA pod montaż LED - to często
  najważniejsza informacja na zdjęciu, bo pokazuje, gdzie taśma jest przewidziana: zamontowane
  profile aluminiowe (długie, wąskie kanały w suficie/ścianie/schodach/zabudowie), zwisające albo
  wyprowadzone ze ściany przewody (punkt zasilania taśmy), bruzdy/szczeliny/wnęki w zabudowie GK,
  gotowe gniazda czujników ruchu. Każde takie miejsce opisz: gdzie jest i po czym je poznajesz.
- Jeśli klient podaje w rozmowie długości (np. "dwie linie po 9 m"), spróbuj DOPASOWAĆ je do
  widocznych profili/odcinków (który odcinek to które 9 m) - a jeśli dopasowanie jest niepewne,
  powiedz to wprost.
- Wszystko, co jest interpretacją a nie odczytem, wpisujesz do "niepewnosci".
- Piszesz po polsku. Nigdy nie używaj długiego myślnika, zawsze zwykły dywiz.
Odpowiadasz WYŁĄCZNIE poprawnym JSON-em, bez komentarzy przed ani po.`;

function parseModelJson(text) {
  const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Model nie zwrócił JSON-a');
  return JSON.parse(cleaned.slice(start, end + 1));
}

// Kontekst rozmowy dla analizy: ostatnie wiadomości wątku (analiza obrazka bez
// tego, co klient napisał obok, mija się z celem — "tu gdzie zaznaczyłem").
async function threadContext(db, att) {
  const { data } = await db.from('kom_messages')
    .select('direction,body,created_at')
    .eq('thread_id', att.thread_id)
    .order('created_at', { ascending: false })
    .limit(12);
  const lines = (data || []).reverse().map((m) => {
    const who = m.direction === 'in' ? 'KLIENT' : (m.direction === 'internal' ? 'NOTATKA WEWN.' : 'LUMLUM');
    return `${who}: ${String(m.body || '').slice(0, 400)}`;
  });
  return lines.join('\n');
}

async function loadStored(db, att) {
  const { data, error } = await db.storage.from(BUCKET).download(att.storage_path);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

function mediaBlock(att, buffer) {
  const data = buffer.toString('base64');
  if (att.mime === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  if (!IMAGE_MIMES.has(att.mime)) throw new Error(`Format ${att.mime} bez obsługi wizyjnej`);
  return { type: 'image', source: { type: 'base64', media_type: att.mime, data } };
}

// Warstwa 1: klasyfikacja + pełna ekstrakcja (opis, napisy, wymiary, oznaczenia
// klienta, obliczenia metrażu LED jeśli możliwe).
async function analyzeImagePass1(att, buffer, context) {
  const instruction = `${context ? `KONTEKST ROZMOWY (ostatnie wiadomości):\n${context}\n\n` : ''}Przeanalizuj załącznik od klienta KROK PO KROKU:
1. Sklasyfikuj: rzut_techniczny | szkic_z_wymiarami | zdjecie_wnetrza | render | screenshot | produkt | dokument | inne.
2. Opisz dokładnie co widać: pomieszczenia/obiekty, stan (surowy, wykończony), oraz WSZYSTKIE oznaczenia
   naniesione przez klienta (kolorowe linie, strzałki, obrysy, podkreślenia) i co najpewniej oznaczają.
3. Wypisz wszystkie odczytane napisy i wymiary z jednostkami, dokładnie tak jak na obrazie.
4. AKTYWNIE wypatruj miejsc PRZYGOTOWANYCH pod LED: profile aluminiowe (długie wąskie kanały),
   zwisające/wyprowadzone przewody zasilające, bruzdy/szczeliny/wnęki w zabudowie. Każde opisz
   (gdzie, po czym poznajesz). To zwykle mówi więcej niż słowa klienta o tym, gdzie pójdzie taśma.
5. Jeśli widać miejsca planowanego montażu LED (przygotowanie z pkt 4, oznaczenia klienta albo opis
   w rozmowie): opisz gdzie, dopasuj do długości podanych w rozmowie (które to które), a jeśli da się
   policzyć długości z widocznych wymiarów - policz każdy odcinek krok po kroku.
Zwróć JSON:
{"typ": "...", "opis": "...", "napisy_i_wymiary": ["..."], "oznaczenia_klienta": "..." ,
 "przygotowane_pod_led": [{"co": "profil aluminiowy/przewód/bruzda/...", "gdzie": "...", "po_czym_poznano": "..."}],
 "led": {"gdzie": "...", "odcinki": [{"opis": "...", "dlugosc_m": 0, "skad": "..."}], "suma_m": 0} | null,
 "niepewnosci": ["..."]}`;
  const result = await llm.complete({
    task: 'media',
    system: ANALYZE_SYSTEM,
    messages: [{ role: 'user', content: [mediaBlock(att, buffer), { type: 'text', text: instruction }] }],
    maxTokens: 3500,
  });
  return { parsed: parseModelJson(result.text), model: result.model };
}

// Warstwa 2: weryfikacja przeciwstawna — model dostaje obraz DRUGI raz razem
// z wynikiem warstwy 1 i ma go obalić: ponownie odczytać wymiary, przeliczyć
// obliczenia od zera, skonfrontować z rozmową. Dopiero to idzie do handlowca.
async function analyzeImagePass2(att, buffer, context, pass1) {
  const instruction = `${context ? `KONTEKST ROZMOWY:\n${context}\n\n` : ''}Poniżej PIERWSZA analiza tego załącznika. Zweryfikuj ją PRZECIWSTAWNIE, patrząc na obraz od nowa:
- każdy napis i wymiar odczytaj ponownie; usuń z analizy te, których nie widzisz na pewno,
- każde obliczenie przelicz od zera; jeśli wynik się różni, popraw i pokaż rachunek,
- miejsca przygotowane pod LED (profile, przewody, bruzdy) potwierdź na obrazie; dopasowanie
  odcinków do długości z rozmowy oznacz jako pewne albo przenieś do niepewności,
- porównaj z kontekstem rozmowy; sprzeczności wypisz wprost,
- wszystko co jest interpretacją, przenieś do "niepewnosci",
- jeśli czegoś kluczowego brakuje do wyceny, sformułuj konkretne pytania do klienta.

PIERWSZA ANALIZA:
${JSON.stringify(pass1, null, 1).slice(0, 6000)}

Zwróć FINALNY JSON:
{"podsumowanie": "2-4 zdania po polsku dla handlowca: co to jest, co klient chce, gdzie widać przygotowanie pod LED, kluczowe wymiary/metraż",
 "typ": "...", "fakty": ["..."], "wymiary": ["..."],
 "przygotowane_pod_led": ["profil aluminiowy w suficie nad wyspą, ok. ...", "..."],
 "led_suma_m": 0 | null, "obliczenia": "..." | null,
 "niepewnosci": ["..."], "pytania_do_klienta": ["..."]}`;
  const result = await llm.complete({
    task: 'media',
    system: ANALYZE_SYSTEM,
    messages: [{ role: 'user', content: [mediaBlock(att, buffer), { type: 'text', text: instruction }] }],
    maxTokens: 3500,
  });
  return { parsed: parseModelJson(result.text), model: result.model };
}

function summaryFromFinal(fin) {
  let s = String(fin.podsumowanie || '').trim();
  if (Array.isArray(fin.niepewnosci) && fin.niepewnosci.length) {
    s += `\nNiepewne: ${fin.niepewnosci.slice(0, 3).join('; ')}`;
  }
  if (Array.isArray(fin.pytania_do_klienta) && fin.pytania_do_klienta.length) {
    s += `\nWarto dopytać: ${fin.pytania_do_klienta.slice(0, 2).join('; ')}`;
  }
  return s.slice(0, 1500);
}

async function analyzeImage(db, att) {
  const [buffer, context] = await Promise.all([loadStored(db, att), threadContext(db, att)]);
  const limit = att.mime === 'application/pdf' ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
  if (buffer.length > limit) {
    return { summary: `(plik za duży do analizy AI: ${(buffer.length / 1e6).toFixed(1)} MB)`, data: null, model: null, skipped: true };
  }
  const p1 = await analyzeImagePass1(att, buffer, context);
  const p2 = await analyzeImagePass2(att, buffer, context, p1.parsed);
  return {
    summary: summaryFromFinal(p2.parsed),
    data: { final: p2.parsed, pass1: p1.parsed },
    model: p2.model,
  };
}

// Wideo/audio: transkrypcja (ścieżka dźwiękowa mówi zwykle więcej niż klatki),
// potem jedno podsumowanie z kontekstem rozmowy.
async function analyzeAV(db, att) {
  const buffer = await loadStored(db, att);
  if (buffer.length > MAX_TRANSCRIBE_BYTES) {
    return { summary: `(nagranie za duże do transkrypcji: ${(buffer.length / 1e6).toFixed(0)} MB)`, data: null, model: null, skipped: true };
  }
  const { text: transcript } = await llm.transcribe({
    buffer,
    filename: att.filename || `media${extFor(att.mime, att.original_url) || '.mp4'}`,
    mime: att.mime,
  });
  if (!transcript) {
    return { summary: '(nagranie bez rozpoznawalnej mowy)', data: { transkrypcja: '' }, model: null };
  }
  const context = await threadContext(db, att);
  const label = att.type === 'audio' ? 'nagrania głosowego' : 'filmu';
  const instruction = `${context ? `KONTEKST ROZMOWY:\n${context}\n\n` : ''}Transkrypcja ${label} od klienta:
"""
${transcript.slice(0, 6000)}
"""
Podsumuj po polsku dla handlowca: co klient mówi/pokazuje, czego chce, jakie padają wymiary,
ilości i ustalenia. Sprzeczności z rozmową i rzeczy niejasne wpisz do "niepewnosci".
Zwróć JSON: {"podsumowanie": "2-4 zdania", "fakty": ["..."], "niepewnosci": ["..."]}`;
  const result = await llm.complete({
    task: 'media',
    system: ANALYZE_SYSTEM,
    messages: [{ role: 'user', content: instruction }],
    maxTokens: 1200,
  });
  const parsed = parseModelJson(result.text);
  return {
    summary: summaryFromFinal(parsed),
    data: { final: parsed, transkrypcja: transcript },
    model: result.model,
  };
}

async function analyzeOne(db, att) {
  const isImage = att.type === 'image' || att.mime === 'application/pdf'
    || (att.type === 'file' && att.mime === 'application/pdf');
  const out = (att.type === 'video' || att.type === 'audio')
    ? await analyzeAV(db, att)
    : isImage
      ? await analyzeImage(db, att)
      : { summary: null, data: null, model: null, skipped: true };
  const { error } = await db.from('kom_attachments').update({
    ai_status: out.skipped && !out.summary ? 'skipped' : 'done',
    ai_summary: out.summary,
    ai_data: out.data,
    ai_model: out.model,
    ai_error: null,
    updated_at: new Date().toISOString(),
  }).eq('id', att.id);
  if (error) throw error;
}

async function analyzePending(db, { limit = 4, threadId = null, deadline = Infinity } = {}) {
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
  let q = db.from('kom_attachments').select('*')
    .eq('status', 'stored')
    .or(`ai_status.eq.pending,and(ai_status.eq.running,updated_at.lt.${staleBefore})`)
    .order('created_at', { ascending: true }).limit(limit);
  if (threadId) q = q.eq('thread_id', threadId);
  const { data: rows, error } = await q;
  if (error) throw error;

  const result = { analyzed: 0, failed: 0 };
  for (const row of rows || []) {
    if (Date.now() > deadline) break;
    const owned = await claim(db, row.id, 'ai_status', row.ai_status, 'running');
    if (!owned) continue;
    try {
      await analyzeOne(db, owned);
      result.analyzed += 1;
    } catch (err) {
      const attempts = (owned.ai_attempts || 0) + 1;
      result.failed += 1;
      await db.from('kom_attachments').update({
        ai_status: attempts >= 2 ? 'failed' : 'pending',
        ai_attempts: attempts,
        ai_error: String(err.message).slice(0, 500),
        updated_at: new Date().toISOString(),
      }).eq('id', row.id);
      console.error(`Analiza załącznika ${row.id}:`, err.message);
    }
  }
  return result;
}

// ── Wejścia dla workerów i panelu ────────────────────────────────────────────

// Cron co 2 min: najpierw pobieranie (tanie, chroni przed wygaśnięciem CDN),
// potem analiza w pozostałym budżecie czasu.
async function sweep(db, { budgetMs = 150000 } = {}) {
  const deadline = Date.now() + budgetMs;
  const fetch = await fetchPending(db, { limit: 12, deadline });
  const analyze = await analyzePending(db, { limit: 4, deadline });
  return { ok: true, ...fetch, ...analyze };
}

// Na żądanie przy generowaniu sugestii: dociąga i analizuje załączniki TEGO
// wątku, żeby propozycja odpowiedzi wiedziała, co klient przysłał.
async function processThread(db, threadId, { budgetMs = 45000 } = {}) {
  const deadline = Date.now() + budgetMs;
  await fetchPending(db, { limit: 6, threadId, deadline });
  return analyzePending(db, { limit: 3, threadId, deadline });
}

// Krótkie notki o załącznikach do promptu sugestii: message_id → teksty.
async function notesByMessage(db, messageIds) {
  const map = new Map();
  if (!messageIds.length) return map;
  const { data, error } = await db.from('kom_attachments')
    .select('message_id,type,title,status,ai_status,ai_summary')
    .in('message_id', messageIds)
    .order('position', { ascending: true });
  if (error) throw error;
  const labels = { image: 'zdjęcie', video: 'film', audio: 'nagranie głosowe', sticker: 'naklejka', file: 'plik' };
  for (const a of data || []) {
    const label = labels[a.type] || 'załącznik';
    let note;
    if (a.ai_summary) note = `[${label} od klienta - analiza AI: ${a.ai_summary}]`;
    else if (a.title) note = `[${label}: ${a.title}]`;
    else if (a.status === 'expired' || a.status === 'failed') note = `[${label} - niedostępny]`;
    else note = `[${label} w załączniku]`;
    if (!map.has(a.message_id)) map.set(a.message_id, []);
    map.get(a.message_id).push(note);
  }
  return map;
}

async function signedUrl(db, att, { expiresIn = 3600 } = {}) {
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(att.storage_path, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}

module.exports = {
  captureZernio,
  captureGmail,
  gmailAttachmentParts,
  sweep,
  processThread,
  notesByMessage,
  signedUrl,
  BUCKET,
};
