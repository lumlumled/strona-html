// ── Wspólne endpointy leada (Backlog B2C + CRM) ─────────────────────────────
// Jedno źródło prawdy dla API, którego wymaga wspólna karta leada
// (apps/shared/lead-card.js). Oba serwery wołają registerLeadyEndpoints(app,
// { getClient }) PO swoim middleware auth — kod przeniesiony 1:1 z
// apps/crm/server/server.js (PUT pola / historia / wycena) i
// apps/backlog-b2c/server/server.js (notatka handlowca / najbliższa akcja).
// Vercel dociąga ten plik automatycznie przez trace require() — nie trzeba
// go dopisywać do includeFiles.

const LEADY_B2C_TABLE = 'Leady B2C';
const WYCENY_B2C_TABLE = 'Wyceny B2C';
const LOG_ZMIAN_TABLE = 'Log zmian';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Ten sam model co analiza rozmów/Umowa w Backlogu — ekstrakcja akcji z
// notatki to drobne zadanie, gpt-5-mini wystarcza i jest szybki.
const NOTATKA_MODEL = process.env.OPENAI_UMOWA_MODEL || 'gpt-5-mini';

// Kolumny "Leady B2C" edytowalne z karty (styl arkusza — zapis wprost do
// bazy). Celowo WYŁĄCZONE: "Phone number" (klucz łączący z Log zmian/Wyceny
// B2C), "ID"/"ID Leada" (numeracja systemowa), "Źródło" (tylko webhook),
// "Kwota wyceny" (decyzja Antoniego 2026-07-11: kwotę zmienia się z poziomu
// wyceny — przyszły panel Wyceny — nie z poziomu leada; webhook/RPC dalej
// ją zapisuje, bo idzie poza tą listą).
const EDITABLE_LEAD_FIELDS = [
  'Date',
  'Name',
  'Email',
  'Deal stage',
  'Notes',
  'Data Feedbacku',
  // Opcjonalna godzina umówionego feedbacku "HH:mm" (osobna kolumna — "Data
  // Feedbacku" jest parsowana sztywnym DD.MM.YYYY, patrz
  // scripts/add-godzina-feedbacku.js); zasila przypomnienia push.
  'Godzina Feedbacku',
  'Temperatura',
  'Ostatni kontakt',
  'Ilość telefonów',
  'Treść rozmowy',
  'Produkty z wyceny',
  'Data wysłania wyceny',
  'Link do formularza',
  'Ocena AI kontaktu',
  // Kolumny-metadane akcji ("... termin"/"... owner") celowo poza listą:
  // edytuje je automat i POST /api/leady/akcja.
  'Najbliższa akcja',
  // Właściciel leada (docs/plan-wlasnosc-zasobow.md) — wartość to
  // app_users.name; zmienia się kółeczkiem w prawym górnym rogu karty.
  // Domyślną wartość nowym leadom nadaje DEFAULT kolumny w Postgresie
  // (jedno miejsce konfiguracji — patrz scripts/add-owner-leady.js).
  'Owner',
];

// Źródła w "Log zmian", które NIE są telefonami — nie liczą się do
// "Ilość telefonów"/"Skontaktowane dziś" (notatki, ręczne zmiany akcji,
// ręczne edycje pól złapane triggerem manual_crm).
const NIE_TELEFON_ZRODLA = new Set(['notatka_handlowca', 'manual_akcja', 'manual_crm']);

function normalizePhoneDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

function formatPhonePlus(raw) {
  const digits = normalizePhoneDigits(raw);
  if (!digits) return '';
  return digits.startsWith('48') ? `+${digits}` : `+48${digits}`;
}

function warsawParts(date = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Warsaw', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), hh: parts.hour, mm: parts.minute };
}

function warsawDateStr(date = new Date()) {
  const { y, m, d } = warsawParts(date);
  return `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`;
}

function warsawDateTimeStr(date = new Date()) {
  const { y, m, d, hh, mm } = warsawParts(date);
  return `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y} ${hh}:${mm}`;
}

function handleError(res, err, fallbackStatus = 400) {
  console.error(err);
  const message = err.message || 'Wewnętrzny błąd serwera';
  const status = /brak/i.test(message) ? 500 : fallbackStatus;
  res.status(status).json({ error: message });
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

// Dopasowanie Wyceny B2C po znormalizowanym telefonie — skan zamiast .eq(),
// bo "Telefon" w tej tabeli bywa zapisany z formatowaniem (spacje, "+48").
async function findWycenaByPhoneScan(supabase, phoneDigits) {
  const { data, error } = await supabase.from(WYCENY_B2C_TABLE).select('*');
  if (error) throw error;
  return (data || []).find((r) => normalizePhoneDigits(r['Telefon']) === phoneDigits) || null;
}

// Czy lead ma wycenę w NOWEJ tabeli `wyceny` (nie legacy "Wyceny B2C"). Steruje
// tylko flagą _ma_wycene na karcie (etykiety "Kwota"/"Proponowana kwota" i
// chowanie pól legacy) — dlatego wystarczy istnienie choćby jednego wiersza.
// Match jak w GET /api/wyceny/dla-leada: po lead_id ORAZ telefon_digits
// (telefon_digits = cyfry bez prefiksu 48, spójnie z zapisem w tej tabeli).
async function hasWycenaNowa(supabase, phoneDigits, leadId) {
  const ors = [];
  // "ID Leada" bywa numeric (np. "314" albo "314.0"); kanoniczny lead_id w
  // wycenach to liczba całkowita jako tekst ("314") — normalizujemy jak w
  // GET /api/wyceny/szukaj-leada, inaczej "314.0" nie trafiłoby w "314".
  const lidNum = Number(leadId);
  if (Number.isFinite(lidNum)) ors.push(`lead_id.eq.${lidNum}`);
  if (phoneDigits) ors.push(`telefon_digits.eq.${phoneDigits}`);
  if (!ors.length) return false;
  const { data, error } = await supabase
    .from('wyceny')
    .select('id')
    .or(ors.join(','))
    .limit(1);
  if (error) throw error;
  return (data || []).length > 0;
}

// Ekstrakcja akcji z ręcznej notatki handlowca. null NIE czyści
// dotychczasowej akcji — notatka bez wynikającego kroku zostawia ją w spokoju.
function buildNotatkaAnalysisPrompt(dzisiaj, poprzedniaAkcja) {
  return `Jesteś asystentem CRM firmy LumLum (oświetlenie LED premium).
Dostajesz RĘCZNĄ NOTATKĘ handlowca zapisaną przy leadzie (poza rozmową telefoniczną).
Zwróć WYŁĄCZNIE jeden obiekt JSON. Bez komentarzy, bez markdownu, bez tekstu przed ani po.

DZISIAJ: ${dzisiaj}

===== ZASADY najblizsza_akcja =====
To krótka etykieta na case'ie leada — następny KONKRETNY krok do zrobienia.
Maksymalnie 5-6 słów, tryb rozkazujący, po polsku, z terminem jeśli padł:
"zadzwoń za 3 dni" → "Zadzwonić DD.MM" (przelicz względem DZISIAJ)
"wyślij mu wycenę smsem" → "Wysłać wycenę SMS-em"
Daty względne ("jutro", "za tydzień", "w piątek") ZAWSZE przelicz na konkretną datę.

DOTYCHCZASOWA NAJBLIŻSZA AKCJA (może być pusta):
"""
${poprzedniaAkcja || ''}
"""
- z notatki wynika nowy następny krok → wpisz go
- z notatki NIE wynika żaden krok → null (null tu NIE czyści dotychczasowej
  akcji — zostaje bez zmian); NIE wymyślaj akcji z ogólników
- notatka mówi wprost, że coś zostało zrobione/nieaktualne i nic nowego nie
  planuje → też null

najblizsza_akcja_termin: konkretny moment wykonania akcji, jeśli padł.
Format "DD.MM.YYYY HH:mm" (z godziną) albo "DD.MM.YYYY" (sam dzień). Brak → null.

===== ZASADY data_feedbacku =====
WYŁĄCZNIE termin kolejnego kontaktu telefonicznego z klientem, jeśli notatka
go wskazuje ("zadzwonić za 3 dni", "kontakt w piątek"). Przelicz względem
DZISIAJ, format DD.MM.YYYY. Inne daty (koniec budowy, odbiór mieszkania) → null.

===== ZASADY godzina_feedbacku =====
Wypełnij TYLKO gdy przy terminie kolejnego kontaktu padła KONKRETNA godzina
("zadzwonić jutro o 15" → "15:00", "kontakt pon 14:30" → "14:30"). Format
HH:MM (24h). Sam dzień bez godziny → null (NIE wymyślaj godziny). Pory dnia
("rano", "po południu") → null. Gdy data_feedbacku = null → też ZAWSZE null.

===== FORMAT WYJŚCIOWY =====
{
  "najblizsza_akcja": "max 5-6 słów lub null",
  "najblizsza_akcja_termin": "DD.MM.YYYY HH:mm lub DD.MM.YYYY lub null",
  "data_feedbacku": "DD.MM.YYYY lub null",
  "godzina_feedbacku": "HH:MM lub null"
}`;
}

async function analyzeNotatka(tresc, { dzisiaj, poprzedniaAkcja }) {
  const fallback = { najblizsza_akcja: null, najblizsza_akcja_termin: null, data_feedbacku: null, godzina_feedbacku: null };
  if (!OPENAI_API_KEY || !tresc) return fallback;
  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: NOTATKA_MODEL,
        response_format: { type: 'json_object' },
        reasoning_effort: 'minimal',
        messages: [
          { role: 'system', content: buildNotatkaAnalysisPrompt(dzisiaj, poprzedniaAkcja) },
          { role: 'user', content: tresc },
        ],
      }),
    });
    if (!aiRes.ok) return fallback;
    const body = await aiRes.json();
    const parsed = JSON.parse(body.choices?.[0]?.message?.content || '');
    return { ...fallback, ...parsed };
  } catch (err) {
    console.warn('Analiza notatki (GPT) nie powiodła się:', err.message);
    return fallback;
  }
}

// requireView/requireEdit — opcjonalne middleware uprawnień (CRM egzekwuje
// nimi dostęp per arkusz: podgląd dla odczytów, edycja dla zapisów). Backlog
// ich nie przekazuje — dostęp do panelu Backlog = pełny dzienny workflow.
function registerLeadyEndpoints(app, { getClient, requireView, requireEdit }) {
  const passthrough = (req, res, next) => next();
  const view = requireView || passthrough;
  const edit = requireEdit || passthrough;

  // PUT /api/leady/:idLeada — { field, value } — zapis JEDNEGO pola, zwykły
  // update (celowo NIE przez RPC) — trigger trg_log_zmian_from_leady sam
  // loguje zmianę do "Log zmian" z zrodlo='manual_crm'. Klucz to "ID Leada"
  // (unikalny), NIE telefon — 5 numerów jest współdzielonych przez >1 wiersz.
  app.put('/api/leady/:idLeada', edit, async (req, res) => {
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

  // GET /api/leady/owners — lista możliwych właścicieli leada do kółeczka na
  // karcie: aktywne konta app_users + wartości już użyte w kolumnie "Owner"
  // (unia, bo Lorenzo może być ownerem zanim dostanie konto w Pozwoleniach).
  app.get('/api/leady/owners', view, async (req, res) => {
    try {
      const supabase = getClient();
      const [usersRes, ownersRes] = await Promise.all([
        supabase.from('app_users').select('name').eq('active', true),
        supabase.from(LEADY_B2C_TABLE).select('Owner'),
      ]);
      if (usersRes.error) throw usersRes.error;
      if (ownersRes.error) throw ownersRes.error;
      const names = new Set();
      (usersRes.data || []).forEach((u) => u.name && names.add(String(u.name).trim()));
      (ownersRes.data || []).forEach((r) => r.Owner && names.add(String(r.Owner).trim()));
      names.delete('');
      res.json({ data: [...names].sort((a, b) => a.localeCompare(b, 'pl')) });
    } catch (err) {
      handleError(res, err, 502);
    }
  });

  // GET /api/leady/pelny?telefon= — surowy wiersz Leady B2C wzbogacony o pola
  // wyliczane, w DOKŁADNIE tym samym kształcie co elementy listy z GET
  // /api/leady w CRM — zasila wspólną kartę leada w Backlogu.
  app.get('/api/leady/pelny', view, async (req, res) => {
    try {
      const supabase = getClient();
      const digits = normalizePhoneDigits(req.query.telefon);
      if (!digits) return res.status(400).json({ error: 'Brak parametru telefon' });

      const lead = await findLeadByPhone(supabase, digits);
      if (!lead) return res.status(404).json({ error: 'Nie znaleziono leada o tym numerze' });

      // _ma_wycene liczymy z NOWEJ tabeli `wyceny` (lead_id/telefon), nie z
      // legacy "Wyceny B2C" — inaczej wyceny z nowego systemu dawały false
      // i karta pokazywała "Proponowana kwota"/pola legacy zamiast "Kwota".
      const [maWycene, logRows] = await Promise.all([
        hasWycenaNowa(supabase, digits.replace(/^48/, ''), lead['ID Leada']),
        supabase.from(LOG_ZMIAN_TABLE).select('data_zmiany,zrodlo').eq('telefon', digits)
          .then(({ data, error }) => {
            if (error) throw error;
            return data || [];
          }),
      ]);

      const todayKey = new Date().toISOString().slice(0, 10);
      let count = 0;
      let dzisiaj = false;
      logRows.forEach((row) => {
        if (NIE_TELEFON_ZRODLA.has(row.zrodlo)) return;
        count += 1;
        if (row.data_zmiany && String(row.data_zmiany).slice(0, 10) === todayKey) dzisiaj = true;
      });

      res.json({
        data: {
          ...lead,
          _telefon_digits: digits,
          _telefon_formatted: formatPhonePlus(lead['Phone number']),
          _ma_wycene: maWycene,
          _ilosc_polaczen: count,
          _kontakt_dzisiaj: dzisiaj,
        },
      });
    } catch (err) {
      handleError(res, err, 502);
    }
  });

  // GET /api/leady/:telefon/historia — cała historia połączeń/zmian tego
  // telefonu z Log zmian, chronologicznie (fallback Historii rozmów w karcie).
  app.get('/api/leady/:telefon/historia', view, async (req, res) => {
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
  // telefonie, z produkty_json jako tablicą. Read-only z założenia.
  app.get('/api/leady/:telefon/wycena', view, async (req, res) => {
    try {
      const supabase = getClient();
      const digits = normalizePhoneDigits(req.params.telefon);
      if (!digits) return res.status(400).json({ error: 'Brak parametru telefon' });
      res.json({ data: await findWycenaByPhoneScan(supabase, digits) });
    } catch (err) {
      handleError(res, err, 502);
    }
  });

  // POST /api/leady/notatka — ręczna notatka handlowca. Dual-write: wiersz w
  // Log zmian (zrodlo: notatka_handlowca) + linia "[Notatka]" na górze kolumny
  // "Historia rozmów". GPT po drodze wyciąga akcję/termin/datę feedbacku.
  app.post('/api/leady/notatka', edit, async (req, res) => {
    try {
      const digits = normalizePhoneDigits(req.body?.telefon);
      const tresc = String(req.body?.tresc || '').trim();
      if (!digits) return res.status(400).json({ error: 'Brak numeru telefonu' });
      if (!tresc) return res.status(400).json({ error: 'Pusta notatka' });

      const supabase = getClient();
      const lead = await findLeadByPhone(supabase, digits);
      if (!lead) return res.status(404).json({ error: 'Nie znaleziono leada o tym numerze' });

      const handlowiec = req.body?.handlowiec || process.env.DEFAULT_HANDLOWIEC || null;
      const extract = await analyzeNotatka(tresc, {
        dzisiaj: warsawDateStr(new Date()),
        poprzedniaAkcja: lead['Najbliższa akcja'] || null,
      });
      // Notatka bez wynikającej z niej akcji NIE dotyka dotychczasowej
      // (p_set_akcja=false) — inaczej niż rozmowa, która reevaluuje.
      const setAkcja = Boolean(extract?.najblizsza_akcja);

      const historiaEntry = `${warsawDateTimeStr(new Date())} - [Notatka] ${tresc}`;

      const { error: insertErr } = await supabase.from(LOG_ZMIAN_TABLE).insert({
        zrodlo: 'notatka_handlowca',
        telefon: digits,
        opis: tresc,
        handlowiec,
        dopasowano_tabela: LEADY_B2C_TABLE,
        dopasowano_id: String(lead['ID'] ?? ''),
      });
      if (insertErr) throw new Error(`Zapis notatki do Log zmian: ${insertErr.message}`);

      const { error: updateErr } = await supabase.rpc('app_update_leady_notatka', {
        p_phone: lead['Phone number'],
        p_historia: lead['Historia rozmów'] ? `${historiaEntry}\n${lead['Historia rozmów']}` : historiaEntry,
        p_set_akcja: setAkcja,
        p_akcja: setAkcja ? extract.najblizsza_akcja : null,
        p_akcja_termin: setAkcja ? (extract.najblizsza_akcja_termin || null) : null,
        p_akcja_owner: setAkcja ? handlowiec : null,
        p_data_feedbacku: extract?.data_feedbacku || null,
        // Godzina tylko razem z datą — RPC czyści starą godzinę przy nowej
        // dacie bez godziny, a bez nowej daty nie dotyka jej wcale.
        p_godzina_feedbacku: extract?.data_feedbacku ? (extract?.godzina_feedbacku || null) : null,
      });
      if (updateErr) throw new Error(`Zapis notatki do Leady B2C: ${updateErr.message}`);

      res.json({
        zapisano: true,
        akcja: setAkcja
          ? { akcja: extract.najblizsza_akcja, termin: extract.najblizsza_akcja_termin || '', owner: handlowiec || '' }
          : null,
        data_feedbacku: extract?.data_feedbacku || null,
        godzina_feedbacku: extract?.data_feedbacku ? (extract?.godzina_feedbacku || null) : null,
      });
    } catch (err) {
      handleError(res, err, 502);
    }
  });

  // POST /api/leady/akcja — ręczna edycja/skasowanie/odhaczenie najbliższej
  // akcji. Kluczem jest telefon (działa też dla leadów spoza dziennej Umowy).
  // Puste `akcja` = skasowanie; z flagą `wykonane: true` = "zrobione dziś"
  // (ptaszek na pigułce/karcie): czyści akcję, loguje wykonanie i dopisuje
  // linię "[Akcja] Zrobione: ..." do kolumny "Historia rozmów".
  app.post('/api/leady/akcja', edit, async (req, res) => {
    try {
      const digits = normalizePhoneDigits(req.body?.telefon);
      if (!digits) return res.status(400).json({ error: 'Brak numeru telefonu' });

      const supabase = getClient();
      const lead = await findLeadByPhone(supabase, digits);
      if (!lead) return res.status(404).json({ error: 'Nie znaleziono leada o tym numerze' });

      const akcja = String(req.body?.akcja || '').trim() || null;
      const termin = akcja ? (String(req.body?.termin || '').trim() || null) : null;
      const owner = akcja
        ? (req.body?.owner || lead['Najbliższa akcja owner'] || process.env.DEFAULT_HANDLOWIEC || null)
        : null;
      const wykonane = !akcja && Boolean(req.body?.wykonane) && Boolean(lead['Najbliższa akcja']);
      const poprzednia = lead['Najbliższa akcja'] || '';

      const historiaEntry = wykonane
        ? `${warsawDateTimeStr(new Date())} - [Akcja] Zrobione: ${poprzednia}`
        : null;

      const { error: updateErr } = await supabase.rpc('app_update_leady_notatka', {
        p_phone: lead['Phone number'],
        p_historia: historiaEntry
          ? (lead['Historia rozmów'] ? `${historiaEntry}\n${lead['Historia rozmów']}` : historiaEntry)
          : null,
        p_set_akcja: true,
        p_akcja: akcja,
        p_akcja_termin: termin,
        p_akcja_owner: owner,
      });
      if (updateErr) throw new Error(updateErr.message);

      // Ślad ręcznej zmiany w Log zmian — spójnie z zasadą "ręczne edycje są
      // logowane" (RPC ma bypass triggera, więc wpis robimy jawnie tu).
      const { error: logErr } = await supabase.from(LOG_ZMIAN_TABLE).insert({
        zrodlo: 'manual_akcja',
        telefon: digits,
        opis: akcja
          ? `Najbliższa akcja (ręcznie): ${akcja}${termin ? ` [${termin}]` : ''}`
          : (wykonane ? `Akcja wykonana: ${poprzednia}` : 'Najbliższa akcja usunięta ręcznie'),
        handlowiec: owner || lead['Najbliższa akcja owner'] || null,
        dopasowano_tabela: LEADY_B2C_TABLE,
        dopasowano_id: String(lead['ID'] ?? ''),
      });
      if (logErr) console.error('Błąd zapisu manual_akcja do Log zmian:', logErr.message);

      res.json({ akcja: akcja || '', termin: termin || '', owner: owner || '' });
    } catch (err) {
      handleError(res, err, 502);
    }
  });
}

module.exports = { registerLeadyEndpoints, EDITABLE_LEAD_FIELDS, NIE_TELEFON_ZRODLA };
