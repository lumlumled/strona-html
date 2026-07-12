require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { getClient } = require('./supabase');
const { registerLeadyEndpoints, NIE_TELEFON_ZRODLA } = require('../../shared/server/leady-endpoints');
const { registerWycenyEndpoints } = require('../../shared/server/wyceny-endpoints');
const { createAuth, clientPayload, panelLinks, isAdmin } = require('../../shared/server/auth');
const { servePushWorker, registerPushEndpoints } = require('../../shared/server/push');

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

// Indywidualne konta (tabela app_users) — wspólny moduł auth
// (apps/shared/server/auth.js) rejestruje /login, /logout i bramkę panelu
// 'backlog-b2c'. Endpointy wołane przez zewnętrzne serwisy (webhook Zadarmy,
// Vercel Cron) nie mają ciasteczka sesji — mają własną autoryzację (podpis
// Zadarmy / CRON_SECRET), więc pomijają bramkę.
// Bez express.static — na Vercelu jest ignorowany (statyki trzeba serwować
// z public/**, a to zepsułoby bramkę hasła dla strony). sendFile działa
// wszędzie tak samo, więc zamiast tego jest zwykły route. Assets/shared
// PRZED bramką auth — strona logowania też potrzebuje logo, a to statyki
// bez wrażliwych danych.
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

// Wspólna karta leada (apps/shared/) — te same pliki serwuje CRM pod swoim
// /shared/, żeby obie appki renderowały leada identycznie.
app.get('/shared/:file', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'shared', req.params.file));
});

const auth = createAuth({
  getClient,
  panelKey: 'backlog-b2c',
  publicPrefixes: ['/api/webhooks/', '/api/cron/'],
  loginTitle: 'Backlog B2C',
});
// /sw.js przed bramką auth (publiczny statyk — patrz apps/shared/server/push.js),
// endpointy /api/push/* za bramką (user z sesji).
servePushWorker(app);
auth.register(app);
registerPushEndpoints(app, { getClient });

// Wczytany raz przy starcie (plik się nie zmienia w runtime) — app.html
// czyta `window.API_BASE || ''` dla każdego swojego fetch()a (już tak było
// napisane), więc trzeba wstrzyknąć prawdziwy prefiks montowania (req.baseUrl:
// '' lokalnie, '/backlog-b2c' zamontowane pod Vercelem) przed wysłaniem —
// inaczej fetch('/api/...') trafiałby w root domeny, nie pod ten prefiks.
const APP_HTML_TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');

app.get('/', (req, res) => {
  // Poza API_BASE wstrzykujemy zalogowanego użytkownika i linki między
  // panelami — konsumuje je wspólny topbar (apps/shared/topbar.js).
  const html = APP_HTML_TEMPLATE.replace(
    '<head>',
    `<head>\n<script>window.API_BASE = ${JSON.stringify(req.baseUrl)};\n` +
    `window.LUMLUM_USER = ${JSON.stringify(clientPayload(req.user))};\n` +
    `window.LUMLUM_LINKS = ${JSON.stringify(panelLinks())};</script>`
  );
  res.type('html').send(html);
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

// Webhook wychodzący do jednej konkretnej automatyzacji Antoniego (Make) —
// odpala się WYŁĄCZNIE gdy webhook Zadarmy sam tworzy nowego leada z numeru,
// którego nie ma w bazie (patrz createdLead w /api/webhooks/zadarma). Na
// sztywno w kodzie, celowo (Antoni prosił) — zmiana adresu wymaga deployu.
const NEW_LEAD_WEBHOOK_URL = 'https://hook.eu1.make.com/2hdhzl5b254o6bayfsynnz6p9hfvjtq2';

async function notifyNewLead(telefon) {
  try {
    const res = await fetch(NEW_LEAD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telefon }),
    });
    if (!res.ok) console.warn(`Webhook nowego leada odpowiedział ${res.status}`);
  } catch (err) {
    console.warn('Nie udało się wysłać webhooka nowego leada:', err.message);
  }
}

const PROMPT_INTRO = {
  umowa: 'Jesteś edytorem umowy dziennej LumLum. Dostajesz JSON umowy i polecenie użytkownika (często dyktowane głosowo — mogą być literówki).',
  podsumowanie: 'Jesteś edytorem podsumowania dnia LumLum. Dostajesz JSON podsumowania dnia i polecenie użytkownika (często dyktowane głosowo — mogą być literówki).',
};

function buildSystemPrompt(doc, dzisiaj) {
  return `${PROMPT_INTRO[doc]} Zwróć WYŁĄCZNIE pełny, poprawiony JSON o tej samej strukturze. Zero tekstu poza nim.

## DATA

Dzisiejsza rzeczywista data (kalendarzowa, Warszawa): ${dzisiaj}. Wszystkie relatywne określenia dat w poleceniu ("jutro", "dziś", "pojutrze", "za tydzień", "w piątek" itd.) licz WZGLĘDEM TEJ daty — NIE względem pola \`data\` w przekazanym JSON-ie. Ten JSON może być Umową z zupełnie innego (np. historycznego) dnia niż dzisiaj, więc "jutro" zawsze oznacza dzień po dzisiejszej rzeczywistej dacie, niezależnie od tego, którego dnia dotyczy edytowany dokument.

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

- Edytuj WYŁĄCZNIE JEDNEGO case'a wskazanego w poleceniu — dokładnie ten LP/imię/telefon, nic więcej. Nigdy nie dotykaj sąsiednich case'ów (np. LP-1 albo LP+1) ani żadnego innego, nawet jeśli wydają się podobni albo są obok w tej samej kategorii — chyba że polecenie wprost wymienia więcej niż jeden LP.
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
        // Bez tego gpt-5.1 domyślnie myśli "na pełną głowę" nawet nad edycją
        // jednego pola — 'low' starcza na precyzyjne dopasowanie case'a i
        // wielokrotnie skraca czas odpowiedzi (patrz UMOWA_MODEL, ten sam wzorzec).
        reasoning_effort: 'low',
        messages: [
          { role: 'system', content: buildSystemPrompt(doc, warsawDateStr()) },
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
// Port promptu, który wcześniej żył w Make (scenariusz GPT-5 mini analizujący
// transkrypcję) — Antoni podał go 1:1, przenosimy tu żeby webhook Zadarmy
// robił to sam, bez pośrednictwa Make. Jedna świadoma zmiana względem
// oryginału: reguła statusu "Wycena wysłana" wymagała wcześniej TYLKO
// zapowiedzi wysłania ("wysłał LUB obiecał wysłać") — w praktyce łapało to
// też przypadki typu "wyślę ofertę na maila", gdzie nic jeszcze nie zostało
// wysłane. Teraz wymaga potwierdzonego faktu wysłania.
function buildCallAnalysisPrompt(dzisiaj, kierunek, poprzedniOpis, poprzedniaAkcja) {
  const kierunekOpis = kierunek === 'wychodzące'
    ? 'To handlowiec dzwoni do klienta (połączenie wychodzące).'
    : kierunek === 'przychodzące'
      ? 'To klient dzwoni do handlowca (połączenie przychodzące).'
      : 'Kierunek połączenia nieznany — nie zakładaj kto do kogo dzwonił, opieraj się wyłącznie na treści rozmowy.';
  return `Jesteś asystentem CRM firmy LumLum (oświetlenie LED premium).
Analizujesz transkrypcję rozmowy telefonicznej handlowca z klientem.
Zwróć WYŁĄCZNIE jeden obiekt JSON. Bez komentarzy, bez markdownu, bez tekstu przed ani po.

${kierunekOpis}

DZISIAJ: ${dzisiaj}

===== STATUSY =====
Wybierz dokładnie jeden:
- "Po pierwszym tel"
- "Lekko zainteresowany"
- "Przyszłościowy"
- "Zadzwonić jeszcze raz"
- "Wycena wysłana"
- "Sprzedane"
- "Stracony"

===== ZASADY STATUSU =====
Prosi o kontakt w terminie → "Zadzwonić jeszcze raz" + data_feedbacku.
Handlowiec FAKTYCZNIE wysłał wycenę (padł link do wyceny, potwierdzenie że PDF/oferta już poszła na maila, klient potwierdza że dostał) → "Wycena wysłana".
SAMA zapowiedź/obietnica wysłania wyceny w przyszłości ("wyślę panu ofertę", "przygotuję wycenę i prześlę", "dostanie pan wycenę") to NIE jest "Wycena wysłana" — zostaje "Po pierwszym tel" albo "Zadzwonić jeszcze raz" (jeśli padła data kolejnego kontaktu).
Klient zamówił → "Sprzedane".
Niepewny → "Po pierwszym tel".
Jeśli pasuje kilka statusów → wybierz najdalej zaawansowany wg powyższej logiki.

===== ZASADY data_feedbacku =====
Data feedbacku to WYŁĄCZNIE termin kolejnego kontaktu telefonicznego lub umówionej rozmowy.
NIE jest to data żadnego innego zdarzenia jak koniec budowy, odbiór mieszkania, start remontu.

Wypełnij TYLKO gdy w rozmowie pada JEDNOCZEŚNIE:
1. Wyraźny sygnał ponownego kontaktu, np.:
   - "zadzwonię do pana za X"
   - "proszę zadzwonić za X"
   - "możemy się umówić na X"
   - "oddzwonię w X"
   - "kiedy mogę zadzwonić"
   - "umawiamy się na ponowną rozmowę"
   - "wróćmy do tematu za X"
2. ORAZ konkretny termin (data, dzień tygodnia, "za X dni/tygodni/miesięcy")

Samo padnięcie daty lub okresu czasu w innym kontekście NIE wypełnia tego pola.
Przykłady które NIE są data_feedbacku:
- "za miesiąc skończy się etap budowy"
- "remont zaczyna się za dwa tygodnie"
- "odbiór mieszkania jest w przyszłym miesiącu"
- "elektryka będzie za trzy tygodnie"

Przelicz względem DZISIAJ i zwróć w formacie DD.MM.YYYY.
"25-tego" bez miesiąca → najbliższy przyszły taki dzień.
"w piątek" → najbliższy przyszły piątek.
"za tydzień" → +7 dni od dzisiaj.
Brak wyraźnego umówienia kontaktu → null.

===== ZASADY godzina_feedbacku =====
Wypełnij TYLKO gdy przy umówionym kolejnym kontakcie (data_feedbacku) padła
KONKRETNA godzina: "zadzwonię o 15" → "15:00", "umówmy się na 14:30" → "14:30",
"po siedemnastej" → "17:00". Format HH:MM (24h).
Sam dzień bez godziny → null (dzień wystarczy, NIE wymyślaj godziny).
Pory dnia bez konkretu ("rano", "po południu", "wieczorem") → null.
Gdy data_feedbacku = null → godzina_feedbacku też ZAWSZE null.

===== ZASADY opis =====
Zwięzłe podsumowanie najważniejszych informacji z TEJ rozmowy.
Styl: konkretna notatka handlowca, bez lania wody.
Zawiera: czego klient szuka, gdzie montaż, jaki etap projektu, co ustalono, co jest następnym krokiem.
Długość dopasuj do treści, nie pomijaj ważnych rzeczy, nie dodawaj zbędnych.

===== ZASADY skrocony_opis =====
To "żywa pigułka" wiedzy o kliencie — skrócony opis CAŁEGO kontaktu, nie tylko tej rozmowy. Po każdej rozmowie regenerowany od nowa.
DOTYCHCZASOWY SKRÓCONY OPIS (może być pusty — wtedy piszesz pierwszy):
"""
${poprzedniOpis || ''}
"""
Przepisz go na nowo uwzględniając tę rozmowę: zachowaj fakty wciąż aktualne, usuń nieaktualne, dodaj nowe ustalenia.
Maksymalnie 3-4 zdania: czego klient szuka, na jakim etapie jest sprawa, kluczowe konkrety (produkty, metraż, kwoty, terminy), jaki jest następny krok.
BEZ chronologii poszczególnych rozmów i ich dat (od tego jest osobna historia rozmów), bez ogólników.

===== ZASADY KOREKT =====
Jeśli pada korekta (np. "3000K... nie, jednak 4000K") → bierz OSTATNIĄ wartość.
Dotyczy: temperatury, ilości metrów, typu produktu, liczby sztuk.

===== ZASADY najblizsza_akcja =====
To krótka etykieta na zwiniętym case'ie w backlogu — handlowiec ma jednym
rzutem oka widzieć, co KONKRETNIE ma z tym leadem zrobić jako następny krok.
Maksymalnie 5-6 słów, tryb rozkazujący, po polsku, z terminem jeśli padł:
"Zadzwonić jutro 15:00" → jeśli jutro = 12.07, napisz "Zadzwonić 12.07 15:00"
"Zadzwonić w czwartek" → "Zadzwonić czw 16.07"
"Wysłać wycenę SMS-em"
"Doliczyć zasilacz i przesłać wycenę"
Daty względne ("jutro", "za tydzień", "w piątek") ZAWSZE przelicz względem
DZISIAJ na konkretną datę — etykieta będzie czytana także w kolejnych dniach,
"jutro" straciłoby sens.

DOTYCHCZASOWA NAJBLIŻSZA AKCJA (może być pusta):
"""
${poprzedniaAkcja || ''}
"""
Ta rozmowa ją REEWALUUJE:
- w rozmowie umówiono/ustalono nowy następny krok → wpisz nowy
- dotychczasowa akcja została w tej rozmowie WYKONANA lub zdezaktualizowana,
  a nic nowego nie umówiono → null (akcja znika z case'a)
- dotychczasowa akcja NIE dotyczyła tej rozmowy albo nadal jest do zrobienia
  (np. "Wysłać wycenę SMS-em", a wycena wciąż nie wysłana) → przepisz ją dalej
- status "Sprzedane" lub "Stracony" → zawsze null
- brak dotychczasowej akcji i brak konkretnego następnego kroku → null;
  NIE wymyślaj akcji z ogólników ("klient się zastanawia" to nie akcja)

najblizsza_akcja_termin: konkretny moment wykonania akcji, jeśli padł.
Format "DD.MM.YYYY HH:mm" (gdy padła godzina) albo "DD.MM.YYYY" (gdy sam
dzień). Brak konkretnego terminu → null. Gdy akcja to kolejny telefon w
umówionym terminie, termin = data_feedbacku (spójnie).

===== ZASADY zamkniete_dzis =====
To NIE jest "zamknięty case" (sprzedany/stracony na zawsze) — to informacja czy
z tym tematem trzeba jeszcze coś zrobić DZISIAJ, czy nie. Liczy się WYŁĄCZNIE
konkretność ustalenia, NIE odległość w czasie do kolejnego kontaktu — "proszę
zadzwonić jutro" to TAK, jest zaopiekowany na dziś (bo dzisiejsze zadanie z tym
tematem jest zrobione, kolejny krok jest zaplanowany na inny, konkretny dzień).

true gdy:
- status = "Sprzedane"
- status = "Stracony"
- klient jednoznacznie odmówił ("nie jestem zainteresowany", "rezygnuję")
- padła data_feedbacku — KONKRETNY termin kolejnego kontaktu, niezależnie jak
  blisko (nawet "jutro") — bo skoro termin jest ustalony na inny dzień, na dziś
  nic więcej nie trzeba robić
- handlowiec faktycznie wysłał wycenę i klient powiedział że odezwie się sam

false gdy:
- klient prosi o kontakt "później"/"jeszcze dziś" BEZ konkretnej daty czy pory —
  niejednoznaczne, może oznaczać że jeszcze dziś coś z tym tematem się zdarzy
- klient "zastanawia się" bez konkretnej daty
- rozmowa urwana, niejasna, bez konkluzji

===== TYP KLIENTA B2B / B2C =====
Oceń czy klient jest B2B czy B2C na podstawie faktów z rozmowy.

B2B - klient jest profesjonalistą działającym w imieniu swojej firmy lub klientów:
Sygnały B2B (wystarczy jeden wyraźny):
- mówi że jest projektantem wnętrz, architektem, interior designerem
- mówi że jest elektrykiem, instalatorem, wykonawcą, monterem
- mówi że robi dla swojego klienta, dla inwestora, dla projektu
- mówi że ma firmę budowlaną, remontową, wykończeniową
- mówi że szuka rozwiązania do stałej współpracy lub hurtowego zakupu
- pyta o program partnerski, prowizję, rabat dla firm
- mówi że ma wiele realizacji, projektów, budów

B2C - klient kupuje dla siebie:
- robi remont własnego domu, mieszkania
- nie wspomina o firmie ani działaniu w imieniu kogoś innego
- brak sygnałów B2B

Jeśli brak jakichkolwiek sygnałów → domyślnie "B2C".

===== NAZWY I MAPOWANIE PRODUKTÓW =====
Mapuj to co pada w rozmowie na oficjalne nazwy.
Wyciągaj produkty TYLKO jeśli klient lub handlowiec mówi o konkretnych produktach lub ilościach.
NIE wymyślaj produktów jeśli rozmowa jest ogólna.

TAŚMY:
- "cyfrowa / cyfra / digital / COB cyfrowa" → "Cyfrowa taśma COB [temp]K [IP]"
- "analogowa / analog / mono / jednokolorowa" → "Analogowa taśma COB [temp]K [IP]"

TEMPERATURA:
- "ciepła / ciepłe / 3000" → 3000K
- "neutralna / neutralne / 4000" → 4000K
- "zimna / zimne / 6000" → 6000K
- brak info → nie wpisuj temperatury (np. "Cyfrowa taśma COB IP20")

IP - ZAWSZE wpisuj IP w nazwie, nigdy nie pomijaj:
- cyfrowe: brak info → IP20, pada wodoodporna/wodoszczelna/ip65/ip67/łazienka/kuchnia/zewnętrze/elewacja → IP65
- analogowe: brak info → IP20, pada wodoodporna/wodoszczelna/ip65/ip67/łazienka/kuchnia/zewnętrze/elewacja → IP67

STEROWNIKI:
- "sterownik cyfrowy / LumControl / lum control" → "Sterownik LumControl"
- "sterownik mono / V1 / sterownik analogowy / sterownik jednokolor" → "Sterownik analogowy MONO"
- "sterownik kaskadowy / schodowy / na schody" → "Sterownik schodowy PIR" (chyba że pada "laser" → "Sterownik schodowy LASER")
- "sterownik RGB / WT5 / sterownik kolorowy" → "Sterownik analogowy RGB+CCT"
- Jeśli pada sam "sterownik" bez doprecyzowania a wcześniej mówiono o taśmie cyfrowej → "Sterownik LumControl"
- Jeśli pada sam "sterownik" bez doprecyzowania a wcześniej mówiono o taśmie analogowej → "Sterownik analogowy MONO"

ZASILACZE:
- "zasilacz 150W" bez MeanWell → "Zasilacz 150W 24V"
- "zasilacz 75W" → "Zasilacz MeanWell 75W 24V"
- "zasilacz 200W" → "Zasilacz MeanWell 200W 24V"
- "zasilacz 600W" → "Zasilacz MeanWell 600W 24V"
- "zasilacz" bez mocy → "Zasilacz 150W 24V"

PILOTY:
- "pilot / pilot mono / pilot jednostrefowy" → "Pilot MONO 1 strefa"
- "pilot czterostrefowy / pilot 4 strefy / pilot 4-strefowy" → "Pilot MONO 4 strefy"
- "pilot CCT" → "Pilot CCT 1 strefa"
- "pilot RGB / pilot kolorowy" → "Pilot RGB+CCT 1 strefa"

CZUJNIKI:
- "czujniki / czujniki ruchu / PIR / zestaw czujników" → "Zestaw czujników ruchu"
- "czujniki laserowe / laser / zestaw laserowy" → "Zestaw laserowych czujników ruchu"

===== JAKOŚĆ LEADA =====
Oceń jakość leada na podstawie faktów z rozmowy. Nie zgaduj, opieraj się wyłącznie na tym co padło.

GORĄCY, spełnia minimum 2 z poniższych:
- pyta o konkretne ilości (metry, sztuki) potrzebne do jego projektu
- ma potwierdzoną datę montażu w ciągu najbliższych 4 tygodni, lub prace budowlane/wykończeniowe faktycznie trwają w tym momencie (nie "elektryk przyjdzie po wylewkach" bez daty)
- pyta o cenę konkretnego zestawu lub składa zamówienie
- ma wykonawcę wybranego konkretnie do montażu oświetlenia LED (nie ogólnie "mam swojego elektryka")
- wraca po wcześniejszym kontakcie z konkretnymi pytaniami dotyczącymi wyceny lub specyfikacji

ZIMNY, spełnia minimum 2 z poniższych:
- brak projektu lub remont odłożony w czasie (ponad 6 miesięcy lub bez określonej daty)
- nie wie czego chce, pyta bardzo ogólnie o produkt
- porównuje ceny bez zaangażowania w konkretny projekt
- krótka rozmowa bez żadnych konkretów
- niechętny do rozmowy, odpowiada monosylabami

ŚREDNI, wszystko pomiędzy, w tym przypadki gdzie klient ma realny, ale wczesny projekt (np. przygotowana instalacja, ale bez daty montażu i bez znajomości zakresu produktu).

Ważne zasady: posiadanie przygotowanej elektryki/kabli/czujnika samo w sobie nie jest sygnałem gorącym, jeśli klient nie zna terminu ani zakresu zamówienia. Ilość zadanych pytań technicznych nie jest sygnałem temperatury, liczy się treść odpowiedzi (czy padła data, ilość, cena). Kryteria muszą być spełnione dosłownie, nie interpretacyjnie.

uzasadnienie_jakosci: jedno konkretne zdanie, tylko fakty z rozmowy, bez domysłów.

===== ZASADY cena_zaproponowana =====
Wypełnij TYLKO jeśli handlowiec wprost podał kwotę klientowi podczas rozmowy.
Przykłady: "to będzie około 1500 zł", "wycena wychodzi 2200", "cena to 3400 złotych".
Format: "2300 zł"
Brak → null.

===== FORMAT WYJŚCIOWY =====
{
  "status": "",
  "data_feedbacku": "DD.MM.YYYY lub null",
  "godzina_feedbacku": "HH:MM lub null",
  "opis": "",
  "skrocony_opis": "",
  "wycena": "tak lub nie",
  "typ_klienta": "B2B lub B2C",
  "produkty": "",
  "cena_zaproponowana": "XXXX zł lub null",
  "jakosc_leada": "gorący lub średni lub zimny",
  "uzasadnienie_jakosci": "",
  "zamkniete_dzis": true lub false,
  "najblizsza_akcja": "max 5-6 słów lub null",
  "najblizsza_akcja_termin": "DD.MM.YYYY HH:mm lub DD.MM.YYYY lub null"
}

ZASADY POLA produkty:
- To pole to TWARDY DOWÓD pod wycenę — na jego podstawie handlowiec ma móc
  od razu zrobić klientowi wycenę. Wypełnij je TYLKO gdy handlowiec z
  klientem faktycznie USTALILI w rozmowie konkretne produkty w konkretnych,
  znanych ilościach (liczba metrów, liczba sztuk). Luźne dywagacje,
  orientacyjne pytania o cenę, "około", "jeszcze zmierzy", "musi policzyć"
  → to NIE jest ustalenie, pole zostaje puste.
- Jeśli ilość jest niejasna, ogólnikowa albo w ogóle nie padła — NIE dodawaj
  tego produktu do listy. Żadnych placeholderów typu "? m"/"? szt" —
  niepewny produkt to nie jest produkt z wyceny, to szum. Lepiej nie zapisać
  nic, niż zapisać coś niepewnego.
- NIGDY nie wpisuj tu numeru telefonu ani ceny ("Cena za całość" itp.) —
  telefon i cena mają własne kolumny (cena → pole cena_zaproponowana).
- Format każdej linii: "[ilość][jednostka] [nazwa produktu]" — jednostka
  WYŁĄCZNIE dla taśm (zawsze "m", sklejone z liczbą, np. "10m"). Dla
  wszystkiego innego (sterowniki, zasilacze, piloty, czujniki) sama liczba
  bez jednostki, np. "2 Sterownik LumControl", "1 Pilot MONO 4 strefy".
- Bez myślnika między ilością a nazwą.
- Każdy produkt w osobnej linii (znak \\n między liniami)
- Puste "" jeśli żaden produkt nie ma konkretnej, znanej ilości

Pole wycena: "tak" jeśli handlowiec omawiał konkretne produkty z ilościami lub faktycznie wysłał wycenę. Inaczej "nie".
Pole jakosc_leada: zawsze wypełnione.
Pole typ_klienta: jeśli brak sygnałów B2B → zawsze "B2C".`;
}

// Zastępuje dawne summarizeCall — zamiast samego streszczenia, pełna analiza
// rozmowy (status/data_feedbacku/produkty/kwota/jakość leada/zamknięcie na
// dziś), przeniesiona z promptu, który wcześniej żył w scenariuszu Make.
async function analyzeCall(transcript, { kierunek, dzisiaj, poprzedniOpis, poprzedniaAkcja }) {
  const fallback = { status: null, data_feedbacku: null, godzina_feedbacku: null, opis: transcript ? transcript.slice(0, 200) : null, skrocony_opis: null, produkty: '', cena_zaproponowana: null, jakosc_leada: null, uzasadnienie_jakosci: '', zamkniete_dzis: false, najblizsza_akcja: null, najblizsza_akcja_termin: null };
  if (!OPENAI_API_KEY || !transcript) return fallback;
  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: UMOWA_MODEL,
        response_format: { type: 'json_object' },
        reasoning_effort: 'minimal',
        messages: [
          { role: 'system', content: buildCallAnalysisPrompt(dzisiaj, kierunek, poprzedniOpis, poprzedniaAkcja) },
          { role: 'user', content: transcript },
        ],
      }),
    });
    if (!aiRes.ok) return fallback;
    const body = await aiRes.json();
    const content = body.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(content);
    return { ...fallback, ...parsed };
  } catch (err) {
    console.warn('Analiza rozmowy (GPT) nie powiodła się:', err.message);
    return fallback;
  }
}

function normalizePhoneDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

// Hierarchia statusów leada — status ustawiany automatycznie z webhooka
// Zadarmy nigdy nie cofa się w dół tego lejka (np. lead z "Wycena wysłana"
// nie wraca na "Po pierwszym tel" tylko dlatego, że ktoś znów zadzwonił i
// GPT błędnie to tak zinterpretował). Oba warianty nazwy "Po pierwszym
// tel(efonie)" widziane w prawdziwych danych — patrz STATUS_COLORS w app.html.
const STATUS_RANK = {
  'Nowy': 0,
  'Lekko zainteresowany': 1,
  'Po pierwszym tel': 1,
  'Po pierwszym telefonie': 1,
  'Nie odebrał': 1,
  'Przyszłościowy': 2,
  'Zadzwonić jeszcze raz': 2,
  'Wycena wysłana': 3,
  'Sprzedane': 4,
  'Stracony': 4,
};

function statusRank(status) {
  return STATUS_RANK[status] ?? 0;
}

// "Nie odebrał" nie idzie przez rangę (patrz statusRank) — to osobny, wąski
// wyjątek: wolno w niego wejść tylko z tych trzech wczesnych statusów (albo
// gdy lead jeszcze nie ma żadnego statusu). Z każdego innego miejsca
// (Zadzwonić jeszcze raz, Wycena wysłana...) nieodebrany telefon zostawia
// status bez zmian.
const NO_ANSWER_ALLOWED_FROM = new Set(['Nowy', 'Po pierwszym tel', 'Po pierwszym telefonie', 'Przyszłościowy']);

// "2300 zł" / "2300" / "~2300 zł" → 2300. Brak liczby → null (nie nadpisuj
// istniejącej Kwoty wyceny przypadkowym zerem).
function parseKwotaZlotych(str) {
  if (!str) return null;
  const digits = String(str).replace(/[^0-9]/g, '');
  return digits ? Number(digits) : null;
}

// Ustawia zamkniete=1 dla case'a o danym telefonie we WSZYSTKICH wersjach
// (draft/poprawka/final, które akurat istnieją) dzisiejszej Umowy — patrz
// wywołanie w /api/webhooks/zadarma. Szuka po priorytet_dzis i wszystkich
// kategoriach, tak jak updateLeadInJson (ten szuka po lp, tu szukamy po
// telefonie, bo webhook nie zna lp).
function setZamknieteByPhone(json, phoneDigits) {
  let updated = false;
  const applyToArray = (arr) => {
    if (!Array.isArray(arr)) return;
    arr.forEach((item) => {
      if (item && normalizePhoneDigits(item.telefon) === phoneDigits) {
        item.zamkniete = 1;
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

async function markZamknieteInUmowa(supabase, phoneDigits) {
  try {
    const { y, m, d } = warsawParts(new Date());
    const dataIso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const row = await getRowByData(supabase, dataIso);
    if (!row) return;
    const patch = {};
    ['draft', 'poprawka', 'final'].forEach((state) => {
      const column = DOCS.umowa[state];
      const json = row[column];
      if (json && setZamknieteByPhone(json, phoneDigits)) patch[column] = json;
    });
    if (Object.keys(patch).length) await updateRowByData(supabase, dataIso, patch);
  } catch (err) {
    console.warn('Nie udało się oznaczyć case\'a jako zamkniętego w dzisiejszej Umowie:', err.message);
  }
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

    // `numer_klienta` jawnie w payloadzie (Make wie na pewno, które pole u
    // niego jest numerem klienta w danej gałęzi) ma pierwszeństwo — eliminacja
    // przez porównanie z własnym numerem zostaje jako fallback dla webhooka
    // prosto z Zadarmy, bez pośrednictwa Make.
    const ownNumber = normalizePhoneDigits(process.env.ZADARMA_OWN_NUMBER);
    const candidates = [call.caller_id, call.called_did, call.dst]
      .map(normalizePhoneDigits)
      .filter((d) => d && d !== ownNumber);
    const customerDigits = normalizePhoneDigits(call.numer_klienta) || candidates[0] || '';

    let lead = await findLeadByPhone(supabase, customerDigits);
    // Wyceny B2C sprawdzane tylko gdy telefon nie pasuje do żadnego leada —
    // Leady B2C ma pierwszeństwo, bo to tam dzieje się faktyczna obsługa CRM.
    const wycena = lead ? null : await findWycenaByPhone(supabase, customerDigits);

    const answered = Boolean(call.record_url);
    // Make ma już własny krok transkrypcji (fallback, zostaje u niego) — jeśli
    // dołączy gotowy tekst w polu `transcript`, używamy go zamiast drugi raz
    // ściągać nagranie i płacić za Whisper. Własna transkrypcja tylko gdy tego
    // pola brak (webhook prosto z Zadarmy, bez pośrednictwa Make). Pole
    // przychodzi zakodowane base64 — surowa transkrypcja mowy potrafi zawierać
    // znaki nowej linii/cudzysłowy, które łamałyby Make'owi ręcznie pisany
    // "JSON string" w body (błąd "Bad control character in string literal").
    let transcript = call.transcript ? Buffer.from(call.transcript, 'base64').toString('utf8') : '';
    if (answered && !transcript) {
      try {
        const audioRes = await fetch(call.record_url);
        const buffer = Buffer.from(await audioRes.arrayBuffer());
        transcript = await transcribeAudioBuffer(buffer, 'audio/mpeg');
      } catch (err) {
        console.warn('Nie udało się pobrać/transkrybować nagrania:', err.message);
      }
    }

    const label = answered ? 'answered' : 'no_answer';
    // Wnioskowanie z called_did/dst zawodzi, gdy pośrednik (Make) mapuje oba
    // pola naraz albo pomyli szablon gałęzi — most przez Make zna kierunek na
    // pewno (osobny "Watch" per typ połączenia), więc jawne pole `kierunek` w
    // payloadzie ma pierwszeństwo. called_did/dst zostaje jako fallback dla
    // webhooka prosto z Zadarmy (bez pośrednictwa Make, tam nie ma tej dwuznaczności).
    const kierunek = call.kierunek || (call.called_did ? 'przychodzące' : call.dst ? 'wychodzące' : null);

    const statusBefore = lead ? lead['Deal stage'] : wycena ? wycena['Status'] : null;
    const opisBefore = lead ? lead['Notes'] : wycena ? wycena['Komentarz'] : null;
    const feedbackBefore = lead ? lead['Data Feedbacku'] : wycena ? wycena['Data Feedbacku'] : null;

    // Pełna analiza GPT tylko dla odebranych połączeń z transkrypcją — dla
    // nieodebranych nie ma czego analizować (patrz statusAfter niżej).
    // poprzedniOpis: dotychczasowy skrócony opis kontaktu ("Ocena AI
    // kontaktu") — GPT regeneruje go po każdej rozmowie jako żywą pigułkę
    // całego kontaktu (pole skrocony_opis w odpowiedzi).
    const analysis = (answered && transcript)
      ? await analyzeCall(transcript, { kierunek, dzisiaj: warsawDateStr(new Date()), poprzedniOpis: lead ? lead['Ocena AI kontaktu'] : null, poprzedniaAkcja: lead ? lead['Najbliższa akcja'] : null })
      : null;
    const opis = analysis?.opis || (transcript ? transcript.slice(0, 200) : label);

    // Wpis do "Historia rozmów" — jedna linia na rozmowę, najnowsze na
    // górze, format zgodny z historycznymi wpisami migrowanymi z Notes
    // ("DD.MM.YYYY HH:mm - treść") — podsumowania rozmów NIE trafiają już
    // do Notes (opis = ręczna notatka handlowca).
    const callStartDate = call.callstart ? new Date(call.callstart) : new Date();
    const historiaEntry = `${warsawDateTimeStr(Number.isNaN(callStartDate.getTime()) ? new Date() : callStartDate)} - ${answered ? opis : 'Nie odebrał'}`;

    // Status nigdy nie cofa się w dół lejka — patrz STATUS_RANK/statusRank.
    // "Nie odebrał" traktowane osobno (nie przez rangę): wolno wejść w nie
    // TYLKO z wczesnego etapu (Nowy/Po pierwszym tel/Przyszłościowy) — lead
    // z "Wycena wysłana", który nie odbiera telefonu, zostaje przy "Wycena
    // wysłana", a nie cofa się na "Nie odebrał".
    const leadClosed = lead && ['Sprzedane', 'Stracony'].includes(statusBefore);
    let statusAfter = statusBefore;
    if (lead && !leadClosed) {
      if (label === 'no_answer') {
        if (!statusBefore || NO_ANSWER_ALLOWED_FROM.has(statusBefore)) statusAfter = 'Nie odebrał';
      } else if (analysis?.status && statusRank(analysis.status) >= statusRank(statusBefore)) {
        statusAfter = analysis.status;
      }
    }
    const feedbackAfter = (lead && analysis?.data_feedbacku) ? analysis.data_feedbacku : feedbackBefore;

    // Najbliższa akcja: odebrana rozmowa z analizą zawsze REEWALUUJE pole —
    // w odróżnieniu od produktów/kwoty/oceny AI (tam pusty wynik analizy nie
    // czyści pola) tu null od GPT znaczy "akcja wykonana / nic nowego nie
    // umówiono" i świadomie nadpisujemy nim kolumnę. Nieodebrane
    // (analysis=null → setAkcja=false) nie dotykają pola wcale. Status
    // zamykający lejek czyści akcję niezależnie od odpowiedzi GPT.
    const setAkcja = Boolean(analysis);
    const akcjaPoRozmowie = (!['Sprzedane', 'Stracony'].includes(statusAfter) && analysis?.najblizsza_akcja) || null;
    const akcjaTermin = akcjaPoRozmowie ? (analysis?.najblizsza_akcja_termin || null) : null;
    const akcjaOwner = akcjaPoRozmowie ? (call.pracownik || process.env.DEFAULT_HANDLOWIEC || null) : null;

    // Telefon bez dopasowania w Leady B2C/Wyceny B2C — bez tego rozmowa
    // zostawałaby tylko w Log zmian, niewidoczna w panelu i "gubiona" przez
    // handlowca. Tworzymy nowy lead automatycznie (kolumna "Źródło" oznacza,
    // że to nie z formularza — patrz kategoria "rozmowy_spoza_bazy" w cronie
    // Umowy), żeby każde połączenie miało swój case w backlogu.
    let createdLead = null;
    if (!lead && !wycena && customerDigits) {
      // "ID Leada" (dawniej "ID Wyceny" — przemianowane w bazie, to zwykły
      // wewnętrzny identyfikator leada, nie numer wyceny) jest NOT NULL bez
      // wartości domyślnej — to sekwencyjny licznik, który dotychczas nadawał
      // ręcznie Make (nie Postgresowa identity/serial), więc trzeba go policzyć samemu.
      const { data: maxRow } = await supabase
        .from(LEADY_B2C_TABLE)
        .select('"ID Leada"')
        .order('"ID Leada"', { ascending: false })
        .limit(1)
        .single();
      const nextIdLeada = (Number(maxRow?.['ID Leada']) || 0) + 1;

      const { data: inserted, error: createErr } = await supabase
        .from(LEADY_B2C_TABLE)
        .insert({
          'Phone number': Number(customerDigits),
          Date: warsawDateStr(new Date()),
          'Deal stage': 'Nowy',
          // Notes zostaje puste — to ręczna notatka handlowca. Podsumowanie
          // rozmowy idzie do skróconego opisu (Ocena AI kontaktu) i do
          // Historii rozmów.
          'Ocena AI kontaktu': analysis?.skrocony_opis || (answered ? opis : null),
          'Historia rozmów': historiaEntry,
          'Najbliższa akcja': akcjaPoRozmowie,
          'Najbliższa akcja termin': akcjaTermin,
          'Najbliższa akcja owner': akcjaOwner,
          'Ostatni kontakt': call.callstart || null,
          Źródło: 'Zadarma — rozmowa bez dopasowania w bazie',
          'Treść rozmowy': transcript || null,
          'ID Leada': nextIdLeada,
        })
        .select()
        .single();
      if (createErr) {
        console.error('Błąd tworzenia leada z nieznanego numeru:', createErr.message);
      } else {
        createdLead = inserted;
        await notifyNewLead(formatPhonePlus(customerDigits));
      }
    }

    const { error: insertErr } = await supabase.from(LOG_ZMIAN_TABLE).insert({
      zrodlo: 'zadarma_webhook',
      telefon: customerDigits || null,
      status_przed: statusBefore,
      status_po: statusAfter,
      opis,
      opis_przed: opisBefore,
      opis_po: opisBefore,
      data_feedbacku_przed: feedbackBefore,
      data_feedbacku_po: feedbackAfter,
      kierunek,
      // Czy z tym tematem trzeba jeszcze coś zrobić DZISIAJ, wg oceny GPT
      // (patrz ZASADY zamkniete_dzis w buildCallAnalysisPrompt) — pokazywane
      // w widoku "Połączenia" (app.html), żeby było widać co się dziś fizycznie
      // wydarzyło bez klikania w każdy case osobno.
      zamkniete_dzis: Boolean(analysis?.zamkniete_dzis),
      transkrypcja: transcript || null,
      // `pracownik` w payloadzie (wpisany ręcznie w Make, per scenariusz/osoba)
      // ma pierwszeństwo nad DEFAULT_HANDLOWIEC — ten drugi zostaje jako
      // fallback dla webhooka prosto z Zadarmy, zanim dojdzie SIP-lookup.
      handlowiec: call.pracownik || process.env.DEFAULT_HANDLOWIEC || null,
      czas_trwania_s: Number(call.duration) || 0,
      disposition: label,
      pbx_call_id: call.pbx_call_id || null,
      dopasowano_tabela: lead ? LEADY_B2C_TABLE : wycena ? WYCENY_B2C_TABLE : createdLead ? LEADY_B2C_TABLE : null,
      // Leady B2C ma "ID" prawie zawsze puste (populowane przez Make tylko,
      // gdy jest wycena — to w praktyce kopia ID z Wyceny B2C, nie klucz tej
      // tabeli) — dla nowo tworzonego leada nie ma go jeszcze skąd wziąć,
      // więc identyfikujemy po telefonie, jedynym polu po którym cała reszta
      // kodu i tak dopasowuje Leady B2C (patrz findLeadByPhone/update wyżej).
      dopasowano_id: lead ? String(lead['ID'] ?? '') : wycena ? wycena['ID'] : createdLead ? String(createdLead['Phone number'] ?? '') : null,
    });
    if (insertErr) console.error('Błąd zapisu Log zmian:', insertErr.message);

    if (lead) {
      const patch = {
        'Ilość telefonów': (Number(lead['Ilość telefonów']) || 0) + 1,
        'Ostatni kontakt': call.callstart || null,
        'Treść rozmowy': transcript || lead['Treść rozmowy'] || null,
        // statusAfter — patrz wyżej, ta sama decyzja co poszła do Log zmian
        // (status_po), żeby oba miejsca nigdy się nie rozjechały.
        'Deal stage': statusAfter,
        'Data Feedbacku': feedbackAfter,
        // Historia rozmów rośnie przy KAŻDYM połączeniu (odebranym i nie) —
        // nowy wpis na górę, dotychczasowe bez zmian.
        'Historia rozmów': lead['Historia rozmów'] ? `${historiaEntry}\n${lead['Historia rozmów']}` : historiaEntry,
      };
      // Produkty/kwota/skrócony opis: nadpisujemy TYLKO gdy ta rozmowa
      // faktycznie coś nowego dorzuciła — pusty wynik analizy nie ma czyścić
      // tego, co już wcześniej ustalono w poprzednich rozmowach.
      if (analysis?.produkty) patch['Produkty z wyceny'] = analysis.produkty;
      const cenaZaproponowana = parseKwotaZlotych(analysis?.cena_zaproponowana);
      if (cenaZaproponowana !== null) patch['Kwota wyceny'] = cenaZaproponowana;
      // "Ocena AI kontaktu" = skrócony opis kontaktu: żywa pigułka całego
      // kontaktu, regenerowana przez GPT po każdej odebranej rozmowie na
      // podstawie poprzedniej wersji + tej rozmowy (patrz analyzeCall).
      if (analysis?.skrocony_opis) patch['Ocena AI kontaktu'] = analysis.skrocony_opis;

      // RPC zamiast zwykłego .update() — ustawia transaction-local flagę
      // bypass, żeby trigger log_zmian_from_leady (patrz migracja
      // add-log-zmian-manual-capture.js) nie zdublował wpisu, który już
      // jawnie wstawiliśmy wyżej (insert do LOG_ZMIAN_TABLE).
      const { error: updateErr } = await supabase.rpc('app_update_leady_after_call', {
        p_phone: lead['Phone number'],
        p_ilosc_telefonow: String(patch['Ilość telefonów']),
        p_ostatni_kontakt: patch['Ostatni kontakt'],
        p_tresc_rozmowy: patch['Treść rozmowy'],
        p_deal_stage: patch['Deal stage'],
        p_data_feedbacku: patch['Data Feedbacku'],
        p_produkty: patch['Produkty z wyceny'] ?? null,
        p_kwota: patch['Kwota wyceny'] ?? null,
        p_ocena_ai: patch['Ocena AI kontaktu'] ?? null,
        p_historia: patch['Historia rozmów'] ?? null,
        p_set_akcja: setAkcja,
        p_akcja: akcjaPoRozmowie,
        p_akcja_termin: akcjaTermin,
        p_akcja_owner: akcjaOwner,
        // Tylko NOWA godzina z tej rozmowy — zachowanie/czyszczenie starej
        // rozstrzyga RPC względem zmiany daty (add-godzina-feedbacku.js):
        // nowa data bez godziny czyści starą godzinę, brak nowej daty nie
        // dotyka jej wcale.
        p_godzina_feedbacku: analysis?.data_feedbacku ? (analysis.godzina_feedbacku || null) : null,
      });
      if (updateErr) console.error('Błąd update Leady B2C:', updateErr.message);

      // Jeśli GPT ocenił, że temat jest zaopiekowany na dziś — oznacz ten
      // case jako zamknięty (ta sama flaga co lokalny checkbox po lewej w
      // liście, ale tu zapisana do Supabase) w dzisiejszej Umowie, żeby
      // spadł na dół listy automatycznie, bez ręcznego klikania.
      if (analysis?.zamkniete_dzis && customerDigits) {
        await markZamknieteInUmowa(supabase, customerDigits);
      }
    }

    await logOperation(supabase, 'zadarma_webhook', 'ok', {
      pbx_call_id: call.pbx_call_id,
      telefon: customerDigits,
      dopasowano_leada: Boolean(lead),
      dopasowano_wycene: Boolean(wycena),
      nowy_lead_bez_dopasowania: Boolean(createdLead),
      transkrypcja: Boolean(transcript),
      zamkniete_dzis: Boolean(analysis?.zamkniete_dzis),
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
        // Notes to teraz czysta ręczna notatka handlowca (podsumowania rozmów
    // żyją w "Historia rozmów"/"Ocena AI kontaktu") — gdy notatki brak,
    // dawaj modelowi skrócony opis kontaktu, żeby case nie był pustką.
    opis: row['Notes'] || row['Ocena AI kontaktu'] || '',
        data_feedbacku: row['Data Feedbacku'] || '',
        godzina_feedbacku: row['Godzina Feedbacku'] || '',
        temperatura: row['Temperatura'] || '',
        ostatni_kontakt: row['Ostatni kontakt'] || '',
        ilosc_telefonow: row['Ilość telefonów'] || 0,
        produkty: row['Produkty z wyceny'] || '',
        link_formularz: row['Link do formularza'] || '',
        data_wyceny: row['Data wysłania wyceny'] || '',
        // Ten endpoint nie sprawdza w ogóle Wyceny B2C, więc nie ma tu skąd
        // wziąć prawdziwego id_wyceny — tylko id_lida (wewnętrzny numer
        // leada, kolumna "ID Leada", bez związku z realną wyceną).
        id_wyceny: '',
        id_lida: row['ID Leada'] || '',
        ma_wycene: false,
        kwota: row['Kwota wyceny'] || 0,
        zadzwonil_dzis: false,
        zamkniete: 0,
        najblizsza_akcja: row['Najbliższa akcja'] || '',
        najblizsza_akcja_termin: row['Najbliższa akcja termin'] || '',
        najblizsza_akcja_owner: row['Najbliższa akcja owner'] || '',
      }));
    res.json(rows);
  } catch (err) {
    handleError(res, err, 502);
  }
});

// ── Najbliższa akcja + notatki handlowca ────────────────────────────────────
// "Najbliższa akcja" = krótki (max 5-6 słów) następny krok z leadem. Endpointy
// notatki handlowca (POST /api/leady/notatka), edycji/odhaczenia akcji (POST
// /api/leady/akcja) oraz karty leada (PUT /api/leady/:idLeada, GET
// /api/leady/pelny, GET /api/leady/:telefon/historia|wycena) żyją we wspólnym
// module apps/shared/server/leady-endpoints.js — te same ścieżki rejestruje
// CRM, implementacja w jednym miejscu.
registerLeadyEndpoints(app, { getClient });

// Endpointy wycen (nowa tabela) — karta leada w Backlogu pokazuje wycenę w tym
// samym formacie co panel Wyceny i pozwala ją edytować (zapis do bazy = cross-
// ref). Bramka panelu już chroni; widoczność per owner siedzi w endpointach.
const wycenyAllow = (req, res, next) => next();
registerWycenyEndpoints(app, {
  getClient,
  requireView: wycenyAllow,
  requireEdit: wycenyAllow,
  isAdmin,
});

// Wszystkie leady z ustawioną najbliższą akcją — frontend nakłada to na
// wyrenderowane case'y po telefonie (pigułka jest żywa w ciągu dnia, mimo że
// dokument Umowy to migawka z rana). To samo zapytanie posłuży przyszłemu
// panelowi głównemu ("aktywne akcje na dziś").
app.get('/api/leady/akcje', async (req, res) => {
  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from(LEADY_B2C_TABLE)
      .select('"Phone number", "Name", "Deal stage", "Najbliższa akcja", "Najbliższa akcja termin", "Najbliższa akcja owner"')
      .not('Najbliższa akcja', 'is', null);
    if (error) throw error;
    const rows = (data || [])
      .filter((row) => String(row['Najbliższa akcja'] || '').trim())
      .map((row) => ({
        telefon: formatPhonePlus(row['Phone number']),
        imie: row['Name'] || '',
        status: row['Deal stage'] || '',
        akcja: row['Najbliższa akcja'],
        termin: row['Najbliższa akcja termin'] || '',
        owner: row['Najbliższa akcja owner'] || '',
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
function warsawDateTimeStr(date = new Date()) {
  const { y, m, d, hh, mm } = warsawParts(date);
  return `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y} ${hh}:${mm}`;
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

// Leady B2C i Wyceny B2C nie mają wspólnego klucza obcego — "ID Leada" w
// Leady B2C to mały sekwencyjny numer własny tej tabeli (1, 3, 4…), a "ID" w
// Wyceny B2C to zupełnie inna numeracja ("#1529", "#1815"…). Jedyne wspólne
// pole to numer telefonu (tak samo dopasowuje leady do wycen webhook Zadarmy
// — patrz findWycenaByPhone). Budujemy więc mapę telefon → dane wyceny (id,
// kwota, data stworzenia, link do formularza, produkty) raz, dla wszystkich
// kategorii naraz — mapLeadRow używa jej jako uzupełnienia/poprawki własnych
// pól leada (patrz komentarz przy mapLeadRow, dlaczego to nie jest tylko fallback).
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

async function fetchWycenaByPhone(supabase) {
  const { data, error } = await supabase
    .from(WYCENY_B2C_TABLE)
    .select('Telefon,produkty_json,ID,Kwota,"Data stworzenia","Link do formularza"');
  if (error) throw error;
  const map = new Map();
  (data || []).forEach((row) => {
    const digits = normalizePhoneDigits(row['Telefon']);
    if (!digits || map.has(digits)) return;
    map.set(digits, {
      produkty: formatProdukty(row['produkty_json']),
      id: row['ID'] || '',
      kwota: Number(row['Kwota']) || 0,
      dataStworzenia: row['Data stworzenia'] || '',
      linkFormularz: row['Link do formularza'] || '',
    });
  });
  return map;
}

// "Ile razy dzwoniono do tego leada" liczone z realnych wierszy "Log zmian"
// (każdy telefon, niezależnie od tego, czy dopasował się do Leady B2C/Wyceny
// B2C) — nie z legacy skażonej kolumny "Ilość telefonów" w Leady B2C.
async function fetchCallCountByPhone(supabase) {
  // Notatki handlowca i ręczne zmiany akcji żyją w tej samej tabeli (zrodlo:
  // notatka_handlowca / manual_akcja / manual_crm — pełna lista:
  // NIE_TELEFON_ZRODLA we wspólnym module) — to nie są telefony, nie liczymy ich.
  const { data, error } = await supabase.from(LOG_ZMIAN_TABLE).select('telefon, zrodlo');
  if (error) throw error;
  const map = new Map();
  (data || []).forEach((row) => {
    if (NIE_TELEFON_ZRODLA.has(row['zrodlo'])) return;
    const digits = normalizePhoneDigits(row['telefon']);
    if (!digits) return;
    map.set(digits, (map.get(digits) || 0) + 1);
  });
  return map;
}

function mapLeadRow(row, wycenaByPhone, callCountByPhone) {
  const phoneDigits = normalizePhoneDigits(row['Phone number']);
  const wycena = wycenaByPhone && phoneDigits ? wycenaByPhone.get(phoneDigits) : undefined;
  const linkFormularz = row['Link do formularza'] || (wycena && wycena.linkFormularz) || '';
  // Samo dopasowanie telefonu do wiersza w Wyceny B2C NIE wystarcza, żeby
  // uznać to za "prawdziwą wycenę" — taki wiersz może istnieć bez realnie
  // wygenerowanego linku. Rozstrzyga wyłącznie obecność linku do wyceny: jest
  // link → id_wyceny/Data wyceny/Kwota są prawdziwe; nie ma linku → to tylko
  // notatka z rozmowy, pokazujemy id_lida zamiast id_wyceny.
  const maWycene = Boolean(linkFormularz);
  return {
    id: row['ID'] || '',
    // "ID Leada" to wewnętrzny, auto-inkrementowany numer leada w TEJ tabeli
    // (patrz miejsce, gdzie webhook Zadarmy go nadaje nowym leadom) — osobne
    // pole, zawsze widoczne. NIE ma nic wspólnego z realnym numerem wyceny
    // (ten ma format "#1659" i istnieje tylko gdy jest link do wyceny) —
    // id_wyceny zostaje puste, jeśli linku nie ma.
    id_wyceny: maWycene ? ((wycena && wycena.id) || '') : '',
    id_lida: row['ID Leada'] || '',
    // Czy ten case ma realnie wygenerowaną Wycenę (link) — front pokazuje to
    // inaczej (inne etykiety, "Proponowana kwota" zamiast "Kwota" itp.).
    ma_wycene: maWycene,
    data_dolaczenia: row['Date'] || '',
    imie: row['Name'] || '',
    telefon: formatPhonePlus(row['Phone number']),
    email: row['Email'] || '',
    status: row['Deal stage'] || '',
    // Notes to teraz czysta ręczna notatka handlowca (podsumowania rozmów
    // żyją w "Historia rozmów"/"Ocena AI kontaktu") — gdy notatki brak,
    // dawaj modelowi skrócony opis kontaktu, żeby case nie był pustką.
    opis: row['Notes'] || row['Ocena AI kontaktu'] || '',
    data_feedbacku: formatPlDate(row['Data Feedbacku']),
    godzina_feedbacku: row['Godzina Feedbacku'] || '',
    temperatura: row['Temperatura'] || '',
    ostatni_kontakt: row['Ostatni kontakt'] || '',
    // Deterministyczne, nadpisywane w postProcessCallCounts z realnych
    // wierszy "Log zmian" po telefonie — "Ilość telefonów" w Supabase ma
    // legacy skażone dane (string-konkatenacja), to tu tylko placeholder.
    ilosc_telefonow: (callCountByPhone && phoneDigits && callCountByPhone.get(phoneDigits)) || 0,
    produkty: (wycena && wycena.produkty) || row['Produkty z wyceny'] || '',
    link_formularz: linkFormularz,
    // Data/kwota pokazują się niezależnie od maWycene (front tylko zmienia
    // etykietę) — bez linku to nadal użyteczna informacja, tylko nieformalna
    // (data/kwota z rozmowy, nie z wysłanego dokumentu).
    data_wyceny: row['Data wysłania wyceny'] || (wycena && wycena.dataStworzenia) || '',
    kwota: Number(row['Kwota wyceny']) || (wycena && wycena.kwota) || 0,
    // Migawka z momentu generowania Umowy — front i tak nadpisuje ją na
    // żywo z GET /api/leady/akcje (akcja zmienia się w ciągu dnia po każdej
    // rozmowie/notatce), ale dzięki migawce pigułka jest widoczna od
    // pierwszego renderu, bez mrugnięcia.
    najblizsza_akcja: row['Najbliższa akcja'] || '',
    najblizsza_akcja_termin: row['Najbliższa akcja termin'] || '',
    najblizsza_akcja_owner: row['Najbliższa akcja owner'] || '',
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
  // Leady oznaczone "Źródło" (rozmowa bez dopasowania, patrz
  // fetchRozmowySpozaBazy) mają własną kategorię — bez tego filtra
  // pojawiłyby się też tutaj (Deal stage="Nowy" trafia w fetchNowe).
  let query = supabase.from(LEADY_B2C_TABLE).select('*').is('Źródło', null);
  query = excludeStages
    ? query.not('Deal stage', 'in', `(${excludeStages.map((s) => `"${s}"`).join(',')})`)
    : query.eq('Deal stage', stage);
  const { data, error } = await query;
  if (error) throw error;

  // Facebook Lead Ads potrafi wysłać ten sam formularz dwa razy (retry
  // webhooka) — Leady B2C wtedy ma dwa wiersze z tym samym telefonem, a bez
  // odfiltrowania ten sam człowiek wychodził w Umowie dwa razy pod tym samym
  // LP w tej samej kategorii (reassignLps daje duplikatom po telefonie ten
  // sam LP, bo tak łączy wystąpienia case'a między kategoriami — tu jednak
  // to dwa wiersze tej samej osoby, nie dwa różne miejsca). Ten sam wzorzec
  // dedupu co w fetchZalegleFeedbacki.
  const seenPhones = new Set();
  return (data || []).filter((row) => {
    const digits = normalizePhoneDigits(row['Phone number']);
    if (!digits) return true;
    if (seenPhones.has(digits)) return false;
    seenPhones.add(digits);
    return true;
  });
}

async function fetchNowe(supabase, wycenaByPhone, callCountByPhone) {
  const rows = await fetchLeadyByStage(supabase, 'Nowy');
  const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
  return rows
    .map((row) => ({ row, date: parseLeadDate(row['Date']) }))
    .filter(({ date }) => date && date.getTime() >= cutoff)
    .sort((a, b) => b.date - a.date)
    .slice(0, 10)
    .map(({ row }) => mapLeadRow(row, wycenaByPhone, callCountByPhone));
}

// Ograniczone do ostatnich 3 dni (dziś + 3 dni wstecz) — starsze przeterminowane
// feedbacki i tak trafiają do "Zaległe feedbacki" (fetchZalegleFeedbacki, bez
// limitu dni), więc bez tego okna te dwie kategorie by się duplikowały.
async function fetchWycenyZFeedbackiem(supabase, wycenaByPhone, callCountByPhone) {
  const rows = await fetchLeadyByStage(supabase, 'Wycena wysłana');
  const now = Date.now();
  const cutoff = now - 3 * 24 * 60 * 60 * 1000;
  return rows
    .map((row) => ({ row, date: parseLeadDate(row['Data Feedbacku']) }))
    .filter(({ date }) => date && date.getTime() <= now && date.getTime() >= cutoff)
    .sort((a, b) => a.date - b.date || Number(b.row['Kwota wyceny'] || 0) - Number(a.row['Kwota wyceny'] || 0))
    .map(({ row }) => mapLeadRow(row, wycenaByPhone, callCountByPhone));
}

async function fetchInneZFeedbackiem(supabase, wycenaByPhone, callCountByPhone) {
  const rows = await fetchLeadyByStage(supabase, null, ['Wycena wysłana', 'Stracony', 'Sprzedane']);
  const now = Date.now();
  const cutoff = now - 3 * 24 * 60 * 60 * 1000;
  return rows
    .map((row) => ({ row, date: parseLeadDate(row['Data Feedbacku']) }))
    .filter(({ date }) => date && date.getTime() <= now && date.getTime() >= cutoff)
    .sort((a, b) => a.date - b.date || Number(b.row['Kwota wyceny'] || 0) - Number(a.row['Kwota wyceny'] || 0))
    .map(({ row }) => mapLeadRow(row, wycenaByPhone, callCountByPhone));
}

// Okno 7 dni liczone od "Ostatni kontakt" (kiedy faktycznie nie odebrano), nie
// od "Date" (kiedy lead powstał) — stary lead z dziś nieodebranym telefonem
// ma się tu pojawić, a nie wypadać tylko bo powstał dawno temu.
async function fetchNieodebrane(supabase, wycenaByPhone, callCountByPhone) {
  const rows = await fetchLeadyByStage(supabase, 'Nie odebrał');
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return rows
    .map((row) => ({ row, date: parseLeadDate(row['Ostatni kontakt']) }))
    .filter(({ date }) => date && date.getTime() >= cutoff)
    .sort((a, b) => (Number(b.row['Ilość telefonów']) || 0) - (Number(a.row['Ilość telefonów']) || 0) || b.date - a.date)
    .slice(0, 10)
    .map(({ row }) => mapLeadRow(row, wycenaByPhone, callCountByPhone));
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
async function fetchZalegleFeedbacki(supabase, wycenaByPhone, callCountByPhone) {
  const { data, error } = await supabase
    .from(LEADY_B2C_TABLE)
    .select('*')
    .is('Źródło', null)
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

  return deduped.map((row) => mapLeadRow(row, wycenaByPhone, callCountByPhone));
}

// Leady, które istnieją TYLKO dlatego, że kto zadzwonił na numer bez
// dopasowania w bazie (webhook Zadarmy je sam tworzy — patrz
// /api/webhooks/zadarma, kolumna "Źródło"). Dopóki handlowiec nie ruszy
// statusu dalej, siedzą tu, żeby nic nie "uciekło" bez triage'u — jak status
// się zmieni, naturalnie trafiają do zwykłej kategorii jak każdy inny lead
// (i wypadają stąd, bo filtr niżej jest na Deal stage = "Nowy").
async function fetchRozmowySpozaBazy(supabase, wycenaByPhone, callCountByPhone) {
  const { data, error } = await supabase
    .from(LEADY_B2C_TABLE)
    .select('*')
    .not('Źródło', 'is', null)
    .eq('Deal stage', 'Nowy');
  if (error) throw error;
  return (data || []).map((row) => mapLeadRow(row, wycenaByPhone, callCountByPhone));
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

// Wariant fetchLogZmianRange z pełną transkrypcją/opisem rozmowy — tylko dla
// /api/cron/podsumowanie-dnia (GPT ma czytać REALNĄ treść rozmów, nie tylko
// status_przed/status_po). Osobna funkcja zamiast rozszerzania
// fetchLogZmianRange, żeby nie napompować promptu umowa-draft (ten czyta
// dane z tej samej tabeli, ale nigdy nie potrzebował transkrypcji).
async function fetchLogZmianDzisPelne(supabase, start, end) {
  const { data, error } = await supabase
    .from(LOG_ZMIAN_TABLE)
    .select('*')
    .gte('data_zmiany', start.toISOString())
    .lt('data_zmiany', end.toISOString())
    .order('data_zmiany', { ascending: false });
  if (error) throw error;
  return (data || []).map((row) => ({
    telefon: formatPhonePlus(row['telefon']),
    // zrodlo odróżnia rozmowy od notatek handlowca — buildCalledTodaySet
    // pomija notatki (dodanie notatki to nie "zadzwonił dziś"), a model w
    // prompcie widzi, że wpis jest notatką, nie telefonem.
    zrodlo: row['zrodlo'] || '',
    status_przed: row['status_przed'] || '',
    status_po: row['status_po'] || '',
    opis: row['opis'] || '',
    // Ucięte na wypadek wyjątkowo długiej rozmowy — nadal daje modelowi
    // realną treść (ustalenia, kwoty, zastrzeżenia), nie tylko streszczenie
    // z `opis`, bez ryzyka rozdmuchania promptu jednym telefonem.
    transkrypcja: (row['transkrypcja'] || '').slice(0, 2000),
    disposition: row['disposition'] || '',
    czas_trwania_s: row['czas_trwania_s'] || 0,
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
    if (NIE_TELEFON_ZRODLA.has(row.zrodlo)) return;
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
// wyniku modelu. Lead, który już gdzieś w dokumencie ma przydzielony LP
// (nowe/wyceny_z_feedbackiem/inne_z_feedbackiem/nieodebrane/wyceny_historyczne/
// priorytet_dzis), jest tu POMIJANY — inaczej wychodził dwa razy na liście
// pod tym samym LP (np. każdy z "inne z feedbackiem ostatnie 3 dni" i tak ma
// przeterminowany feedback, więc bez tego wykluczenia lądował też w
// "zaległe feedbacki"). Leady, które nigdzie indziej się nie pojawiły,
// dostają świeży LP kontynuujący istniejącą numerację.
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

// Ten sam wzorzec co applyZalegleFeedbacki — kategoria budowana deterministycznie
// z już przygotowanych danych (webhook Zadarmy sam tworzy leada dla numeru bez
// dopasowania, patrz server.js /api/webhooks/zadarma), model jej nie dotyka.
function applyRozmowySpozaBazy(parsed, rozmowySpozaBazyRaw, phoneToLp, nextLp) {
  let next = nextLp;
  const result = rozmowySpozaBazyRaw.map((lead) => {
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
  parsed.kategorie.rozmowy_spoza_bazy = result;
  return next;
}

function applyZalegleFeedbacki(parsed, zalegleRaw, phoneToLp, nextLp) {
  let next = nextLp;
  // Case, który model już umieścił gdzieś indziej (nowe/wyceny_z_feedbackiem/
  // inne_z_feedbackiem/nieodebrane/wyceny_historyczne/priorytet_dzis — czyli
  // ma telefon w phoneToLp) pomijamy tutaj całkowicie, zamiast dublować go
  // pod tym samym LP w drugiej kategorii. Bez tego np. "inne z feedbackiem
  // ostatnie 3 dni" i "zaległe feedbacki" pokazywały tego samego człowieka
  // dwa razy — okno 3 dni w fetchWycenyZFeedbackiem/fetchInneZFeedbackiem
  // nie chroni przed tym, bo "zaległe" (fetchZalegleFeedbacki) bierze
  // WSZYSTKIE przeterminowane feedbacki bez ograniczenia dni, co się z nim
  // pokrywa.
  const result = [];
  zalegleRaw.forEach((lead) => {
    const digits = normalizePhoneDigits(lead.telefon);
    if (digits && phoneToLp.has(digits)) return;
    const lp = next;
    next += 1;
    if (digits) phoneToLp.set(digits, lp);
    result.push({ ...lead, lp, row_number: 0, zamkniete: 0, zadzwonil_dzis: false });
  });

  parsed.kategorie = parsed.kategorie || {};
  parsed.kategorie.zalegle_feedbacki = result;
}

// Kategorie "planu dnia" w których ma sens oznaczanie zaległości z wczoraj —
// wyceny_historyczne/zalegle_feedbacki to z definicji otwarte, ciągłe listy
// (nie "dzisiejszy plan"), więc oznaczanie ich jako na_jutro nic by nie
// wnosiło.
const NA_JUTRO_KATEGORIE = ['nowe', 'wyceny_z_feedbackiem', 'inne_z_feedbackiem', 'nieodebrane'];

// Telefony niezamkniętych case'ów we wczorajszej Umowie (priorytet_dzis + 4
// kategorie wyżej) — dostają dziś widoczną flagę na_jutro (patrz
// applyNaJutroCarryover). Case i tak pojawi się dziś niezależnie od tego
// (kategorie budowane z żywego stanu bazy) — to tylko wizualne oznaczenie
// "to zaległe z wczoraj" (żółta kropka w app.html).
function collectNaJutroCandidates(umowaJson) {
  const phones = new Set();
  if (!umowaJson) return phones;
  const consider = (arr) => {
    if (!Array.isArray(arr)) return;
    arr.forEach((item) => {
      if (!item || item.zamkniete === 1 || !item.telefon) return;
      const digits = normalizePhoneDigits(item.telefon);
      if (digits) phones.add(digits);
    });
  };
  consider(umowaJson.priorytet_dzis);
  const kat = umowaJson.kategorie || {};
  NA_JUTRO_KATEGORIE.forEach((key) => consider(kat[key]));
  return phones;
}

function applyNaJutroCarryover(parsed, carryPhones) {
  if (!carryPhones.size) return;
  const mark = (arr) => {
    if (!Array.isArray(arr)) return;
    arr.forEach((item) => {
      if (item && item.telefon && carryPhones.has(normalizePhoneDigits(item.telefon))) {
        item.na_jutro = true;
      }
    });
  };
  mark(parsed.priorytet_dzis);
  const kat = parsed.kategorie || {};
  NA_JUTRO_KATEGORIE.forEach((key) => mark(kat[key]));
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

function buildStatusByPhone(rows) {
  const map = new Map();
  (rows || []).forEach((row) => {
    const digits = normalizePhoneDigits(row.telefon);
    if (digits && row.status) map.set(digits, row.status);
  });
  return map;
}

// Model bywa niekonsekwentny co do tego, czy odda pole "status" w każdym
// case'ie (zaobserwowane: obecne w priorytet_dzis/nowe, brakujące w innych
// kategoriach) — front pokazuje pigułkę statusu tylko gdy c.status jest
// prawdziwe, więc brak pola = case bez statusu w UI. Wymuszamy je tu
// deterministycznie z tych samych danych źródłowych, którymi model był
// zasilony (dopasowanie po telefonie), zamiast ufać, że wiernie przepisał.
function postProcessStatus(parsed, leadyStatusByPhone, wycenyStatusByPhone) {
  const patchWith = (arr, statusMap) => {
    if (!Array.isArray(arr)) return;
    arr.forEach((item) => {
      if (!item || typeof item !== 'object' || !item.telefon) return;
      const status = statusMap.get(normalizePhoneDigits(item.telefon));
      if (status) item.status = status;
    });
  };
  const patchEither = (arr) => {
    if (!Array.isArray(arr)) return;
    arr.forEach((item) => {
      if (!item || typeof item !== 'object' || !item.telefon) return;
      const digits = normalizePhoneDigits(item.telefon);
      const status = leadyStatusByPhone.get(digits) || wycenyStatusByPhone.get(digits);
      if (status) item.status = status;
    });
  };
  patchEither(parsed.priorytet_dzis);
  if (parsed.kategorie && typeof parsed.kategorie === 'object') {
    patchWith(parsed.kategorie.nowe, leadyStatusByPhone);
    patchWith(parsed.kategorie.wyceny_z_feedbackiem, leadyStatusByPhone);
    patchWith(parsed.kategorie.inne_z_feedbackiem, leadyStatusByPhone);
    patchWith(parsed.kategorie.nieodebrane, leadyStatusByPhone);
    patchWith(parsed.kategorie.wyceny_historyczne, wycenyStatusByPhone);
  }
}

// "ilosc_telefonow" — jak status, model ma to pole tylko przepisać z danych
// wejściowych ("celowo puste"), ale nie ufamy, że to zrobi konsekwentnie w
// każdym case'ie. Wymuszamy z callCountByPhone (patrz fetchCallCountByPhone)
// — to jedyne prawdziwe źródło, licz z realnych wierszy "Log zmian".
function postProcessCallCounts(parsed, callCountByPhone) {
  const patch = (arr) => {
    if (!Array.isArray(arr)) return;
    arr.forEach((item) => {
      if (!item || typeof item !== 'object' || !item.telefon) return;
      item.ilosc_telefonow = callCountByPhone.get(normalizePhoneDigits(item.telefon)) || 0;
    });
  };
  patch(parsed.priorytet_dzis);
  if (parsed.kategorie && typeof parsed.kategorie === 'object') {
    patch(parsed.kategorie.nowe);
    patch(parsed.kategorie.wyceny_z_feedbackiem);
    patch(parsed.kategorie.inne_z_feedbackiem);
    patch(parsed.kategorie.nieodebrane);
    // wyceny_historyczne nie ma tego pola w schemacie — celowo pominięte.
  }
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

Pola każdego leada: \`id\`, \`id_wyceny\`, \`data_dolaczenia\`, \`imie\`, \`telefon\`, \`email\`, \`status\`, \`opis\` (notatki handlowca — surowe, do przeczytania i zrozumienia sprawy, ale w WYJŚCIU masz napisać własną syntezę, patrz sekcja "Pole opis w wyjściu" niżej), \`data_feedbacku\`, \`temperatura\`, \`ostatni_kontakt\`, \`ilosc_telefonow\` (już policzone z realnych połączeń — przepisz jak jest, nie licz go), \`produkty\`, \`link_formularz\`, \`data_wyceny\`, \`kwota\`.

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

### Pole \`opis\` w wyjściu (dotyczy wszystkich kategorii leadów, nie wyceny_historyczne)
NIE kopiuj notatek handlowca (wejściowe \`opis\`) 1:1 do wyjścia. Napisz własnymi słowami syntetyczne podsumowanie stanu sprawy, maks. 3 zdania: co się wydarzyło, na czym konkretnie stoi sprawa, jaki jest następny krok — z realnymi szczegółami (kwoty, terminy, produkty, ustalenia), nie ogólnikowo ("kontakt nawiązany", "czeka na odpowiedź"). Jeśli dla tego telefonu jest coś w LOG ZMIAN/LOG TELEFONÓW DZIŚ, uwzględnij to też. To pole zastępuje starą "ocenę AI" — ma być treściwe, nie krótsze niż notatka, tylko lepiej napisane.

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
      "ilosc_telefonow": "", "produkty": "", "link_formularz": "", "data_wyceny": "",
      "kwota": 0, "zadzwonil_dzis": false, "zamkniete": 0
    }
  ],
  "kategorie": {
    "nowe": [
      {
        "lp": 0, "row_number": 0, "id_wyceny": "", "data_dolaczenia": "", "imie": "", "telefon": "", "email": "",
        "status": "", "opis": "", "data_feedbacku": "", "temperatura": "", "ostatni_kontakt": "",
        "ilosc_telefonow": "", "produkty": "", "link_formularz": "", "data_wyceny": "",
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

    // Osobno, przed resztą — leady-fetche potrzebują tych map do wypełnienia
    // pól produkty/kwota/data_wyceny/link_formularz/id_wyceny/ilosc_telefonow.
    const [wycenaByPhone, callCountByPhone] = await Promise.all([
      fetchWycenaByPhone(supabase),
      fetchCallCountByPhone(supabase),
    ]);

    const [standupLog, logZmianWczoraj, logZmianDzis, nowe, wycenyZFeedbackiem, inneZFeedbackiem, nieodebrane, wycenyHistoryczne, zalegleRaw, rozmowySpozaBazyRaw] = await Promise.all([
      fetchStandupLog3(supabase),
      fetchLogZmianRange(supabase, wczoraj.start, wczoraj.end),
      fetchLogZmianRange(supabase, dzis.start, dzis.end),
      fetchNowe(supabase, wycenaByPhone, callCountByPhone),
      fetchWycenyZFeedbackiem(supabase, wycenaByPhone, callCountByPhone),
      fetchInneZFeedbackiem(supabase, wycenaByPhone, callCountByPhone),
      fetchNieodebrane(supabase, wycenaByPhone, callCountByPhone),
      fetchWycenyHistoryczne(supabase),
      fetchZalegleFeedbacki(supabase, wycenaByPhone, callCountByPhone),
      fetchRozmowySpozaBazy(supabase, wycenaByPhone, callCountByPhone),
    ]);

    const calledSet = buildCalledTodaySet(logZmianDzis);

    // Wczorajsza Umowa (final → poprawka → draft, ten sam priorytet co
    // fetchStandupLog3) — źródło dla carryover na_jutro (patrz
    // collectNaJutroCandidates/applyNaJutroCarryover niżej). wczoraj.start to
    // już wyliczony instant UTC dla wczorajszej północy Warszawy, więc
    // warsawParts go poprawnie odwraca na y/m/d wczorajszego dnia.
    const { y: wczorajY, m: wczorajM, d: wczorajD } = warsawParts(wczoraj.start);
    const wczorajDataIso = `${wczorajY}-${String(wczorajM).padStart(2, '0')}-${String(wczorajD).padStart(2, '0')}`;
    const wczorajszaUmowaRow = await getRowByData(supabase, wczorajDataIso);
    const wczorajszaUmowa = wczorajszaUmowaRow
      ? (wczorajszaUmowaRow[DOCS.umowa.final] || wczorajszaUmowaRow[DOCS.umowa.poprawka] || wczorajszaUmowaRow[DOCS.umowa.draft])
      : null;
    const carryPhones = collectNaJutroCandidates(wczorajszaUmowa);

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
    const nextLpPoBazie = applyRozmowySpozaBazy(parsed, rozmowySpozaBazyRaw, phoneToLp, nextLp);
    applyZalegleFeedbacki(parsed, zalegleRaw, phoneToLp, nextLpPoBazie);
    fixLpMentionsInComment(parsed);
    postProcessCalledToday(parsed, calledSet);
    postProcessCounts(parsed);
    const leadyStatusByPhone = buildStatusByPhone([...nowe, ...wycenyZFeedbackiem, ...inneZFeedbackiem, ...nieodebrane, ...zalegleRaw]);
    const wycenyStatusByPhone = buildStatusByPhone(wycenyHistoryczne);
    postProcessStatus(parsed, leadyStatusByPhone, wycenyStatusByPhone);
    postProcessCallCounts(parsed, callCountByPhone);
    applyNaJutroCarryover(parsed, carryPhones);

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

// ── Podsumowanie dnia (cron wieczorny) ──────────────────────────────────────
// Umowa (final → poprawka → draft) to plan dnia; Log zmian dzisiaj (włącznie
// z ręcznymi zmianami w CRM — patrz trigger log_zmian_from_leady/
// log_zmian_from_wyceny, migracja add-log-zmian-manual-capture.js) to co się
// faktycznie wydarzyło. Liczniki w `plan` liczone tu deterministycznie (ten
// sam wzorzec co postProcessCounts w Umowie) — modelowi dajemy do napisania
// WYŁĄCZNIE `komentarz_dzienny` (krótkie bullet pointy), bez duplikowania
// kategorii/list leadów z Umowy (nie ma takiej potrzeby, patrz plan).
function buildPodsumowanieSystemPrompt(dzisiaj) {
  return `Jesteś asystentem operacyjnym LumLum (premium oświetlenie LED COB, lumlum.co).
Piszesz krótkie podsumowanie dnia dla handlowca Lorenzzo: porównanie dzisiejszego planu (Umowa) z tym, co faktycznie się wydarzyło (Log zmian).
Generujesz WYŁĄCZNIE czysty JSON — bez tekstu przed, bez komentarza, bez markdown, bez backtick. Dokładnie ten kształt: {"punkty": [{"tekst": "...", "typ": "dobre"}]}.

## DANE WEJŚCIOWE

Dzisiejsza data: ${dzisiaj}.

**PRIORYTET DZIŚ** — case'y zaplanowane na dziś, pole \`zamkniete\` (1 = załatwione, 0 = nie).
**LOG ZMIAN DZIŚ** — realne wiersze rozmów telefonicznych i zmian statusu dzisiaj: telefon, status_przed/status_po, disposition, \`opis\` (krótkie streszczenie rozmowy) i \`transkrypcja\` (pełna treść rozmowy, gdy była nagrana — najbogatsze źródło).

## ZADANIE

Przeczytaj \`transkrypcja\`/\`opis\` każdej rozmowy — to Twoje główne źródło, nie tylko status_przed/status_po. Wyłap z nich REALNE, konkretne szczegóły (kwoty, terminy, konkretne zastrzeżenia lub decyzje klienta) — nie ogólnikuj ("rozmowa przebiegła pozytywnie" to źle; "klient potwierdził montaż na 15.07, czeka na wycenę 2 zasilaczy" to dobrze).

Zwróć \`punkty\`: tablicę 4-8 obiektów, każdy jeden konkretny fakt/wydarzenie z dziś, po polsku, max ~15-20 słów — krótko mimo bogatszego materiału źródłowego, bez wstępu/podpisu/liczników (te liczone osobno). Każdy obiekt ma:
- \`tekst\`: samo zdanie, np. "Sebastian Ludyga — potwierdził 8 pasków, czeka na dobór sterownika od Antoniego."
- \`typ\`: jedno z \`"dobre"\` (sukces/pozytywny postęp — sprzedaż, wysłana wycena, zamknięty case, konkretna deklaracja klienta), \`"problem"\` (coś utknęło/nie wyszło — nieodebrany telefon, brak odpowiedzi, zastrzeżenie klienta, przełożone bez konkretu), \`"neutralne"\` (fakt/ustalenie bez wydźwięku)

Priorytet: najpierw najważniejsze "dobre", potem najważniejsze "problem". Jeśli oba zestawy danych są puste, zwróć jeden punkt typu "neutralne" wprost mówiący, że nic się dziś nie wydarzyło.`;
}

app.all('/api/cron/podsumowanie-dnia', async (req, res) => {
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

    const dzis = warsawDayRange(0);
    const [row, logZmianDzis] = await Promise.all([
      getRowByData(supabase, dataIso),
      fetchLogZmianDzisPelne(supabase, dzis.start, dzis.end),
    ]);
    const umowa = row ? (row[DOCS.umowa.final] || row[DOCS.umowa.poprawka] || row[DOCS.umowa.draft]) : null;
    const priorytetDzis = Array.isArray(umowa?.priorytet_dzis) ? umowa.priorytet_dzis : [];

    const zamkniete = priorytetDzis.filter((i) => i && i.zamkniete === 1).length;
    const niezamkniete = priorytetDzis.length - zamkniete;
    const plan = {
      // Bez wykonane_telefony: ta liczba już jest w karcie "Realizacja
      // planu" (zawsze widocznej, żywe dane z Log zmian) tuż pod spodem —
      // powtarzanie jej tu było zbędne.
      zmienione_statusy: logZmianDzis.filter((r) => r.status_przed !== r.status_po).length,
      zakupione_dzis: logZmianDzis.filter((r) => r.status_po === 'Sprzedane' && r.status_przed !== 'Sprzedane').length,
      wyslane_wyceny: logZmianDzis.filter((r) => r.status_po === 'Wycena wysłana' && r.status_przed !== 'Wycena wysłana').length,
      nieodebrane: logZmianDzis.filter((r) => r.disposition === 'no_answer').length,
      priorytet_zamkniete: zamkniete,
      priorytet_niezamkniete: niezamkniete,
      przelozone_na_jutro: niezamkniete,
    };

    const userContent = [
      `Dzisiejsza data: ${dzisiaj}`,
      '',
      'PRIORYTET DZIŚ:',
      JSON.stringify(priorytetDzis.map((i) => ({ lp: i.lp, imie: i.imie, telefon: i.telefon, zamkniete: i.zamkniete }))),
      '',
      'LOG ZMIAN DZIŚ:',
      JSON.stringify(logZmianDzis),
    ].join('\n');

    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: UMOWA_MODEL,
        response_format: { type: 'json_object' },
        reasoning_effort: 'minimal',
        messages: [
          { role: 'system', content: buildPodsumowanieSystemPrompt(dzisiaj) },
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
    let parsedAi;
    try {
      parsedAi = JSON.parse(content);
    } catch {
      throw new Error('AI zwróciło JSON, którego nie da się sparsować');
    }

    const punkty = Array.isArray(parsedAi?.punkty)
      ? parsedAi.punkty
          .filter((p) => p && p.tekst)
          .map((p) => ({ tekst: String(p.tekst), typ: ['dobre', 'problem', 'neutralne'].includes(p.typ) ? p.typ : 'neutralne' }))
      : [];

    const parsed = {
      data: dzisiaj,
      wygenerowano: godzina,
      status: 'draft',
      punkty,
      plan,
    };

    // Zwykły update (nie upsert) po `Data` — jak w /api/ai-edit/approve.
    // Upsert nie zadziała tu: "Umowa - draft - JSON" ma NOT NULL, a Postgres
    // sprawdza NOT NULL na proponowanym wierszu PRZED próbą ON CONFLICT DO
    // UPDATE (nawet gdy wiersz z tą datą już istnieje) — upsert samą kolumną
    // podsumowania zawsze by się wywalał. Dzień bez wygenerowanej Umowy nie
    // ma zresztą z czym porównywać, więc brak wiersza to prawdziwy błąd, nie
    // przypadek do obsłużenia insertem.
    if (!row) throw new Error(`Brak dzisiejszej Umowy (${dataIso}) — cron umowa-draft musi zadziałać wcześniej`);
    await updateRowByData(supabase, dataIso, { [DOCS.podsumowanie.draft]: parsed });

    await logOperation(supabase, 'podsumowanie_dnia_cron', 'ok', { data: dataIso, wygenerowano: godzina });
    res.json({ json: parsed });
  } catch (err) {
    await logOperation(supabase, 'podsumowanie_dnia_cron', 'error', { data: dataIso, message: err.message });
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

// Historia rozmów jednego numeru, chronologicznie — do rozwijanej "Historia
// rozmów" pod Opisem case'a w app.html. Bez limitu daty (na odróżnienie od
// /api/log-polaczen, które jest per-dzień) — na telefon i tak nie ma tysięcy
// wierszy, więc jedno zapytanie po `telefon` wystarcza.
app.get('/api/log-polaczen/historia', async (req, res) => {
  try {
    const supabase = getClient();
    const digits = normalizePhoneDigits(req.query.telefon);
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
