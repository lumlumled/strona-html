require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { getClient } = require('./supabase');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// KRYTYCZNE dla bramki hasła: res.sendFile() domyślnie ustawia
// "Cache-Control: public, max-age=0", co Vercel CDN traktuje jako
// zezwolenie na cache'owanie na brzegu sieci — i wtedy serwuje tę samą
// zapamiętaną odpowiedź (np. zalogowany widok "/") KAŻDEMU, także bez
// ciasteczka, całkowicie omijając middleware auth poniżej. Wszystko poza
// /assets musi być no-store.
app.use((req, res, next) => {
  if (!req.path.startsWith('/assets/')) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});

const SITE_PASSWORD = process.env.SITE_PASSWORD;
const COOKIE_NAME = 'lumlum_session';
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 dni

// Bez bazy użytkowników — jedno wspólne hasło. Token sesji jest podpisany
// HMAC-em (kluczem jest samo SITE_PASSWORD), więc jego ważność da się
// zweryfikować bezstanowo, bez trzymania listy sesji w pamięci procesu —
// ważne na serverless (Vercel), gdzie kolejne requesty mogą trafić do innej,
// nie współdzielącej pamięci instancji funkcji.
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
  if (SITE_PASSWORD && req.body.password === SITE_PASSWORD) {
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${createSessionToken()}; HttpOnly; Path=/; Max-Age=${SESSION_MAX_AGE_MS / 1000}; SameSite=Lax`
    );
    return res.redirect('/');
  }
  res.redirect('/login?error=1');
});

// Endpointy wołane przez zewnętrzne serwisy (webhook Zadarmy, Vercel Cron)
// nie mają ciasteczka sesji — mają własną autoryzację (podpis Zadarmy /
// CRON_SECRET), więc pomijają bramkę hasła.
const PUBLIC_API_PREFIXES = ['/api/webhooks/', '/api/cron/'];

app.use((req, res, next) => {
  if (PUBLIC_API_PREFIXES.some((p) => req.path.startsWith(p))) return next();
  if (isAuthenticated(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Wymagane zalogowanie' });
  return res.redirect('/login');
});

// Bez express.static — na Vercelu jest ignorowany (statyki trzeba serwować
// z public/**, a to zepsułoby bramkę hasła dla strony). sendFile działa
// wszędzie tak samo, więc zamiast tego jest zwykły route.
//
// Plik nazywa się app.html, NIE index.html: Vercel sprawdza filesystem
// PRZED rewrites (potwierdzone w ich dokumentacji — "precedence is given
// to the filesystem prior to rewrites being applied"). Gdyby leżał w
// katalogu głównym jako index.html, Vercel serwowałby go bezpośrednio dla
// "/" jako statyk, z pominięciem naszej funkcji i całej bramki hasła —
// dokładnie to się działo, dopóki plik nie został przemianowany.
app.get('/assets/:file', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'assets', req.params.file));
});
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'app.html'), { cacheControl: false });
});

function handleError(res, err, fallbackStatus = 400) {
  console.error(err);
  const message = err.message || 'Wewnętrzny błąd serwera';
  const status = /brak/i.test(message) ? 500 : fallbackStatus;
  res.status(status).json({ error: message });
}

// ── Edycja draftów przez AI (OpenAI) ────────────────────────────────────────
// Tabela nie ma kolumny `id` — identyfikatorem wiersza jest `Data`, dlatego
// te endpointy przyjmują surową wartość z kolumny (bywa "DD.MM.YYYY" albo
// ISO "YYYY-MM-DD" — frontend przekazuje ją dokładnie tak, jak stoi w wierszu).
const STANDUP_TABLE = 'Standup Log Lorenzo';
const TRANSCRIPT_FIELD = 'Transkrypcje - JSON';

const DOCS = {
  umowa: {
    draft: 'Umowa - draft - JSON',
    poprawka: 'Umowa - draft poprawka AI - JSON',
    final: 'Umowa - final - JSON',
  },
  podsumowanie: {
    draft: 'Podsumowanie dnia - draft - JSON',
    poprawka: 'Podsumowanie dnia - poprawka AI - JSON',
    final: 'Podsumowanie dnia - final - JSON',
  },
};

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.1';
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';

const PROMPT_INTRO = {
  umowa: 'Jesteś edytorem umowy dziennej LumLum. Dostajesz JSON umowy i polecenie użytkownika (często dyktowane głosowo — mogą być literówki).',
  podsumowanie: 'Jesteś edytorem podsumowania dnia LumLum. Dostajesz JSON podsumowania dnia i polecenie użytkownika (często dyktowane głosowo — mogą być literówki).',
};

function buildSystemPrompt(doc) {
  return `${PROMPT_INTRO[doc]} Zwróć WYŁĄCZNIE pełny, poprawiony JSON o tej samej strukturze. Zero tekstu poza nim.

## IDENTYFIKACJA CASE'A

Identyfikuj case'a w tej kolejności priorytetów:
1. Numer LP (najważniejszy) — "case 3", "LP 3", "trójka", "trzeci"
2. Imię i nazwisko (tolerancyjnie na literówki i dyktowanie głosowe)
3. Numer telefonu

Jeśli polecenie dotyczy case'a który jest w \`priorytet_dzis\` ORAZ w swojej kategorii — edytuj w obu miejscach jednocześnie.

## OPERACJE

**Edycja pola:**
"case 3, zmień status na Sprzedane" → zmień pole \`status\` obiektu z lp=3
"case 3, dopisz do opisu że czeka na elektryka" → dopisz na końcu pola \`opis\`
"case 3, feedback 15.07" → zmień \`data_feedbacku\` na "15.07.2026"
"case 3, kwota 2400" → zmień \`kwota\` na 2400
"case 3, zamknięty" → zmień \`zamkniete\` na 1

**Usunięcie z umowy:**
"wywal case 3" / "usuń case 3 z umowy" / "case 3 do kosza" → usuń obiekt z kategorii i z \`priorytet_dzis\` jeśli tam jest. Nie przeliczaj LP pozostałych.

**Przeniesienie między kategoriami:**
"case 3 przenieś do nieodebranych" → usuń z obecnej kategorii, dodaj do \`kategorie.nieodebrane\` z zachowaniem wszystkich pól. LP bez zmian.

**Dodanie nowego case'a:**
"dodaj case: Jan Kowalski, +48600123456, wycena wysłana, czeka na decyzję" → dodaj do \`kategorie.dodane_recznie\` (stwórz tablicę jeśli nie istnieje). Nadaj \`lp\` = najwyższy istniejący LP w całym dokumencie + 1. Dodaj wszystkie informacje które da się wyczytać. Pola których nie ma → "" lub 0. \`zamkniete\`: 0, \`zadzwonil_dzis\`: false.

**Aktualizacja komentarza dziennego:**
"zmień komentarz dzienny na [tekst]" → zastąp pole \`komentarz_dzienny\` na poziomie głównym
"dopisz do komentarza dziennego [tekst]" → dopisz zdanie na końcu

**Dodanie komentarza do case'a:**
"case 19, dodaj komentarz: [tekst]" / "dodaj komentarz do case'u 19, [tekst]" → wstaw na sam początek pola \`opis\` tego case'a fragment w formacie \`Komentarz od nas - [tekst] | \` (myślnik po "nas", spacja, pipe na końcu ze spacjami dookoła), a zaraz po nim dotychczasową treść \`opis\` bez zmian. Nie usuwaj i nie nadpisuj reszty opisu.

**Oznaczenie na jutro:**
"case 3 na jutro" → dodaj pole \`na_jutro: true\` do obiektu case'a

## ZASADY

- Edytuj TYLKO pola których dotyczy polecenie. Resztę przepisz znak w znak.
- Nie przeliczaj liczników w \`plan\` chyba że użytkownik wprost o to prosi.
- Nie przeliczaj LP innych case'ów po usunięciu.
- Zachowaj polskie znaki i formaty dat DD.MM.YYYY.
- Telefon zawsze w formacie +48XXXXXXXXX.
- Jeśli polecenie jest niejednoznaczne i możliwe są dwa różne case'y — zwróć JSON bez zmian i napisz jedną linię: "NIEJEDNOZNACZNE: doprecyzuj który case masz na myśli — LP[X] [imię] czy LP[Y] [imię]?"
- Jeśli podane LP nie istnieje w JSON — zwróć JSON bez zmian i napisz: "BŁĄD: case LP[N] nie istnieje w umowie."`;
}

function requireOpenAiKey() {
  if (!OPENAI_API_KEY) throw new Error('Brak OPENAI_API_KEY w konfiguracji serwera');
}

async function getRowByData(supabase, dataValue) {
  const { data, error } = await supabase
    .from(STANDUP_TABLE)
    .select('*')
    .eq('Data', dataValue)
    .limit(1);
  if (error) throw error;
  return data[0] || null;
}

async function updateRowByData(supabase, dataValue, patch) {
  const { data, error } = await supabase
    .from(STANDUP_TABLE)
    .update(patch)
    .eq('Data', dataValue)
    .select();
  if (error) throw error;
  if (!data.length) throw new Error('Wiersz nie istnieje');
  return data[0];
}

// Log poleceń w kolumnie "Transkrypcje - JSON" — jeśli kolumny (jeszcze) nie ma
// w Supabase, nie blokujemy edycji, tylko logujemy ostrzeżenie.
async function appendTranscript(supabase, row, dataValue, doc, tekst) {
  try {
    const existing = Array.isArray(row[TRANSCRIPT_FIELD]) ? row[TRANSCRIPT_FIELD] : [];
    existing.push({ czas: new Date().toISOString(), doc, tekst });
    await updateRowByData(supabase, dataValue, { [TRANSCRIPT_FIELD]: existing });
  } catch (err) {
    console.warn(`Nie zapisano logu do "${TRANSCRIPT_FIELD}" (kolumna istnieje?):`, err.message);
  }
}

app.post('/api/ai-edit', async (req, res) => {
  try {
    requireOpenAiKey();
    const { doc, dataValue, instruction } = req.body || {};
    const fields = DOCS[doc];
    if (!fields) return res.status(400).json({ error: 'Nieznany typ dokumentu' });
    if (!dataValue || !instruction || !String(instruction).trim()) {
      return res.status(400).json({ error: 'Brak daty lub treści polecenia' });
    }

    const supabase = getClient();
    const row = await getRowByData(supabase, dataValue);
    if (!row) return res.status(404).json({ error: `Brak wiersza dla daty ${dataValue}` });

    const current = row[fields.poprawka] ?? row[fields.draft];
    if (!current) return res.status(404).json({ error: 'Brak draftu do edycji dla tego dnia' });

    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: buildSystemPrompt(doc) },
          { role: 'user', content: `Aktualny JSON:\n${JSON.stringify(current, null, 2)}\n\nPolecenie:\n${instruction}` },
        ],
      }),
    });
    if (!aiRes.ok) {
      const body = await aiRes.text();
      throw new Error(`OpenAI ${aiRes.status}: ${body.slice(0, 300)}`);
    }
    const aiBody = await aiRes.json();
    const content = aiBody.choices?.[0]?.message?.content || '';

    // Prompt każe modelowi zgłaszać niejednoznaczności/nieistniejące LP jako
    // linię tekstu — wtedy nic nie zapisujemy, tylko oddajemy komunikat.
    const notice = content.match(/(NIEJEDNOZNACZNE|BŁĄD):[^\n]*/);
    if (notice) {
      await appendTranscript(supabase, row, dataValue, doc, instruction);
      return res.json({ message: notice[0] });
    }

    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('AI nie zwróciło poprawnego JSON-a');
    let parsed;
    try {
      parsed = JSON.parse(content.slice(start, end + 1));
    } catch {
      throw new Error('AI zwróciło JSON, którego nie da się sparsować');
    }
    if (!parsed || typeof parsed !== 'object' || (!parsed.kategorie && !parsed.plan)) {
      throw new Error('Odpowiedź AI nie wygląda na dokument (brak "kategorie"/"plan")');
    }

    // Model czasem zwraca JSON bez zmian zamiast linii BŁĄD/NIEJEDNOZNACZNE —
    // wtedy nie ma czego zapisywać, a użytkownik powinien dostać sygnał.
    if (JSON.stringify(parsed) === JSON.stringify(current)) {
      await appendTranscript(supabase, row, dataValue, doc, instruction);
      return res.json({ message: 'AI nie wprowadziło żadnych zmian — doprecyzuj polecenie.' });
    }

    await updateRowByData(supabase, dataValue, { [fields.poprawka]: parsed });
    await appendTranscript(supabase, row, dataValue, doc, instruction);
    res.json({ json: parsed });
  } catch (err) {
    handleError(res, err, 502);
  }
});

app.post('/api/approve', async (req, res) => {
  try {
    const { doc, dataValue } = req.body || {};
    const fields = DOCS[doc];
    if (!fields) return res.status(400).json({ error: 'Nieznany typ dokumentu' });
    if (!dataValue) return res.status(400).json({ error: 'Brak daty' });

    const supabase = getClient();
    const row = await getRowByData(supabase, dataValue);
    if (!row) return res.status(404).json({ error: `Brak wiersza dla daty ${dataValue}` });

    const final = row[fields.poprawka] ?? row[fields.draft];
    if (!final) return res.status(404).json({ error: 'Brak draftu do zatwierdzenia' });

    await updateRowByData(supabase, dataValue, { [fields.final]: final });
    res.json({ json: final });
  } catch (err) {
    handleError(res, err, 502);
  }
});

// Ręczna edycja pojedynczego pola case'a (status / data feedbacku) z listy —
// bez AI, zapisuje się od razu do tej wersji dokumentu, którą aktualnie widać
// (draft / poprawka / final), niezależnie od przepływu draft→poprawka→final.
const LEAD_FIELD_ALLOWLIST = ['status', 'data_feedbacku'];

function updateLeadInJson(json, lp, field, value) {
  let updated = false;
  const applyToArray = (arr) => {
    if (!Array.isArray(arr)) return;
    arr.forEach((item) => {
      if (item && Number(item.lp) === Number(lp)) {
        item[field] = value;
        updated = true;
      }
    });
  };
  applyToArray(json.priorytet_dzis);
  if (json.kategorie && typeof json.kategorie === 'object') {
    Object.values(json.kategorie).forEach(applyToArray);
  }
  return updated;
}

app.post('/api/lead-field', async (req, res) => {
  try {
    const { doc, dataValue, state, lp, field, value } = req.body || {};
    const fields = DOCS[doc];
    if (!fields) return res.status(400).json({ error: 'Nieznany typ dokumentu' });
    if (!LEAD_FIELD_ALLOWLIST.includes(field)) return res.status(400).json({ error: 'Niedozwolone pole' });
    const column = fields[state];
    if (!column) return res.status(400).json({ error: 'Nieznany stan dokumentu' });
    if (!dataValue || lp === undefined || lp === null) return res.status(400).json({ error: 'Brak daty lub numeru LP' });

    const supabase = getClient();
    const row = await getRowByData(supabase, dataValue);
    if (!row) return res.status(404).json({ error: `Brak wiersza dla daty ${dataValue}` });

    const json = row[column];
    if (!json) return res.status(404).json({ error: 'Brak dokumentu do edycji' });

    const updated = updateLeadInJson(json, lp, field, value);
    if (!updated) return res.status(404).json({ error: `Nie znaleziono case'a LP ${lp}` });

    await updateRowByData(supabase, dataValue, { [column]: json });
    res.json({ json });
  } catch (err) {
    handleError(res, err, 502);
  }
});

// OpenAI rozpoznaje format audio po rozszerzeniu nazwy pliku, nie po
// nagłówku Content-Type — nazwa musi pasować do faktycznego formatu.
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

// ── Webhook Zadarmy (przychodzące/wychodzące/nieodebrane) ───────────────────
// Rejestrowany bezpośrednio w Zadarma, NIE przez Make — patrz plan migracji,
// etap "cutover". Kształt payloadu potwierdzony na PRAWDZIWYCH webhookach
// (nie z dokumentacji): tablica z jednym obiektem, pola caller_id/called_did
// (przychodzące) albo caller_id/dst (wychodzące), is_recorded:boolean,
// record_url gotowy do pobrania bez dodatkowej autoryzacji, BRAK pola
// signature (ten webhook nic nie podpisuje) i BRAK pola disposition —
// "odebrane vs nieodebrane" wnioskujemy z obecności record_url/duration.
// Zabezpieczenie: sekretny token w query stringu URL-a zarejestrowanego w
// Zadarmie (?token=...), sprawdzany tu zamiast podpisu HMAC.
async function summarizeCall(transcript, fallbackLabel) {
  if (!OPENAI_API_KEY) return transcript ? transcript.slice(0, 200) : fallbackLabel;
  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          {
            role: 'system',
            content: 'Podsumuj rozmowę handlową w maks. 2 zdaniach po polsku, konkretnie (co klient powiedział, na czym stoi sprawa). Zero wstępów.',
          },
          { role: 'user', content: transcript || `(brak transkrypcji, status połączenia: ${fallbackLabel})` },
        ],
      }),
    });
    if (!aiRes.ok) return transcript ? transcript.slice(0, 200) : fallbackLabel;
    const body = await aiRes.json();
    return body.choices?.[0]?.message?.content?.trim() || (transcript || fallbackLabel);
  } catch {
    return transcript ? transcript.slice(0, 200) : fallbackLabel;
  }
}

function normalizePhoneDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

async function findLeadByPhone(supabase, phoneDigits) {
  if (!phoneDigits) return null;
  const { data, error } = await supabase
    .from(LEADY_B2C_TABLE)
    .select('*')
    .eq('Phone number', Number(phoneDigits))
    .limit(1);
  if (error) throw error;
  return data[0] || null;
}

// Wyceny B2C nie ma kolumn do śledzenia kontaktu (Ilość telefonów/Ostatni
// kontakt/Treść rozmowy) jak Leady B2C — celowo, to czysty odzwierciedlenie
// arkusza synchronizowane przez Make. To dopasowanie służy WYŁĄCZNIE do
// oznaczenia w Log zmian, że telefon należy do wyceny, a nie do leada —
// żadnego zapisu zwrotnego do tej tabeli.
async function findWycenaByPhone(supabase, phoneDigits) {
  if (!phoneDigits) return null;
  const { data, error } = await supabase
    .from(WYCENY_B2C_TABLE)
    .select('*')
    .eq('Telefon', Number(phoneDigits))
    .limit(1);
  if (error) throw error;
  return data[0] || null;
}

const AUTOMATION_LOG_TABLE = 'Logi automatyzacji';

async function logOperation(supabase, automatyzacja, status, szczegoly) {
  // supabase-js NIE rzuca wyjątku dla typowych błędów zapytania (np. brak
  // tabeli) — zwraca { error } bez throw. Trzeba sprawdzić jawnie, inaczej
  // to try/catch nigdy się nie uruchomi i błąd przepadnie po cichu.
  try {
    const { error } = await supabase.from(AUTOMATION_LOG_TABLE).insert({ automatyzacja, status, szczegoly });
    if (error) {
      console.warn(`Nie zapisano logu automatyzacji "${automatyzacja}" (tabela istnieje?):`, error.message);
    }
  } catch (err) {
    console.warn(`Nie zapisano logu automatyzacji "${automatyzacja}":`, err.message);
  }
}

app.post('/api/webhooks/zadarma', express.json(), async (req, res) => {
  const supabase = getClient();
  try {
    if (req.query.token !== process.env.ZADARMA_WEBHOOK_TOKEN) {
      return res.status(403).json({ error: 'Nieprawidłowy token' });
    }

    const call = Array.isArray(req.body) ? req.body[0] : req.body;
    if (!call) return res.status(400).json({ error: 'Puste zdarzenie' });

    const ownNumber = normalizePhoneDigits(process.env.ZADARMA_OWN_NUMBER);
    const candidates = [call.caller_id, call.called_did, call.dst]
      .map(normalizePhoneDigits)
      .filter((d) => d && d !== ownNumber);
    const customerDigits = candidates[0] || '';

    let lead = await findLeadByPhone(supabase, customerDigits);
    // Wyceny B2C sprawdzane tylko gdy telefon nie pasuje do żadnego leada —
    // Leady B2C ma pierwszeństwo, bo to tam dzieje się faktyczna obsługa CRM.
    const wycena = lead ? null : await findWycenaByPhone(supabase, customerDigits);

    const answered = Boolean(call.record_url);
    let transcript = '';
    if (answered) {
      try {
        const audioRes = await fetch(call.record_url);
        const buffer = Buffer.from(await audioRes.arrayBuffer());
        transcript = await transcribeAudioBuffer(buffer, 'audio/mpeg');
      } catch (err) {
        console.warn('Nie udało się pobrać/transkrybować nagrania:', err.message);
      }
    }

    const label = answered ? 'answered' : 'no_answer';
    const opis = await summarizeCall(transcript, label);
    const statusBefore = lead ? lead['Deal stage'] : wycena ? wycena['Status'] : null;

    const { error: insertErr } = await supabase.from(LOG_ZMIAN_TABLE).insert({
      zrodlo: 'zadarma_webhook',
      telefon: customerDigits || null,
      status_przed: statusBefore,
      status_po: statusBefore,
      opis,
      czas_trwania_s: Number(call.duration) || 0,
      disposition: label,
      pbx_call_id: call.pbx_call_id || null,
      dopasowano_tabela: lead ? LEADY_B2C_TABLE : wycena ? WYCENY_B2C_TABLE : null,
      dopasowano_id: lead ? String(lead['ID'] ?? '') : wycena ? wycena['ID'] : null,
    });
    if (insertErr) console.error('Błąd zapisu Log zmian:', insertErr.message);

    if (lead) {
      const { error: updateErr } = await supabase
        .from(LEADY_B2C_TABLE)
        .update({
          'Ilość telefonów': (Number(lead['Ilość telefonów']) || 0) + 1,
          'Ostatni kontakt': call.callstart || null,
          'Treść rozmowy': transcript || lead['Treść rozmowy'] || null,
        })
        .eq('Phone number', lead['Phone number']);
      if (updateErr) console.error('Błąd update Leady B2C:', updateErr.message);
    }

    await logOperation(supabase, 'zadarma_webhook', 'ok', {
      pbx_call_id: call.pbx_call_id,
      telefon: customerDigits,
      dopasowano_leada: Boolean(lead),
      dopasowano_wycene: Boolean(wycena),
      transkrypcja: Boolean(transcript),
    });
    res.json({ status: 'ok' });
  } catch (err) {
    await logOperation(supabase, 'zadarma_webhook', 'error', { message: err.message, body: req.body });
    handleError(res, err, 502);
  }
});

// Żywy widok "Nowe" — leady ze statusem Nowy z ostatnich 7 dni, czytane
// bezpośrednio z Supabase "Leady B2C" (nie z raz-dziennie generowanej Umowy),
// żeby świeży lead był widoczny w panelu natychmiast. Kolumna "Date" w tej
// tabeli bywa zapisana w różnych formatach (długi angielski jak
// "March 19, 2026", ISO, DD.MM.YYYY) — stąd parsowanie w JS zamiast filtra
// SQL po dacie.
const LEADY_B2C_TABLE = 'Leady B2C';
const LOG_ZMIAN_TABLE = 'Log zmian';
const WYCENY_B2C_TABLE = 'Wyceny B2C';

function parseLeadDate(value) {
  if (!value) return null;
  const asDate = new Date(value);
  if (!Number.isNaN(asDate.getTime())) return asDate;
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(String(value).trim());
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return null;
}

app.get('/api/leady/nowe', async (req, res) => {
  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from(LEADY_B2C_TABLE)
      .select('*')
      .eq('Deal stage', 'Nowy');
    if (error) throw error;

    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const rows = (data || [])
      .map((row) => ({ row, date: parseLeadDate(row['Date']) }))
      .filter(({ date }) => date && date.getTime() >= cutoff)
      .sort((a, b) => b.date - a.date)
      .map(({ row }) => ({
        telefon: row['Phone number'] ? `+${row['Phone number']}` : '',
        imie: row['Name'] || '',
        email: row['Email'] || '',
        status: row['Deal stage'] || '',
        opis: row['Notes'] || '',
        data_feedbacku: row['Data Feedbacku'] || '',
        temperatura: row['Temperatura'] || '',
        ostatni_kontakt: row['Ostatni kontakt'] || '',
        ilosc_telefonow: row['Ilość telefonów'] || 0,
        produkty: row['Produkty z wyceny'] || '',
        ocena_ai: row['Ocena AI kontaktu'] || '',
        link_formularz: row['Link do formularza'] || '',
        data_wyceny: row['Data wysłania wyceny'] || '',
        id_wyceny: row['ID Wyceny'] || '',
        kwota: row['Kwota wyceny'] || 0,
        zadzwonil_dzis: false,
        zamkniete: 0,
      }));
    res.json(rows);
  } catch (err) {
    handleError(res, err, 502);
  }
});

app.get('/api/tables/:table', async (req, res) => {
  try {
    const supabase = getClient();
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const { data, error } = await supabase
      .from(req.params.table)
      .select('*')
      .limit(limit);
    if (error) throw error;
    res.json(data);
  } catch (err) {
    handleError(res, err, 502);
  }
});

app.post('/api/tables/:table', async (req, res) => {
  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from(req.params.table)
      .insert(req.body)
      .select();
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    handleError(res, err, 502);
  }
});

app.put('/api/tables/:table/:id', async (req, res) => {
  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from(req.params.table)
      .update(req.body)
      .eq('id', req.params.id)
      .select();
    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Wiersz nie istnieje' });
    res.json(data[0]);
  } catch (err) {
    handleError(res, err, 502);
  }
});

app.delete('/api/tables/:table/:id', async (req, res) => {
  try {
    const supabase = getClient();
    const { error, count } = await supabase
      .from(req.params.table)
      .delete({ count: 'exact' })
      .eq('id', req.params.id);
    if (error) throw error;
    if (!count) return res.status(404).json({ error: 'Wiersz nie istnieje' });
    res.status(204).end();
  } catch (err) {
    handleError(res, err, 502);
  }
});

// Na Vercelu moduł jest tylko importowany (jako Vercel Function), nigdy
// uruchamiany bezpośrednio — listen() ma się odpalać tylko lokalnie.
if (require.main === module) {
  const port = process.env.PORT || 3001;
  app.listen(port, () => {
    console.log(`Serwer działa na http://localhost:${port}`);
  });
}

module.exports = app;
