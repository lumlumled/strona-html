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

app.use((req, res, next) => {
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

// Audio przychodzi jako surowe body (nie multipart) i NIE jest nigdzie
// zapisywane — leci prosto do transkrypcji OpenAI i przepada.
app.post('/api/transcribe', express.raw({ type: 'audio/*', limit: '8mb' }), async (req, res) => {
  try {
    requireOpenAiKey();
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'Brak nagrania' });

    // OpenAI rozpoznaje format audio po rozszerzeniu nazwy pliku, nie po
    // nagłówku Content-Type — nazwa musi pasować do faktycznego formatu.
    const contentType = (req.headers['content-type'] || 'audio/webm').split(';')[0].trim();
    const EXT_BY_TYPE = {
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
    const ext = EXT_BY_TYPE[contentType] || 'webm';

    const form = new FormData();
    form.append('file', new Blob([req.body], { type: contentType }), `audio.${ext}`);
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
    res.json({ text: data.text || '' });
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
