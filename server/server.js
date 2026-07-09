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
    const opisBefore = lead ? lead['Notes'] : wycena ? wycena['Komentarz'] : null;
    const feedbackBefore = lead ? lead['Data Feedbacku'] : wycena ? wycena['Data Feedbacku'] : null;
    // called_did = numer, na który zadzwonił klient (przychodzące); dst = numer,
    // który wykręcił handlowiec (wychodzące) — patrz komentarz o kształcie payloadu wyżej.
    const kierunek = call.called_did ? 'przychodzące' : call.dst ? 'wychodzące' : null;

    const { error: insertErr } = await supabase.from(LOG_ZMIAN_TABLE).insert({
      zrodlo: 'zadarma_webhook',
      telefon: customerDigits || null,
      status_przed: statusBefore,
      status_po: statusBefore,
      opis,
      opis_przed: opisBefore,
      opis_po: opisBefore,
      data_feedbacku_przed: feedbackBefore,
      data_feedbacku_po: feedbackBefore,
      kierunek,
      transkrypcja: transcript || null,
      handlowiec: process.env.DEFAULT_HANDLOWIEC || null,
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

// app.html oczekuje dat w polu data_feedbacku wyłącznie jako "DD.MM.YYYY"
// (parsePlDate/toIsoDate w froncie mają sztywny regex na ten format — inny
// format, np. surowe "2026-05-14 00:00:00" jakie bywa w kolumnie "Data
// Feedbacku" w Leady B2C, po prostu nie renderuje się w polu daty). Zawsze
// normalizujemy do tego formatu przed wysłaniem do frontu.
function formatPlDate(value) {
  const d = parseLeadDate(value);
  if (!d) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
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

// ── Umowa Lorenzo Draft (cron dzienny) ──────────────────────────────────────
// Odtworzenie scenariusza Make "Umowa Lorenzo Draft" (id 6316850) jako
// endpoint wołany przez Vercel Cron. W stosunku do oryginału: dane mapowane
// po nazwach kolumn Supabase (nie po indeksach Sheets — oryginał miał tu
// rozjechane indeksy w jednej gałęzi), zapis do "Standup Log Lorenzo" jest
// upsertem po "Data" (oryginał robił zwykły insert mimo że "Data" jest
// naturalnym kluczem — dwa uruchomienia dziennie by kolidowały), a
// "zadzwonil_dzis"/"zadzwoniono_dzis" liczone deterministycznie w kodzie z
// prawdziwego "Log zmian" (oryginał czytał tu po raz drugi wczorajszy log
// zamiast dzisiejszych połączeń — nigdy faktycznie nie działało).
const UMOWA_MODEL = process.env.OPENAI_UMOWA_MODEL || 'gpt-5-mini';

function warsawParts(date = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Warsaw', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return {
    y: Number(parts.year), m: Number(parts.month), d: Number(parts.day),
    hh: parts.hour, mm: parts.minute, ss: parts.second,
  };
}

function warsawDateStr(date = new Date()) {
  const { y, m, d } = warsawParts(date);
  return `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`;
}

function warsawTimeStr(date = new Date()) {
  const { hh, mm } = warsawParts(date);
  return `${hh}:${mm}`;
}

// Instant UTC odpowiadający północy danego dnia kalendarzowego w Warszawie —
// potrzebne, żeby filtrować "data_zmiany::date = dziś" poprawnie mimo
// przesunięcia CET/CEST, bez indeksowania rzutowania timestamptz→date w
// Postgresie (Postgres to odrzuca, patrz notatka w migracji CRM Lorenzzo).
function warsawMidnightUTC(y, m, d) {
  const guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Warsaw', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(guess).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const asIfUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  const offsetMinutes = (asIfUTC - guess.getTime()) / 60000;
  return new Date(guess.getTime() - offsetMinutes * 60000);
}

function warsawDayRange(offsetDays = 0) {
  const { y, m, d } = warsawParts(new Date());
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + offsetDays);
  const start = warsawMidnightUTC(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate());
  const end = warsawMidnightUTC(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate() + 1);
  return { start, end };
}

function formatPhonePlus(raw) {
  const digits = normalizePhoneDigits(raw);
  if (!digits) return '';
  return digits.startsWith('48') ? `+${digits}` : `+48${digits}`;
}

// Leady B2C i Wyceny B2C nie mają wspólnego klucza obcego — "ID Wyceny" w
// Leady B2C to mały sekwencyjny numer własny tej tabeli (1, 3, 4…), a "ID" w
// Wyceny B2C to zupełnie inna numeracja ("#1529", "#1815"…). Jedyne wspólne
// pole to numer telefonu (tak samo dopasowuje leady do wycen webhook Zadarmy
// — patrz findWycenaByPhone). Budujemy więc mapę telefon → sformatowane
// produkty raz, dla wszystkich kategorii naraz.
function formatProdukty(produktyJson) {
  if (!Array.isArray(produktyJson) || !produktyJson.length) return '';
  return produktyJson
    .map((p) => {
      const qty = p && p.quantity !== undefined ? p.quantity : '';
      const unit = (p && p.unit) || '';
      const name = (p && p.name) || '';
      return [qty, unit, name].filter((part) => part !== '' && part !== undefined && part !== null).join(' ');
    })
    .filter(Boolean)
    .join('; ');
}

async function fetchProduktyByPhone(supabase) {
  const { data, error } = await supabase.from(WYCENY_B2C_TABLE).select('Telefon,produkty_json');
  if (error) throw error;
  const map = new Map();
  (data || []).forEach((row) => {
    const digits = normalizePhoneDigits(row['Telefon']);
    const formatted = formatProdukty(row['produkty_json']);
    if (digits && formatted && !map.has(digits)) map.set(digits, formatted);
  });
  return map;
}

function mapLeadRow(row, produktyByPhone) {
  const phoneDigits = normalizePhoneDigits(row['Phone number']);
  const produktyZWyceny = produktyByPhone && phoneDigits ? produktyByPhone.get(phoneDigits) : undefined;
  return {
    id: row['ID'] || '',
    id_wyceny: row['ID Wyceny'] ?? '',
    data_dolaczenia: row['Date'] || '',
    imie: row['Name'] || '',
    telefon: formatPhonePlus(row['Phone number']),
    email: row['Email'] || '',
    status: row['Deal stage'] || '',
    opis: row['Notes'] || '',
    data_feedbacku: formatPlDate(row['Data Feedbacku']),
    temperatura: row['Temperatura'] || '',
    ostatni_kontakt: row['Ostatni kontakt'] || '',
    // "Ilość telefonów" ma w Supabase legacy skażone dane sprzed poprawki
    // string-konkatenacji (np. "12440" zamiast realnej liczby) — puste na
    // razie, do policzenia porządnie osobno.
    ilosc_telefonow: '',
    produkty: produktyZWyceny || row['Produkty z wyceny'] || '',
    ocena_ai: row['Ocena AI kontaktu'] || '',
    link_formularz: row['Link do formularza'] || '',
    data_wyceny: row['Data wysłania wyceny'] || '',
    kwota: Number(row['Kwota wyceny']) || 0,
  };
}

function mapWycenaRow(row) {
  return {
    id_wyceny: row['ID'] || '',
    data_stworzenia: row['Data stworzenia'] || '',
    data_feedbacku: formatPlDate(row['Data Feedbacku']),
    komentarz: row['Komentarz'] || '',
    typ: row['Typ'] || '',
    status: row['Status'] || '',
    imie: row['Imię'] || '',
    telefon: formatPhonePlus(row['Telefon']),
    email: row['Email'] || '',
    link_formularz: row['Link do formularza'] || '',
    kwota: Number(row['Kwota']) || 0,
  };
}

async function fetchLeadyByStage(supabase, stage, excludeStages) {
  let query = supabase.from(LEADY_B2C_TABLE).select('*');
  query = excludeStages
    ? query.not('Deal stage', 'in', `(${excludeStages.map((s) => `"${s}"`).join(',')})`)
    : query.eq('Deal stage', stage);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function fetchNowe(supabase, produktyByPhone) {
  const rows = await fetchLeadyByStage(supabase, 'Nowy');
  const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
  return rows
    .map((row) => ({ row, date: parseLeadDate(row['Date']) }))
    .filter(({ date }) => date && date.getTime() >= cutoff)
    .sort((a, b) => b.date - a.date)
    .slice(0, 10)
    .map(({ row }) => mapLeadRow(row, produktyByPhone));
}

async function fetchWycenyZFeedbackiem(supabase, produktyByPhone) {
  const rows = await fetchLeadyByStage(supabase, 'Wycena wysłana');
  const now = Date.now();
  return rows
    .map((row) => ({ row, date: parseLeadDate(row['Data Feedbacku']) }))
    .filter(({ date }) => date && date.getTime() <= now)
    .sort((a, b) => a.date - b.date || Number(b.row['Kwota wyceny'] || 0) - Number(a.row['Kwota wyceny'] || 0))
    .map(({ row }) => mapLeadRow(row, produktyByPhone));
}

async function fetchInneZFeedbackiem(supabase, produktyByPhone) {
  const rows = await fetchLeadyByStage(supabase, null, ['Wycena wysłana', 'Stracony', 'Sprzedane']);
  const now = Date.now();
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;
  return rows
    .map((row) => ({ row, date: parseLeadDate(row['Data Feedbacku']) }))
    .filter(({ date }) => date && date.getTime() <= now && date.getTime() >= cutoff)
    .sort((a, b) => a.date - b.date || Number(b.row['Kwota wyceny'] || 0) - Number(a.row['Kwota wyceny'] || 0))
    .map(({ row }) => mapLeadRow(row, produktyByPhone));
}

async function fetchNieodebrane(supabase, produktyByPhone) {
  const rows = await fetchLeadyByStage(supabase, 'Nie odebrał');
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return rows
    .map((row) => ({ row, date: parseLeadDate(row['Date']) }))
    .filter(({ date }) => date && date.getTime() >= cutoff)
    .sort((a, b) => (Number(b.row['Ilość telefonów']) || 0) - (Number(a.row['Ilość telefonów']) || 0) || a.date - b.date)
    .slice(0, 10)
    .map(({ row }) => mapLeadRow(row, produktyByPhone));
}

async function fetchWycenyHistoryczne(supabase) {
  const { data: allRows, error } = await supabase.from(WYCENY_B2C_TABLE).select('*');
  if (error) throw error;
  const now = Date.now();
  const withFeedback = (allRows || [])
    .map((row) => ({ row, date: parseLeadDate(row['Data Feedbacku']) }))
    .filter(({ date }) => date && date.getTime() <= now)
    .map(({ row }) => row);

  const usedIds = new Set(withFeedback.map((r) => r['ID']));
  const openOldestFirst = (allRows || [])
    .filter((row) => row['Status'] === 'Open' && !usedIds.has(row['ID']))
    .map((row) => ({ row, date: parseLeadDate(row['Data stworzenia']) }))
    .sort((a, b) => (a.date?.getTime() || 0) - (b.date?.getTime() || 0))
    .map(({ row }) => row);

  return [...withFeedback, ...openOldestFirst].slice(0, 10).map(mapWycenaRow);
}

// Siatka bezpieczeństwa: WSZYSTKIE leady z przeterminowanym feedbackiem,
// niezależnie od statusu i bez limitu 7 dni wstecz — inne kategorie
// (wyceny_z_feedbackiem, inne_z_feedbackiem) mają limit dni/max 8 do
// wyświetlenia, więc stary, zapomniany case może z nich całkowicie zniknąć.
// Ta lista nie jest ograniczona i nie jest kategoryzowana przez model —
// dopasowanie/numeracja LP dzieje się deterministycznie w applyZalegleFeedbacki.
async function fetchZalegleFeedbacki(supabase, produktyByPhone) {
  const { data, error } = await supabase
    .from(LEADY_B2C_TABLE)
    .select('*')
    .not('Deal stage', 'in', '("Sprzedane","Stracony")');
  if (error) throw error;
  const now = Date.now();
  const sorted = (data || [])
    .map((row) => ({ row, date: parseLeadDate(row['Data Feedbacku']) }))
    .filter(({ date }) => date && date.getTime() <= now)
    .sort((a, b) => a.date - b.date);

  // Facebook Lead Ads potrafi wysłać ten sam formularz dwa razy (retry
  // webhooka) — Leady B2C wtedy ma dwa wiersze z tym samym telefonem.
  // Zostawiamy pierwsze wystąpienie (najstarszy feedback), żeby ten sam
  // człowiek nie pojawił się w tej kategorii dwa razy pod tym samym lp.
  const seenPhones = new Set();
  const deduped = [];
  sorted.forEach(({ row }) => {
    const digits = normalizePhoneDigits(row['Phone number']);
    if (digits && seenPhones.has(digits)) return;
    if (digits) seenPhones.add(digits);
    deduped.push(row);
  });

  return deduped.map((row) => mapLeadRow(row, produktyByPhone));
}

async function fetchLogZmianRange(supabase, start, end) {
  const { data, error } = await supabase
    .from(LOG_ZMIAN_TABLE)
    .select('*')
    .gte('data_zmiany', start.toISOString())
    .lt('data_zmiany', end.toISOString())
    .order('data_zmiany', { ascending: false });
  if (error) throw error;
  return (data || []).map((row) => ({
    telefon: formatPhonePlus(row['telefon']),
    data_zmiany: row['data_zmiany'],
    status_przed: row['status_przed'] || '',
    status_po: row['status_po'] || '',
    opis: row['opis'] || '',
    czas_trwania_s: row['czas_trwania_s'] || 0,
    disposition: row['disposition'] || '',
  }));
}

async function fetchStandupLog3(supabase) {
  const { data, error } = await supabase
    .from(STANDUP_TABLE)
    .select('*')
    .order('Data', { ascending: false })
    .limit(3);
  if (error) throw error;
  return (data || []).map((row) => {
    const umowa = row[DOCS.umowa.final] || row[DOCS.umowa.poprawka] || row[DOCS.umowa.draft];
    const podsumowanie = row[DOCS.podsumowanie.final] || row[DOCS.podsumowanie.poprawka] || row[DOCS.podsumowanie.draft];
    return {
      data: row['Data'],
      komentarz_dzienny_poprzedniej_umowy: umowa?.komentarz_dzienny || '',
      podsumowanie_dnia: podsumowanie || null,
    };
  });
}

function buildCalledTodaySet(logZmianDzis) {
  const set = new Set();
  logZmianDzis.forEach((row) => {
    const digits = normalizePhoneDigits(row.telefon);
    if (digits) set.add(digits);
  });
  return set;
}

// GPT dostaje dzisiejszy log połączeń jako kontekst do narracji
// (komentarz_dzienny/kontekst), ale same flagi zadzwonil_dzis/liczbę
// zadzwoniono_dzis liczymy tu deterministycznie po dopasowaniu telefonu —
// nie ufamy arytmetyce modelu na tym polu.
function postProcessCalledToday(parsed, calledSet) {
  const patch = (arr) => {
    if (!Array.isArray(arr)) return;
    arr.forEach((item) => {
      if (item && typeof item === 'object' && 'telefon' in item) {
        item.zadzwonil_dzis = calledSet.has(normalizePhoneDigits(item.telefon));
      }
    });
  };
  patch(parsed.priorytet_dzis);
  if (parsed.kategorie && typeof parsed.kategorie === 'object') {
    Object.values(parsed.kategorie).forEach(patch);
  }
  if (parsed.plan && typeof parsed.plan === 'object') {
    parsed.plan.zadzwoniono_dzis = calledSet.size;
  }
}

// Wstawia kategorię "zalegle_feedbacki" (patrz fetchZalegleFeedbacki) do
// wyniku modelu. Jeśli dany lead (po telefonie) już gdzieś w dokumencie ma
// przydzielony LP — dostaje TEN SAM LP zamiast nowego. Dzięki temu
// leadInstancesByLp w app.html (mechanizm zbudowany pierwotnie dla
// priorytet_dzis + jego kategorii) automatycznie linkuje oba wystąpienia:
// zamknięcie case'a w jednym miejscu zamyka go też tu, bez żadnych zmian we
// froncie. Leady, które nigdzie indziej się nie pojawiły, dostają świeży LP
// kontynuujący istniejącą numerację.
// Model potrafi przydzielić TEN SAM lp dwóm różnym osobom w różnych
// kategoriach (złapane w testach: lp=2 jednocześnie dla dwóch różnych
// leadów) — groźne, bo /api/lead-field aktualizuje WSZYSTKIE obiekty z danym
// lp naraz, więc taka kolizja realnie nadpisywałaby dane niepowiązanego
// case'a. LP liczymy więc od zera, wyłącznie w kodzie: każdy obiekt w
// głównych 5 kategoriach (w stałej kolejności) dostaje kolejny numer, a
// priorytet_dzis jest dopasowywany do swojego bliźniaka po telefonie zamiast
// polegać na lp, które model sam podał.
const KATEGORIA_LP_ORDER = ['nowe', 'wyceny_z_feedbackiem', 'inne_z_feedbackiem', 'nieodebrane', 'wyceny_historyczne'];

function reassignLps(parsed) {
  const kat = parsed.kategorie || {};
  const phoneToLp = new Map();
  let next = 1;

  KATEGORIA_LP_ORDER.forEach((key) => {
    const arr = Array.isArray(kat[key]) ? kat[key] : [];
    arr.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const digits = item.telefon && normalizePhoneDigits(item.telefon);
      let lp = digits ? phoneToLp.get(digits) : undefined;
      if (lp === undefined) {
        lp = next;
        next += 1;
        if (digits) phoneToLp.set(digits, lp);
      }
      item.lp = lp;
    });
  });

  if (Array.isArray(parsed.priorytet_dzis)) {
    parsed.priorytet_dzis = parsed.priorytet_dzis.filter((item) => {
      if (!item || typeof item !== 'object') return false;
      const digits = item.telefon && normalizePhoneDigits(item.telefon);
      if (!digits) return false;
      let lp = phoneToLp.get(digits);
      if (lp === undefined) {
        // Model wybrał do priorytetu kogoś spoza 5 głównych kategorii (np. z
        // próbki NAJBARDZIEJ PRZETERMINOWANE) — dostaje nowy, unikalny lp.
        lp = next;
        next += 1;
        phoneToLp.set(digits, lp);
      }
      item.lp = lp;
      return true;
    });
  }

  return { phoneToLp, nextLp: next };
}

function applyZalegleFeedbacki(parsed, zalegleRaw, phoneToLp, nextLp) {
  let next = nextLp;
  const result = zalegleRaw.map((lead) => {
    const digits = normalizePhoneDigits(lead.telefon);
    let lp = digits ? phoneToLp.get(digits) : undefined;
    if (lp === undefined) {
      lp = next;
      next += 1;
      if (digits) phoneToLp.set(digits, lp);
    }
    return { ...lead, lp, row_number: 0, zamkniete: 0, zadzwonil_dzis: false };
  });

  parsed.kategorie = parsed.kategorie || {};
  parsed.kategorie.zalegle_feedbacki = result;
}

// Model pisząc komentarz_dzienny czasem nie zna prawdziwego lp case'a
// dociągniętego z próbki przeterminowanych (bo w momencie generowania jeszcze
// go nie ma — nadajemy go dopiero w reassignLps) i wstawia placeholder typu
// "Case LP? — Imię". Skoro już znamy prawdziwe lp każdego z priorytet_dzis,
// podmieniamy to w tekście deterministycznie zamiast liczyć na to, że model
// się zastosuje do instrukcji w prompcie.
function fixLpMentionsInComment(parsed) {
  if (!parsed.komentarz_dzienny || !Array.isArray(parsed.priorytet_dzis)) return;
  parsed.priorytet_dzis.forEach((item) => {
    if (!item || !item.imie || item.lp === undefined) return;
    const escapedName = String(item.imie).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`LP\\s*\\??\\s*(\\d+)?\\s*—\\s*${escapedName}`, 'g');
    parsed.komentarz_dzienny = parsed.komentarz_dzienny.replace(re, `LP${item.lp} — ${item.imie}`);
  });
}

// Model czasem liczy plan.*_count niespójnie z faktyczną długością tablic
// (zaobserwowane w testach: inne_feedback_count=8 przy tablicy długości 7) —
// app.html wyświetla plan[key] wprost jako kafelek, więc licznik musi być
// prawdziwy. Tu też egzekwujemy limit "max 8" dla kategorii z feedbackiem i
// liczymy backlog z odciętej reszty, zamiast ufać, że model sam przyciął.
function postProcessCounts(parsed) {
  const kat = parsed.kategorie || {};
  const capWithBacklog = (key, cap) => {
    const arr = Array.isArray(kat[key]) ? kat[key] : [];
    const backlog = Math.max(0, arr.length - cap);
    if (arr.length > cap) kat[key] = arr.slice(0, cap);
    return { count: Math.min(arr.length, cap), backlog };
  };
  const wf = capWithBacklog('wyceny_z_feedbackiem', 8);
  const inf = capWithBacklog('inne_z_feedbackiem', 8);

  parsed.plan = parsed.plan || {};
  parsed.plan.nowe_count = Array.isArray(kat.nowe) ? kat.nowe.length : 0;
  parsed.plan.wyceny_feedback_count = wf.count;
  parsed.plan.wyceny_feedback_backlog = wf.backlog;
  parsed.plan.inne_feedback_count = inf.count;
  parsed.plan.inne_feedback_backlog = inf.backlog;
  parsed.plan.nieodebrane_count = Array.isArray(kat.nieodebrane) ? kat.nieodebrane.length : 0;
  parsed.plan.wyceny_historyczne_count = Array.isArray(kat.wyceny_historyczne) ? kat.wyceny_historyczne.length : 0;
  parsed.plan.zalegle_feedbacki_count = Array.isArray(kat.zalegle_feedbacki) ? kat.zalegle_feedbacki.length : 0;
  parsed.plan.priorytet_dzis_count = Array.isArray(parsed.priorytet_dzis) ? parsed.priorytet_dzis.length : 0;
}

function buildUmowaSystemPrompt(dzisiaj, godzina) {
  return `Jesteś asystentem operacyjnym LumLum (premium oświetlenie LED COB, lumlum.co).
Generujesz codzienną Umowę dla handlowca Lorenzzo na podstawie danych z Supabase.
Generujesz WYŁĄCZNIE czysty JSON — bez tekstu przed, bez komentarza, bez markdown, bez backtick. Sam obiekt JSON.

---

## DANE WEJŚCIOWE

Dostajesz dziewięć zestawów danych, każdy jako tablica obiektów JSON z nazwanymi polami (nie kolumny arkusza indeksowane liczbami):

**STANDUP LOG ostatnie 3 dni** — ostatnie 3 wiersze dziennego logu, malejąco po dacie. Pola: \`data\`, \`komentarz_dzienny_poprzedniej_umowy\` (co handlowiec miał zrobić poprzednio), \`podsumowanie_dnia\` (JSON podsumowania dnia albo null).

**LOG ZMIAN wczoraj** — wczorajsze zmiany statusów/rozmowy w CRM. Pola: \`telefon\`, \`data_zmiany\`, \`status_przed\`, \`status_po\`, \`opis\`, \`czas_trwania_s\`, \`disposition\`.

**LOG TELEFONÓW DZIŚ (Zadarma)** — dzisiejsze połączenia (przychodzące/wychodzące/nieodebrane) już zarejestrowane w systemie. Pola identyczne jak wyżej. Jeśli pusta tablica, pomiń bez komentarza — oznacza, że dziś jeszcze nikt nie dzwonił.

**LEADY NOWE** — leady ze statusem "Nowy", max 3 dni, limit 10, najnowsze pierwsze.
**WYCENY AKTYWNE z feedbackiem** — leady ze statusem "Wycena wysłana" z terminem feedbacku dziś lub wcześniej, najstarszy feedback pierwszy.
**LEADY AKTYWNE z feedbackiem** — leady w innym statusie (nie "Wycena wysłana"/"Stracony"/"Sprzedane") z terminem feedbacku w ostatnich 7 dniach, najstarszy feedback pierwszy.
**LEADY NIEODEBRANE ostatnie 7 dni** — status "Nie odebrał", limit 10, najwięcej prób nieodebrania pierwsze.

Pola każdego leada: \`id\`, \`id_wyceny\`, \`data_dolaczenia\`, \`imie\`, \`telefon\`, \`email\`, \`status\`, \`opis\`, \`data_feedbacku\`, \`temperatura\`, \`ostatni_kontakt\`, \`ilosc_telefonow\` (celowo puste — nie licz go, przepisz jak jest), \`produkty\`, \`ocena_ai\`, \`link_formularz\`, \`data_wyceny\`, \`kwota\`.

**WYCENY HISTORYCZNE** — do 10 wycen: najpierw te z feedbackiem (termin dziś lub wcześniej), potem uzupełnienie najstarszymi otwartymi ("Open"), bez duplikatów po ID. Pola: \`id_wyceny\`, \`data_stworzenia\`, \`data_feedbacku\`, \`komentarz\`, \`typ\`, \`status\`, \`imie\`, \`telefon\`, \`email\`, \`link_formularz\`, \`kwota\`.

**NAJBARDZIEJ PRZETERMINOWANE FEEDBACKI** — próbka (top N po dacie) z pełnej listy WSZYSTKICH leadów z przeterminowanym feedbackiem, każdego statusu, bez limitu dni wstecz — siatka bezpieczeństwa na wypadek, że case wypadł z powyższych kategorii (limit dni/limit 8 do wyświetlenia). Pełna lista trafi do osobnej kategorii "zalegle_feedbacki" automatycznie, deterministycznie, PO twojej odpowiedzi — nie musisz jej budować ani kategoryzować. Ta próbka jest tu wyłącznie po to, żebyś mógł wyłapać naprawdę zapomniany, ważny case do \`priorytet_dzis\`, jeśli na to zasługuje wg poniższych kryteriów.

---

## LOGIKA BUDOWANIA UMOWY

### Numeracja LP
Przydziel \`lp\` ciągle przez wszystkie kategorie od 1 do N, unikalnie — dwa różne case'y NIGDY nie mogą mieć tego samego lp (lp identyfikuje case'a jednoznacznie, edycja po lp dotyka wszystkiego co je współdzieli). Case'y w sekcji "priorytet_dzis" mają ten sam lp co w swojej kategorii źródłowej — nie tworzą osobnej puli numerów. To pole i tak zostanie zweryfikowane i w razie kolizji poprawione po twojej odpowiedzi, ale rób to poprawnie od razu.

### Priorytet dziś (max 5) — czytaj jak doświadczony analityk CRM, nie jak wyszukiwarka słów kluczowych

Zanim wybierzesz, PRZECZYTAJ dokładnie pole \`opis\` każdego case'a ze wszystkich zestawów danych (włącznie z próbką NAJBARDZIEJ PRZETERMINOWANE FEEDBACKI) — to prawdziwe notatki handlowca: co ustalono, co obiecano, na czym stanęło. Nie szukaj samych fraz-kluczy, zrozum na jakim etapie faktycznie jest sprawa.

1. **Czyja jest teraz piłka?** To najważniejsze rozróżnienie:
   - **Czeka na nas** — klient o coś zapytał, czegoś oczekuje, albo minął termin, w którym MY mieliśmy się odezwać (wysłać link/wycenę, oddzwonić z odpowiedzią, potwierdzić termin montażu) → realny kandydat do priorytetu.
   - **Czeka na klienta** — klient ma coś dostarczyć/zdecydować (przesłać zdjęcia, zrobić pomiar, skonsultować z rodziną) i nie ma sygnału, że to już się wydarzyło → NIE dawaj do priorytetu, nawet jeśli formalnie zaległy feedback — nic konkretnego nie ma dziś do zrobienia poza ewentualnym przypomnieniem, jeśli minęło naprawdę dużo czasu (wtedy samo przypomnienie STAJE SIĘ konkretną czynnością na dziś).
2. **Konkretne deklaracje czasowe w opisie** — jeśli w notatce jest zapisany termin ("oddzwonię w czwartek", "dam znać po pomiarach w tym tygodniu", "kontakt po 16") i ten termin przypada dziś albo już minął — to mocny, konkretny sygnał do priorytetu.
3. Jawne sygnały gotowości zakupu w opisie: "gotowy kupić", "powiedział że zamówi", "chcę zamówić", "biorę", "remont za miesiąc", "elektryk już jest", "mam projekt gotowy", "kiedy mogę zamówić".
4. Temperatura GORĄCY.
5. Zaległy feedback, ale TYLKO gdy opis daje jasny, wykonalny następny krok — samo "stary case, dawno feedback" bez kontekstu w opisie to za mało.
6. Wyższa kwota jako tiebreaker przy remisie.

Nie wrzucaj case'a do priorytetu tylko po to, żeby wypełnić limit 5 — jeśli opis pokazuje sprawę martwą/w zawieszeniu bez konkretnego triggera ("zastanawia się", "nic więcej nie wiadomo", brak odpowiedzi bez deklaracji terminu), zostaw ją poza priorytetem. Lepiej 3-4 dobre case'y niż 5 na siłę.

### Kategorie w wyjściu — max do wyświetlenia
**nowe** — wszystkie z LEADY NOWE.
**wyceny_z_feedbackiem** — max 8 z WYCENY AKTYWNE z feedbackiem. Resztę zlicz jako backlog.
**inne_z_feedbackiem** — max 8 z LEADY AKTYWNE z feedbackiem. Resztę zlicz jako backlog.
**nieodebrane** — wszystkie z LEADY NIEODEBRANE (już max 10 z danych wejściowych).
**wyceny_historyczne** — wszystkie z WYCENY HISTORYCZNE (już max 10 z danych wejściowych).
**zalegle_feedbacki** — NIE buduj tej kategorii, zostaw ją całkowicie pominiętą albo pustą tablicę. Zostanie wypełniona automatycznie po twojej odpowiedzi z pełnej listy (patrz opis NAJBARDZIEJ PRZETERMINOWANE FEEDBACKI wyżej).

### Temperatura (jeśli pole puste — oceń sam na podstawie opisu)
- GORĄCY: konkretny termin, projekt gotowy, elektryk ustalony, pyta o zamówienie
- LETNI: "muszę pomierzyć", "zastanowię się", "czekam na projekt"
- ZIMNY: brak kontekstu, wielokrotne nieodebrane, "może kiedyś"

### Komentarz dzienny (pole główne, jedno na całą umowę)
Max 5 zdań. Piszesz do handlowca, nie do klienta.
Struktura każdego zdania: "Case LP[N] — [imię] — [konkretna rekomendacja co powiedzieć lub zrobić]." Jeśli case pochodzi z próbki NAJBARDZIEJ PRZETERMINOWANE FEEDBACKI i nie masz dla niego numeru lp (nie występuje w żadnej z pięciu głównych kategorii) — pomiń "LP[N] —" i zacznij od samego imienia, nie wstawiaj "LP?" ani żadnego zmyślonego numeru.
Rekomendacja to nie opis sytuacji, to instrukcja: co powiedzieć, czego się dowiedzieć, jak zamknąć.
Wymieniaj tylko case'y które mają konkretny powód do działania dziś: umówiona rozmowa, gorący lead, zaległy feedback z sygnałem zakupu, albo coś co wynikło z dzisiejszego/wczorajszego telefonu.
Ton: bezpośredni, jakbyś był doświadczonym sprzedawcą który mówi co robić.

### Czego nie rób
- \`row_number\` zawsze 0 — nieużywane w tym systemie, nie wymyślaj
- Nie duplikuj case'ów między kategoriami
- Nie wrzucaj do priorytet_dzis leadów wyłącznie za zaległy feedback bez innych sygnałów
- Jeśli pole puste w danych, zwróć "" dla stringów i 0 dla liczb, nigdy null
- Telefon zawsze w formacie +48XXXXXXXXX, nigdy bez plusa
- Pole \`zadzwonil_dzis\` ustaw według obecności telefonu w LOG TELEFONÓW DZIŚ — i tak zostanie nadpisane deterministycznie po twojej odpowiedzi, więc rób najlepsze przybliżenie

---

## FORMAT WYJŚCIOWY — TYLKO JSON

\`\`\`
{
  "data": "DD.MM.YYYY",
  "wygenerowano": "HH:MM",
  "status": "draft",
  "ostatnie_3_dni": "",
  "kontekst": "",
  "komentarz_dzienny": "",
  "plan": {
    "priorytet_dzis_count": 0,
    "nowe_count": 0,
    "wyceny_feedback_count": 0,
    "wyceny_feedback_backlog": 0,
    "inne_feedback_count": 0,
    "inne_feedback_backlog": 0,
    "nieodebrane_count": 0,
    "wyceny_historyczne_count": 0,
    "zalegle_feedbacki_count": 0,
    "zadzwoniono_dzis": 0
  },
  "priorytet_dzis": [
    {
      "lp": 0, "row_number": 0, "kategoria": "", "id_wyceny": "", "imie": "", "telefon": "", "email": "",
      "status": "", "opis": "", "data_feedbacku": "", "temperatura": "", "ostatni_kontakt": "",
      "ilosc_telefonow": "", "produkty": "", "ocena_ai": "", "link_formularz": "", "data_wyceny": "",
      "kwota": 0, "zadzwonil_dzis": false, "zamkniete": 0
    }
  ],
  "kategorie": {
    "nowe": [
      {
        "lp": 0, "row_number": 0, "id_wyceny": "", "data_dolaczenia": "", "imie": "", "telefon": "", "email": "",
        "status": "", "opis": "", "data_feedbacku": "", "temperatura": "", "ostatni_kontakt": "",
        "ilosc_telefonow": "", "produkty": "", "ocena_ai": "", "link_formularz": "", "data_wyceny": "",
        "kwota": 0, "zadzwonil_dzis": false, "zamkniete": 0
      }
    ],
    "wyceny_z_feedbackiem": [],
    "inne_z_feedbackiem": [],
    "nieodebrane": [],
    "wyceny_historyczne": [
      {
        "lp": 0, "row_number": 0, "id_wyceny": "", "data_stworzenia": "", "data_feedbacku": "",
        "dni_temu": 0, "imie": "", "telefon": "", "kwota": 0, "komentarz": "", "link_formularz": "",
        "zadzwonil_dzis": false, "zamkniete": 0
      }
    ],
    "zalegle_feedbacki": []
  }
}
\`\`\`

Zasady:
- \`zamkniete\` zawsze 0 przy generowaniu
- \`status\` zawsze "draft" przy generowaniu
- \`dni_temu\` dla wycen historycznych: liczba dni od data_stworzenia do dziś
- \`lp\` ciągłe przez wszystkie kategorie
- \`ostatnie_3_dni\`: 2-3 zdania ze STANDUP LOG, co było, co wykonano, co przechodzi
- \`kontekst\`: 2-3 zdania z LOG ZMIAN wczoraj i LOG TELEFONÓW DZIŚ, co się ruszyło, co stoi

---

## KONTEKST PRODUKTOWY

Taśma COB cyfrowa: 75 zł/m | LumControl: 350 zł | Zasilacz 150W 24V: 200 zł | Pilot MONO: 100 zł
Referencja: 10m + LumControl + zasilacz + pilot = ok. 1400 zł
Taśmy powyżej 12m wymagają zasilania dwustronnego

Statusy B2C: Nowy, Po pierwszym tel, Wycena wysłana, Zadzwonić jeszcze raz, Nie odebrał, Przyszłościowy, Sprzedane, Stracony

Dzisiejsza data: ${dzisiaj}
Godzina wygenerowania: ${godzina}

Wygeneruj umowę na dziś. Zwróć TYLKO czysty JSON, zero tekstu poza nim.`;
}

function isCronAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (req.headers.authorization === `Bearer ${secret}`) return true;
  if (req.query.secret === secret) return true;
  return false;
}

app.all('/api/cron/umowa-draft', async (req, res) => {
  const supabase = getClient();
  let dataIso = null;
  try {
    if (!isCronAuthorized(req)) return res.status(401).json({ error: 'Brak autoryzacji' });
    requireOpenAiKey();

    const now = new Date();
    const dzisiaj = warsawDateStr(now);
    const godzina = warsawTimeStr(now);
    const { y, m, d } = warsawParts(now);
    dataIso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

    const wczoraj = warsawDayRange(-1);
    const dzis = warsawDayRange(0);

    // Osobno, przed resztą — leady-fetche potrzebują tej mapy do wypełnienia
    // pola produkty.
    const produktyByPhone = await fetchProduktyByPhone(supabase);

    const [standupLog, logZmianWczoraj, logZmianDzis, nowe, wycenyZFeedbackiem, inneZFeedbackiem, nieodebrane, wycenyHistoryczne, zalegleRaw] = await Promise.all([
      fetchStandupLog3(supabase),
      fetchLogZmianRange(supabase, wczoraj.start, wczoraj.end),
      fetchLogZmianRange(supabase, dzis.start, dzis.end),
      fetchNowe(supabase, produktyByPhone),
      fetchWycenyZFeedbackiem(supabase, produktyByPhone),
      fetchInneZFeedbackiem(supabase, produktyByPhone),
      fetchNieodebrane(supabase, produktyByPhone),
      fetchWycenyHistoryczne(supabase),
      fetchZalegleFeedbacki(supabase, produktyByPhone),
    ]);

    const calledSet = buildCalledTodaySet(logZmianDzis);

    // Modelowi pokazujemy tylko najbardziej przeterminowane z zaległych (do
    // ewentualnego wyłapania w priorytet_dzis) — pełną, nieobciętą listę i
    // tak wstawiamy deterministycznie niżej (applyZalegleFeedbacki), więc nie
    // trzeba pchać w prompt setek wierszy, żeby kategoria "Zaległe feedbacki"
    // była kompletna.
    const zalegleDlaModelu = zalegleRaw.slice(0, 20);

    const userContent = [
      `Dzisiejsza data: ${dzisiaj}`,
      `Godzina wygenerowania: ${godzina}`,
      '',
      'STANDUP LOG ostatnie 3 dni:', JSON.stringify(standupLog),
      '',
      'LOG ZMIAN wczoraj:', JSON.stringify(logZmianWczoraj),
      '',
      'LOG TELEFONÓW DZIŚ (Zadarma):', JSON.stringify(logZmianDzis),
      '',
      'LEADY NOWE:', JSON.stringify(nowe),
      '',
      'WYCENY AKTYWNE z feedbackiem:', JSON.stringify(wycenyZFeedbackiem),
      '',
      'LEADY AKTYWNE z feedbackiem:', JSON.stringify(inneZFeedbackiem),
      '',
      'LEADY NIEODEBRANE ostatnie 7 dni:', JSON.stringify(nieodebrane),
      '',
      'WYCENY HISTORYCZNE:', JSON.stringify(wycenyHistoryczne),
      '',
      `NAJBARDZIEJ PRZETERMINOWANE FEEDBACKI (top ${zalegleDlaModelu.length} z ${zalegleRaw.length} łącznie, tylko do wglądu — patrz zasady niżej):`,
      JSON.stringify(zalegleDlaModelu),
    ].join('\n');

    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: UMOWA_MODEL,
        // gpt-5-mini na tym API nie przyjmuje temperature != domyślnej (1) —
        // scenariusz Make ustawiał 0, ale to ustawienie modelu w innej wersji
        // API, tu odrzucane jako "unsupported_value". Pomijamy parametr.
        response_format: { type: 'json_object' },
        reasoning_effort: 'minimal',
        messages: [
          { role: 'system', content: buildUmowaSystemPrompt(dzisiaj, godzina) },
          { role: 'user', content: userContent },
        ],
      }),
    });
    if (!aiRes.ok) {
      const body = await aiRes.text();
      throw new Error(`OpenAI ${aiRes.status}: ${body.slice(0, 300)}`);
    }
    const aiBody = await aiRes.json();
    const content = aiBody.choices?.[0]?.message?.content || '';
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error('AI zwróciło JSON, którego nie da się sparsować');
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.kategorie || !parsed.plan) {
      throw new Error('Odpowiedź AI nie wygląda na dokument Umowy (brak "kategorie"/"plan")');
    }

    const { phoneToLp, nextLp } = reassignLps(parsed);
    applyZalegleFeedbacki(parsed, zalegleRaw, phoneToLp, nextLp);
    fixLpMentionsInComment(parsed);
    postProcessCalledToday(parsed, calledSet);
    postProcessCounts(parsed);

    const { error: upsertErr } = await supabase
      .from(STANDUP_TABLE)
      .upsert({ Data: dataIso, [DOCS.umowa.draft]: parsed }, { onConflict: 'Data' });
    if (upsertErr) throw upsertErr;

    await logOperation(supabase, 'umowa_draft_cron', 'ok', { data: dataIso, wygenerowano: godzina });
    res.json({ json: parsed });
  } catch (err) {
    await logOperation(supabase, 'umowa_draft_cron', 'error', { data: dataIso, message: err.message });
    handleError(res, err, 502);
  }
});

// Domyka dzień: dla dzisiejszych wierszy Log zmian dopasowanych do leada/
// wyceny, odczytuje AKTUALNY status/notatki/datę feedbacku tego rekordu i
// wpisuje je jako "_po" — handlowiec edytuje te pola poza tą appką (Sheets/
// Supabase), więc nie ma innego miejsca w kodzie, w którym dałoby się to
// złapać na żywo. Raz dziennie wieczorem wystarcza (patrz vercel.json).
app.all('/api/cron/log-polaczen-closeout', async (req, res) => {
  const supabase = getClient();
  try {
    if (!isCronAuthorized(req)) return res.status(401).json({ error: 'Brak autoryzacji' });

    const { start, end } = warsawDayRange(0);
    const { data: rows, error: fetchErr } = await supabase
      .from(LOG_ZMIAN_TABLE)
      .select('*')
      .gte('data_zmiany', start.toISOString())
      .lt('data_zmiany', end.toISOString())
      .not('dopasowano_tabela', 'is', null);
    if (fetchErr) throw fetchErr;

    let updated = 0;
    for (const row of rows || []) {
      const { data: current, error: currentErr } = await supabase
        .from(row.dopasowano_tabela)
        .select('*')
        .eq('ID', row.dopasowano_id)
        .limit(1);
      if (currentErr || !current?.length) continue;
      const record = current[0];
      const isLead = row.dopasowano_tabela === LEADY_B2C_TABLE;
      const { error: updateErr } = await supabase
        .from(LOG_ZMIAN_TABLE)
        .update({
          status_po: isLead ? record['Deal stage'] : record['Status'],
          opis_po: isLead ? record['Notes'] : record['Komentarz'],
          data_feedbacku_po: record['Data Feedbacku'],
        })
        .eq('id', row.id);
      if (!updateErr) updated += 1;
    }

    await logOperation(supabase, 'log_polaczen_closeout_cron', 'ok', { wierszy: rows?.length || 0, zaktualizowano: updated });
    res.json({ wierszy: rows?.length || 0, zaktualizowano: updated });
  } catch (err) {
    await logOperation(supabase, 'log_polaczen_closeout_cron', 'error', { message: err.message });
    handleError(res, err, 502);
  }
});

// Podgląd dziennika połączeń handlowca — offset=0 dziś, offset=-1 wczoraj itd.
app.get('/api/log-polaczen', async (req, res) => {
  try {
    const supabase = getClient();
    const offset = Number(req.query.offset) || 0;
    const { start, end } = warsawDayRange(offset);
    const { data, error } = await supabase
      .from(LOG_ZMIAN_TABLE)
      .select('*')
      .gte('data_zmiany', start.toISOString())
      .lt('data_zmiany', end.toISOString())
      .order('data_zmiany', { ascending: false });
    if (error) throw error;
    res.json({ data: data || [] });
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
