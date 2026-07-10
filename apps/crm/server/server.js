require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { getClient } = require('./supabase');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Patrz apps/backlog-b2c/server/server.js dla pełnego wyjaśnienia — bez tego
// Vercel CDN cache'owałby odpowiedzi (w tym stronę po zalogowaniu) i serwował
// je każdemu, z pominięciem bramki hasła.
app.use((req, res, next) => {
  if (!req.path.startsWith('/assets/')) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});

const SITE_PASSWORD = process.env.SITE_PASSWORD;
const COOKIE_NAME = 'lumlum_session';
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 dni

// Ten sam bezstanowy, podpisany HMAC-em mechanizm sesji co w
// apps/backlog-b2c/server/server.js (bez bazy użytkowników, jedno wspólne
// hasło) — działa identycznie na serverless (Vercel), bez pamięci procesu.
function sign(value) {
  return crypto.createHmac('sha256', SITE_PASSWORD || '').update(value).digest('hex');
}

function createSessionToken() {
  const expires = String(Date.now() + SESSION_MAX_AGE_MS);
  return `${expires}.${sign(expires)}`;
}

function isValidSessionToken(token) {
  if (!token || !SITE_PASSWORD) return false;
  const [expires, sig] = token.split('.');
  if (!expires || !sig) return false;
  const expected = sign(expires);
  if (expected.length !== sig.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return false;
  return Number(expires) > Date.now();
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  const match = header.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function isAuthenticated(req) {
  return isValidSessionToken(readCookie(req, COOKIE_NAME));
}

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'), { cacheControl: false });
});

app.post('/login', (req, res) => {
  // req.baseUrl: '' lokalnie (odpalone samodzielnie), '/crm' zamontowane pod
  // Vercelem przez api/crm.js — patrz SETUP.md §0 pkt 2.
  if (SITE_PASSWORD && req.body.password === SITE_PASSWORD) {
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${createSessionToken()}; HttpOnly; Path=${req.baseUrl || '/'}; Max-Age=${SESSION_MAX_AGE_MS / 1000}; SameSite=Lax`
    );
    return res.redirect(`${req.baseUrl}/`);
  }
  res.redirect(`${req.baseUrl}/login?error=1`);
});

app.use((req, res, next) => {
  if (isAuthenticated(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Wymagane zalogowanie' });
  return res.redirect(`${req.baseUrl}/login`);
});

app.get('/assets/:file', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'assets', req.params.file));
});

const APP_HTML_TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');

app.get('/', (req, res) => {
  const html = APP_HTML_TEMPLATE.replace(
    '<head>',
    `<head>\n<script>window.API_BASE = ${JSON.stringify(req.baseUrl)};</script>`
  );
  res.type('html').send(html);
});

function handleError(res, err, fallbackStatus = 400) {
  console.error(err);
  const message = err.message || 'Wewnętrzny błąd serwera';
  const status = /brak/i.test(message) ? 500 : fallbackStatus;
  res.status(status).json({ error: message });
}

const LEADY_B2C_TABLE = 'Leady B2C';
const WYCENY_B2C_TABLE = 'Wyceny B2C';
const LOG_ZMIAN_TABLE = 'Log zmian';

function normalizePhoneDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

function formatPhonePlus(raw) {
  const digits = normalizePhoneDigits(raw);
  if (!digits) return '';
  return digits.startsWith('48') ? `+${digits}` : `+48${digits}`;
}

// Kolumny "Leady B2C" edytowalne z tego panelu (styl arkusza — dowolna
// wartość, zapis wprost do bazy). Celowo WYŁĄCZONE spoza tej listy:
// "Phone number" (klucz łączący z Log zmian/Wyceny B2C w całym systemie —
// ręczna zmiana zerwałaby te powiązania), "ID"/"ID Leada" (numeracja
// systemowa/derywowana, kolizje z licznikiem max+1 w webhooku Zadarmy),
// "Źródło" (ustawiane tylko przez webhook). Patrz plan wise-beaming-biscuit.
const EDITABLE_LEAD_FIELDS = [
  'Date',
  'Name',
  'Email',
  'Deal stage',
  'Notes',
  'Data Feedbacku',
  'Temperatura',
  'Ostatni kontakt',
  'Ilość telefonów',
  'Treść rozmowy',
  'Produkty z wyceny',
  'Kwota wyceny',
  'Data wysłania wyceny',
  'Link do formularza',
  'Ocena AI kontaktu',
  // Krótki następny krok z leadem — to samo pole co pigułka akcji w Backlogu
  // (zasilane analizą rozmów Zadarmy / notatką handlowca). Kolumny-metadane
  // ("... termin"/"... owner") celowo poza listą: edytuje je automat i
  // edytor pigułki w Backlogu, w arkuszu byłyby szumem.
  'Najbliższa akcja',
];

// Wszystkie kolumny zwracane do frontu (edytowalne + identyfikacyjne
// tylko-do-odczytu) — surowe nazwy kolumn Supabase używane 1:1 jako klucze,
// żeby uniknąć osobnej warstwy mapowania (to inny cel niż mapLeadRow() w
// Backlogu, który spłaszcza/etykietuje pola pod jeden dzienny widok).
const READONLY_LEAD_FIELDS = ['ID', 'ID Leada', 'Phone number', 'Źródło', 'Facebook Leads ID', 'ad_name'];

async function fetchWycenaByPhone(supabase) {
  const { data, error } = await supabase
    .from(WYCENY_B2C_TABLE)
    .select('Telefon,ID,Status,Kwota,Komentarz,"Link do formularza"');
  if (error) throw error;
  const map = new Map();
  (data || []).forEach((row) => {
    const digits = normalizePhoneDigits(row['Telefon']);
    if (!digits || map.has(digits)) return;
    map.set(digits, row);
  });
  return map;
}

// Zwraca telefon -> { count, dzisiaj } — count to żywa liczba wierszy w
// "Log zmian" (nie legacy skażona kolumna "Ilość telefonów" w Leady B2C,
// patrz project-crm-lorenzzo-migration), dzisiaj to czy którykolwiek wiersz
// ma data_zmiany z dzisiejszej daty (odpowiednik "zadzwonil_dzis" z Backlogu,
// tam liczonego z dziennego JSON-a Umowy — tu liczymy live z tej samej
// tabeli, bo CRM nie ma dziennego dokumentu).
async function fetchCallStatsByPhone(supabase) {
  // Notatki handlowca i ręczne zmiany akcji żyją w tej samej tabeli
  // (zrodlo: notatka_handlowca / manual_akcja, patrz POST /api/leady/notatka
  // i /api/leady/akcja w Backlogu) — to nie są telefony, nie liczymy ich.
  const { data, error } = await supabase.from(LOG_ZMIAN_TABLE).select('telefon,data_zmiany,zrodlo');
  if (error) throw error;
  const todayKey = new Date().toISOString().slice(0, 10);
  const map = new Map();
  (data || []).forEach((row) => {
    if (row['zrodlo'] === 'notatka_handlowca' || row['zrodlo'] === 'manual_akcja') return;
    const digits = normalizePhoneDigits(row['telefon']);
    if (!digits) return;
    const entry = map.get(digits) || { count: 0, dzisiaj: false };
    entry.count += 1;
    const rowKey = row['data_zmiany'] ? String(row['data_zmiany']).slice(0, 10) : null;
    if (rowKey === todayKey) entry.dzisiaj = true;
    map.set(digits, entry);
  });
  return map;
}

// Wspólne pobranie wszystkich leadów z polami wyliczanymi — używane przez
// GET /api/leady (widok) i POST /api/ai/query (dane dla AI), żeby AI widziało
// dokładnie te same wiersze/pola co użytkownik na ekranie.
async function fetchLeadyRows() {
  const supabase = getClient();
  const [leadyResult, wycenaByPhone, callStatsByPhone] = await Promise.all([
    supabase.from(LEADY_B2C_TABLE).select('*'),
    fetchWycenaByPhone(supabase),
    fetchCallStatsByPhone(supabase),
  ]);
  if (leadyResult.error) throw leadyResult.error;

  return (leadyResult.data || []).map((row) => {
    const digits = normalizePhoneDigits(row['Phone number']);
    const wycena = digits ? wycenaByPhone.get(digits) : undefined;
    const callStats = (digits && callStatsByPhone.get(digits)) || { count: 0, dzisiaj: false };
    return {
      ...row,
      _telefon_digits: digits,
      _telefon_formatted: formatPhonePlus(row['Phone number']),
      _ma_wycene: Boolean(wycena),
      _ilosc_polaczen: callStats.count,
      _kontakt_dzisiaj: callStats.dzisiaj,
    };
  });
}

// GET /api/leady — WSZYSTKIE leady (bez filtra daty/statusu jak w Backlogu),
// każdy wiersz ze wszystkimi surowymi kolumnami + info czy ma dopasowaną
// Wycenę B2C po telefonie (tylko sygnał "istnieje", bez linii produktowych —
// te dociąga się leniwie przez /api/leady/:telefon/wycena przy rozwinięciu).
app.get('/api/leady', async (req, res) => {
  try {
    const data = await fetchLeadyRows();
    res.json({ data, editableFields: EDITABLE_LEAD_FIELDS, readonlyFields: READONLY_LEAD_FIELDS });
  } catch (err) {
    handleError(res, err, 502);
  }
});

// PUT /api/leady/:idLeada — { field, value } — zapis JEDNEGO pola, zwykły
// update (celowo NIE przez RPC app_update_leady_after_call, która jest
// specyficzna dla webhooka Zadarmy) — dzięki temu istniejący trigger Postgresa
// trg_log_zmian_from_leady (patrz add-log-zmian-manual-capture.js) sam loguje
// zmianę do "Log zmian" z zrodlo='manual_crm', bez dodatkowego kodu tutaj.
//
// Klucz to "ID Leada" (unikalny, potwierdzone na żywych danych: 406/406
// unikalnych wartości), NIE numer telefonu — w "Leady B2C" 5 numerów
// telefonu jest dziś współdzielonych przez więcej niż jeden wiersz (duplikaty
// z historii importu/Make), więc `.eq('Phone number', ...)` update'owałby
// WSZYSTKIE pasujące wiersze naraz. "ID Leada" nie ma tego problemu.
app.put('/api/leady/:idLeada', async (req, res) => {
  try {
    const { field, value } = req.body || {};
    if (!EDITABLE_LEAD_FIELDS.includes(field)) {
      return res.status(400).json({ error: `Pole "${field}" nie jest edytowalne` });
    }
    const idLeada = Number(req.params.idLeada);
    if (!Number.isFinite(idLeada)) return res.status(400).json({ error: 'Brak parametru ID Leada' });

    const supabase = getClient();
    const { data: updated, error: updateErr } = await supabase
      .from(LEADY_B2C_TABLE)
      .update({ [field]: value === '' ? null : value })
      .eq('ID Leada', idLeada)
      .select('"ID Leada"');
    if (updateErr) throw updateErr;
    if (!updated || !updated.length) {
      return res.status(404).json({ error: 'Nie znaleziono leada o tym ID Leada' });
    }

    res.json({ ok: true });
  } catch (err) {
    handleError(res, err, 502);
  }
});

// GET /api/leady/:telefon/historia — kopia /api/log-polaczen/historia z
// Backlogu: cała historia połączeń/zmian tego telefonu, chronologicznie.
app.get('/api/leady/:telefon/historia', async (req, res) => {
  try {
    const supabase = getClient();
    const digits = normalizePhoneDigits(req.params.telefon);
    if (!digits) return res.status(400).json({ error: 'Brak parametru telefon' });
    const { data, error } = await supabase
      .from(LOG_ZMIAN_TABLE)
      .select('*')
      .eq('telefon', digits)
      .order('data_zmiany', { ascending: true });
    if (error) throw error;
    res.json({ data: data || [] });
  } catch (err) {
    handleError(res, err, 502);
  }
});

// GET /api/leady/:telefon/wycena — surowy wiersz Wyceny B2C dopasowany po
// telefonie, z produkty_json jako prawdziwą tablicą (nie spłaszczony string
// jak formatProdukty() w Backlogu) — do pokazania pełnej tabeli pozycji.
// Read-only z założenia: Wyceny B2C nigdy nie jest zapisywane przez żadną
// appkę, zasila ją Make/arkusz Google (patrz project-crm-lorenzzo-migration).
app.get('/api/leady/:telefon/wycena', async (req, res) => {
  try {
    const supabase = getClient();
    const digits = normalizePhoneDigits(req.params.telefon);
    if (!digits) return res.status(400).json({ error: 'Brak parametru telefon' });
    const { data, error } = await supabase.from(WYCENY_B2C_TABLE).select('*');
    if (error) throw error;
    const row = (data || []).find((r) => normalizePhoneDigits(r['Telefon']) === digits);
    res.json({ data: row || null });
  } catch (err) {
    handleError(res, err, 502);
  }
});

// ── AI: dyktowanie + uniwersalny filtr/odpowiedzi ───────────────────────────

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.1';
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';

function requireOpenAiKey() {
  if (!OPENAI_API_KEY) throw new Error('Brak OPENAI_API_KEY w konfiguracji serwera');
}

function warsawDateStr() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' }).format(new Date());
}

// OpenAI rozpoznaje format audio po rozszerzeniu nazwy pliku, nie po
// nagłówku Content-Type — nazwa musi pasować do faktycznego formatu.
// (Kopia sprawdzonego kodu z apps/backlog-b2c/server/server.js.)
const AUDIO_EXT_BY_TYPE = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/flac': 'flac',
};

async function transcribeAudioBuffer(buffer, contentType) {
  const ext = AUDIO_EXT_BY_TYPE[contentType] || 'mp3';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: contentType }), `audio.${ext}`);
  form.append('model', OPENAI_TRANSCRIBE_MODEL);
  form.append('language', 'pl');

  const aiRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });
  if (!aiRes.ok) {
    const body = await aiRes.text();
    throw new Error(`OpenAI ${aiRes.status}: ${body.slice(0, 300)}`);
  }
  const data = await aiRes.json();
  return data.text || '';
}

// Audio przychodzi jako surowe body (nie multipart) i NIE jest nigdzie
// zapisywane — leci prosto do transkrypcji OpenAI i przepada.
app.post('/api/transcribe', express.raw({ type: 'audio/*', limit: '8mb' }), async (req, res) => {
  try {
    requireOpenAiKey();
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'Brak nagrania' });
    const contentType = (req.headers['content-type'] || 'audio/webm').split(';')[0].trim();
    const text = await transcribeAudioBuffer(req.body, contentType);
    res.json({ text });
  } catch (err) {
    handleError(res, err, 502);
  }
});

// Rejestr sekcji CRM dla AI-filtra. Endpoint /api/ai/query i komponent na
// froncie są celowo uniwersalne (schema-driven): przyszła sekcja (CRM B2B,
// sprzedaż itd.) dodaje tu tylko wpis — skąd brać wiersze, które pole jest
// kluczem i które kolumny pomijać/skracać w prompcie. Nazw kolumn nigdzie
// się nie hardkoduje: prompt wylicza je z faktycznych danych, więc zmiana
// schematu w Supabase sama "dojeżdża" do AI.
const AI_SECTIONS = {
  'leady-b2c': {
    label: 'Leady B2C',
    idField: 'ID Leada',
    fetchRows: fetchLeadyRows,
    // szum, który tylko pali tokeny: długie identyfikatory/linki bez wartości
    // analitycznej + duplikaty telefonu (zostaje _telefon_formatted)
    omit: ['Facebook Leads ID', 'Link do formularza', '_telefon_digits', 'Phone number'],
    // długie pola tekstowe przycinamy — AI ma dostać sedno każdego leada,
    // a nie pełne transkrypcje wszystkich rozmów naraz
    truncate: { 'Treść rozmowy': 400, 'Ocena AI kontaktu': 400, Notes: 400, 'Produkty z wyceny': 200, 'Historia rozmów': 600 },
  },
};

function compactRowForAi(row, cfg) {
  const out = {};
  Object.entries(row).forEach(([key, value]) => {
    if (value === null || value === undefined || value === '') return;
    if (cfg.omit.includes(key)) return;
    const limit = cfg.truncate[key];
    out[key] = limit && typeof value === 'string' && value.length > limit
      ? `${value.slice(0, limit)}…`
      : value;
  });
  return out;
}

function buildAiQuerySystemPrompt(cfg, columns) {
  return `Jesteś asystentem CRM firmy LumLum (sprzedaż oświetlenia LED) i pomagasz handlowcom analizować leady. Dostajesz pełną listę rekordów sekcji "${cfg.label}" jako JSON oraz pytanie handlowca.

Dzisiejsza data: ${warsawDateStr()}.

Pola rekordów (nazwy dokładnie jak w danych): ${columns.join(', ')}. Pola zaczynające się od "_" są wyliczane systemowo: _ilosc_polaczen = liczba połączeń z klientem, _kontakt_dzisiaj = czy był kontakt dziś, _ma_wycene = czy istnieje wygenerowana wycena.

Odpowiedz WYŁĄCZNIE jednym obiektem JSON, bez markdownu i bez tekstu wokół:
{"ids": [wartości pola "${cfg.idField}" rekordów pasujących do pytania], "answer": "zwięzła odpowiedź po polsku"}

Zasady:
- "ids": rekordy, które widok ma pokazać po przefiltrowaniu. Jeśli pytanie wskazuje podzbiór (np. "zaległy feedback", "gorące leady", "do obdzwonienia dziś") — podaj ich ${cfg.idField}, posortowane od najważniejszego. Jeśli pytanie jest czysto statystyczne/ogólne i filtrowanie nie ma sensu — zwróć [].
- "answer": konkretna, praktyczna odpowiedź dla handlowca: liczby, imiona, numery ${cfg.idField}, daty, kwoty. Gdy pytanie dotyczy priorytetów (np. "do kogo najlepiej zadzwonić") — podaj uporządkowaną listę z jednym zdaniem uzasadnienia przy każdej pozycji. Zwykły tekst, może być z myślnikami i nowymi liniami; bez nagłówków markdown i bez ** **.
- Daty w danych bywają w formatach DD.MM.YYYY, ISO albo z godziną — interpretuj wszystkie; "zaległy feedback" = "Data Feedbacku" wcześniejsza niż dziś.
- Nie wymyślaj rekordów ani wartości, których nie ma w danych. Jeśli danych nie wystarcza, napisz to wprost w "answer".`;
}

// POST /api/ai/query — { section, question } → { ids, answer }
// Jedno wywołanie robi obie rzeczy naraz (decyzja Antoniego): zawęża listę
// (ids) ORAZ odpowiada tekstowo (answer) — front filtruje widok po ids
// i pokazuje answer w karcie.
app.post('/api/ai/query', async (req, res) => {
  try {
    requireOpenAiKey();
    const { section, question } = req.body || {};
    const cfg = AI_SECTIONS[section];
    if (!cfg) return res.status(400).json({ error: `Nieznana sekcja "${section}"` });
    if (!question || !String(question).trim()) return res.status(400).json({ error: 'Brak pytania' });

    const rows = await cfg.fetchRows();
    const compact = rows.map((row) => compactRowForAi(row, cfg));
    const columns = [...new Set(compact.flatMap((r) => Object.keys(r)))];

    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        // 'low' — pytania to głównie agregacja/wyszukiwanie po dostarczonych
        // danych; pełne myślenie gpt-5.1 przy ~400 rekordach w prompcie
        // potrafi trwać dziesiątki sekund (ten sam wzorzec co ai-edit
        // w Backlogu).
        reasoning_effort: 'low',
        messages: [
          { role: 'system', content: buildAiQuerySystemPrompt(cfg, columns) },
          { role: 'user', content: `Rekordy:\n${JSON.stringify(compact)}\n\nPytanie handlowca:\n${String(question).trim()}` },
        ],
      }),
    });
    if (!aiRes.ok) {
      const body = await aiRes.text();
      throw new Error(`OpenAI ${aiRes.status}: ${body.slice(0, 300)}`);
    }
    const aiBody = await aiRes.json();
    const content = aiBody.choices?.[0]?.message?.content || '';
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('AI nie zwróciło poprawnego JSON-a');
    const parsed = JSON.parse(content.slice(start, end + 1));

    res.json({
      ids: Array.isArray(parsed.ids) ? parsed.ids : [],
      answer: typeof parsed.answer === 'string' ? parsed.answer : '',
    });
  } catch (err) {
    handleError(res, err, 502);
  }
});

const PORT = process.env.PORT || 3002;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Serwer CRM działa na http://localhost:${PORT}`);
  });
}

module.exports = app;
