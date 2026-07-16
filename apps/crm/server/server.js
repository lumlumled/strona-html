require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { getClient } = require('./supabase');
const { registerLeadyEndpoints, EDITABLE_LEAD_FIELDS, NIE_TELEFON_ZRODLA } = require('../../shared/server/leady-endpoints');
const { registerWycenyEndpoints } = require('../../shared/server/wyceny-endpoints');
const { registerKontaktEndpoints } = require('../../shared/server/kontakt-endpoints');
const { createAuth, clientPayload, panelLinks, isAdmin, userCanSheet } = require('../../shared/server/auth');
const { servePushWorker, registerPushEndpoints } = require('../../shared/server/push');

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

// Indywidualne konta (tabela app_users) — wspólny moduł auth rejestruje
// /login, /logout i bramkę panelu. Ciasteczko z Path=/ podpisane
// SESSION_SECRET (fallback SITE_PASSWORD) — jedno logowanie na całą domenę.
// Poza dostępem do panelu CRM uprawnienia są per ARKUSZ: requireSheet niżej
// egzekwuje podgląd/edycję "Leady B2C" na poziomie endpointów.
// Assets/shared PRZED bramką auth — strona logowania też potrzebuje logo
// i wspólnych styli, a to statyki bez wrażliwych danych.
app.get('/assets/:file', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'assets', req.params.file));
});

// Wspólna karta leada (apps/shared/) — te same pliki serwuje Backlog pod
// swoim /shared/, żeby obie appki renderowały leada identycznie.
app.get('/shared/:file', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'shared', req.params.file));
});

const auth = createAuth({ getClient, panelKey: 'crm', loginTitle: 'CRM' });
// /sw.js przed bramką auth (publiczny statyk — patrz apps/shared/server/push.js),
// endpointy /api/push/* za bramką (user z sesji).
servePushWorker(app);
auth.register(app);
registerPushEndpoints(app, { getClient });

const SHEET_LEADY = 'leady-b2c';
const requireLeadyView = auth.requireSheet(SHEET_LEADY, 'view');
const requireLeadyEdit = auth.requireSheet(SHEET_LEADY, 'edit');

// Druga lista CRM: Organic — kontakty i wiadomości spoza Leady B2C
// (decyzja Antoniego 2026-07-16). Własny arkusz w Pozwoleniach.
const SHEET_ORGANIC = 'organic';
const requireOrganicView = auth.requireSheet(SHEET_ORGANIC, 'view');
const requireOrganicEdit = auth.requireSheet(SHEET_ORGANIC, 'edit');

// Zakładka Wyceny — osobny arkusz z własnymi uprawnieniami (na start widzi
// go tylko Antoni/admin; Lorenzo dostanie per owner w panelu Pozwolenia).
// Endpointy wspólne z panelem Sprzedaże: apps/shared/server/wyceny-endpoints.js.
registerWycenyEndpoints(app, {
  getClient,
  requireView: auth.requireSheet('wyceny', 'view'),
  requireEdit: auth.requireSheet('wyceny', 'edit'),
  isAdmin,
});

const APP_HTML_TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');

app.get('/', (req, res) => {
  // Poza API_BASE wstrzykujemy zalogowanego użytkownika (topbar, tryb
  // podglądu arkusza bez prawa edycji) i linki między panelami.
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

const LEADY_B2C_TABLE = 'Leady B2C';
const WYCENY_B2C_TABLE = 'Wyceny B2C';
const LOG_ZMIAN_TABLE = 'Log zmian';
const KONTAKTY_ORGANIC_TABLE = 'kontakty_organic';

function normalizePhoneDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

function formatPhonePlus(raw) {
  const digits = normalizePhoneDigits(raw);
  if (!digits) return '';
  return digits.startsWith('48') ? `+${digits}` : `+48${digits}`;
}

// Lista kolumn edytowalnych z panelu żyje teraz we wspólnym module
// (apps/shared/server/leady-endpoints.js) razem z PUT /api/leady/:idLeada —
// jedno źródło prawdy dla CRM i Backlogu.

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
  // Notatki handlowca, ręczne zmiany akcji i edycje pól złapane triggerem
  // manual_crm żyją w tej samej tabeli — to nie są telefony, nie liczymy ich
  // (pełna lista źródeł: NIE_TELEFON_ZRODLA we wspólnym module).
  const { data, error } = await supabase.from(LOG_ZMIAN_TABLE).select('telefon,data_zmiany,zrodlo');
  if (error) throw error;
  const todayKey = new Date().toISOString().slice(0, 10);
  const map = new Map();
  (data || []).forEach((row) => {
    if (NIE_TELEFON_ZRODLA.has(row['zrodlo'])) return;
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
app.get('/api/leady', requireLeadyView, async (req, res) => {
  try {
    const rows = await fetchLeadyRows();
    // Lista i karta NIE renderują kolumny "Treść rozmowy" (pełny transkrypt
    // Zadarmy) — sekcja "Pełne rozmowy" na dole karty dociąga transkrypcje
    // leniwie z Log zmian.transkrypcja (patrz lead-card.js loadPelneRozmowy).
    // To pole to ~29% payloadu i puchnie z każdą rozmową per lead, więc nie
    // wysyłamy go do przeglądarki (ani do pollingu co 30 s). Po stronie serwera
    // zostaje w fetchLeadyRows dla /api/ai/query i watchdoga.
    const data = rows.map(({ ['Treść rozmowy']: _pomijamy, ...rest }) => rest);
    res.json({ data, editableFields: EDITABLE_LEAD_FIELDS, readonlyFields: READONLY_LEAD_FIELDS });
  } catch (err) {
    handleError(res, err, 502);
  }
});

// Wspólne endpointy karty leada — PUT /api/leady/:idLeada, GET
// /api/leady/pelny, GET /api/leady/:telefon/historia, GET
// /api/leady/:telefon/wycena, POST /api/leady/notatka, POST /api/leady/akcja
// (te same ścieżki rejestruje Backlog; implementacja w jednym miejscu).
// W CRM zapisy wymagają prawa edycji arkusza, odczyty — podglądu.
registerLeadyEndpoints(app, { getClient, requireView: requireLeadyView, requireEdit: requireLeadyEdit });

// Panel Kontakt na karcie leada — wiadomości komunikatora dopasowane do
// leada (apps/shared/server/kontakt-endpoints.js); odczyt = prawo podglądu,
// wysyłka maila/SMS-a = prawo edycji arkusza.
registerKontaktEndpoints(app, { getClient, requireView: requireLeadyView, requireEdit: requireLeadyEdit });

// ── Arkusz Organic: nieprzypisane kontakty i wiadomości ─────────────────────
// Wszystko, co NIE jest leadem B2C, w jednej liście — dwa istniejące źródła
// sklejane read-time (bez nowej tabeli, wzorzec jak GET /api/kontakt/dla-leada):
//   • kontakty_organic — telefony "z ulicy" zasilane przez /backlog-b2c/rozmowa
//     i webhook Zadarmy (mają status/ocenę AI/historię jak lead);
//   • kom_customers bez crm_lead_id — klienci komunikatora niepowiązani
//     z żadnym leadem; liczą się tylko wątki triage='inbox' (spam i szumowe
//     komentarze odsiewa triage AI), kanał 'note' to notatki własne, nie kontakt.

// Klucz telefonu do dopasowań między źródłami: cyfry BEZ prefiksu 48 —
// kontakty_organic.telefon bywa w obu wariantach (695…, 48577…), tożsamości
// komunikatora mają zawsze 48.
function phoneKey(v) {
  const d = normalizePhoneDigits(v);
  return d.length === 11 && d.startsWith('48') ? d.slice(2) : d;
}

async function fetchOrganicRows() {
  const supabase = getClient();
  const [kontaktyRes, leadyRes, customersRes] = await Promise.all([
    supabase.from(KONTAKTY_ORGANIC_TABLE).select('*'),
    supabase.from(LEADY_B2C_TABLE).select('"Phone number",Email'),
    supabase.from('kom_customers').select('id, public_id, display_name')
      .is('crm_lead_id', null)
      .is('merged_into', null),
  ]);
  for (const r of [kontaktyRes, leadyRes, customersRes]) if (r.error) throw r.error;

  // Telefony/e-maile leadów: klient komunikatora może być leadem, którego
  // nikt jeszcze nie otworzył (most crm_lead_id zapisuje się dopiero przy
  // wejściu na kartę) — takich nie pokazujemy w Organic.
  const leadPhones = new Set();
  const leadEmails = new Set();
  (leadyRes.data || []).forEach((row) => {
    const p = phoneKey(row['Phone number']);
    if (p) leadPhones.add(p);
    const e = String(row['Email'] || '').trim().toLowerCase();
    if (e) leadEmails.add(e);
  });

  const customers = customersRes.data || [];
  const custIds = customers.map((c) => c.id);
  let threads = [];
  let identities = [];
  if (custIds.length) {
    const [thRes, idRes] = await Promise.all([
      supabase.from('kom_threads')
        .select('id, customer_id, channel, last_message_at')
        .in('customer_id', custIds)
        .eq('triage', 'inbox')
        .neq('channel', 'note'),
      supabase.from('kom_customer_identities')
        .select('customer_id, type, value')
        .in('customer_id', custIds)
        .in('type', ['phone', 'email']),
    ]);
    if (thRes.error) throw thRes.error;
    if (idRes.error) throw idRes.error;
    threads = thRes.data || [];
    identities = idRes.data || [];
  }

  const threadsByCustomer = new Map();
  threads.forEach((t) => {
    const list = threadsByCustomer.get(t.customer_id) || [];
    list.push(t);
    threadsByCustomer.set(t.customer_id, list);
  });
  const identByCustomer = new Map();
  identities.forEach((i) => {
    const entry = identByCustomer.get(i.customer_id) || {};
    if (i.type === 'phone' && !entry.telefon) entry.telefon = phoneKey(i.value);
    if (i.type === 'email' && !entry.email) entry.email = String(i.value || '').trim().toLowerCase();
    identByCustomer.set(i.customer_id, entry);
  });

  const komClients = customers
    .map((c) => ({
      ...c,
      ...(identByCustomer.get(c.id) || {}),
      // najświeższy wątek pierwszy — z niego kanał wiodący i podgląd
      threads: (threadsByCustomer.get(c.id) || [])
        .sort((a, b) => String(b.last_message_at || '').localeCompare(String(a.last_message_at || ''))),
    }))
    .filter((c) => c.threads.length)
    .filter((c) => !(c.telefon && leadPhones.has(c.telefon)) && !(c.email && leadEmails.has(c.email)));

  // Podgląd ostatniej wiadomości: jedno zapytanie za wszystkie wątki wiodące
  // (skala: dziesiątki), pierwszy wiersz per wątek po sortowaniu malejąco.
  const previewByThread = new Map();
  const topThreadIds = komClients.map((c) => c.threads[0].id);
  if (topThreadIds.length) {
    const { data: msgs, error: msgErr } = await supabase
      .from('kom_messages')
      .select('thread_id, direction, body, created_at')
      .in('thread_id', topThreadIds)
      .order('created_at', { ascending: false })
      .limit(500);
    if (msgErr) throw msgErr;
    (msgs || []).forEach((m) => {
      if (!previewByThread.has(m.thread_id)) previewByThread.set(m.thread_id, m);
    });
  }

  // Wspólny kształt wiersza dla obu typów; _id jest stabilne (klucz filtra AI
  // i podmian w DOM). Bez tresc_rozmowy — pełny transkrypt nie jest potrzebny
  // w liście (ten sam powód co pominięcie "Treść rozmowy" w /api/leady).
  const rows = [];
  const telefonKeys = new Set();
  (kontaktyRes.data || []).forEach((k) => {
    const key = phoneKey(k.telefon);
    if (key) telefonKeys.add(key);
    rows.push({
      _id: `tel-${k.id}`,
      _typ: 'telefon',
      kontakt_id: k.id,
      imie: k.imie || null,
      _telefon_formatted: formatPhonePlus(k.telefon),
      email: null,
      zrodlo: k.zrodlo,
      status: k.status || null,
      ocena_ai: k.ocena_ai || null,
      historia_rozmow: k.historia_rozmow || null,
      najblizsza_akcja: k.najblizsza_akcja || null,
      najblizsza_akcja_termin: k.najblizsza_akcja_termin || null,
      najblizsza_akcja_owner: k.najblizsza_akcja_owner || null,
      ilosc_rozmow: Number(k.ilosc_rozmow) || 0,
      ostatni_kontakt: k.ostatni_kontakt || null,
      owner: k.owner || null,
      kanaly: ['telefon'],
      _sort: k.updated_at || '',
    });
  });

  komClients.forEach((c) => {
    // Numer obecny już w kontakty_organic nie robi duplikatu — wiersz
    // telefoniczny jest bogatszy (status/ocena AI/historia).
    if (c.telefon && telefonKeys.has(c.telefon)) return;
    const top = c.threads[0];
    const preview = previewByThread.get(top.id) || null;
    rows.push({
      _id: `kom-${c.public_id}`,
      _typ: 'wiadomosci',
      kontakt_id: null,
      imie: c.display_name || null,
      _telefon_formatted: c.telefon ? formatPhonePlus(c.telefon) : '',
      email: c.email || null,
      zrodlo: top.channel,
      status: null,
      ostatnia_wiadomosc: preview
        ? { kierunek: preview.direction, tresc: String(preview.body || '').slice(0, 300), kiedy: preview.created_at }
        : null,
      ostatni_kontakt: top.last_message_at || null,
      kanaly: [...new Set(c.threads.map((t) => t.channel))],
      // Deep-link jak z karty leada — front skleja adres z LUMLUM_LINKS
      // (lokalnie inny port, na Vercelu /wiadomosci/) + ?klient=public_id.
      kom_klient: c.public_id,
      _sort: top.last_message_at || '',
    });
  });

  // Oba _sort to ISO timestamptz (updated_at / last_message_at) — porównywalne
  // leksykograficznie, najświeższa aktywność na górze.
  rows.sort((a, b) => String(b._sort).localeCompare(String(a._sort)));
  return rows;
}

// GET /api/organic — pełna lista (skala: dziesiątki wierszy, bez paginacji).
app.get('/api/organic', requireOrganicView, async (req, res) => {
  try {
    res.json({ data: await fetchOrganicRows() });
  } catch (err) {
    handleError(res, err, 502);
  }
});

// PUT /api/organic/:id — zmiana statusu kontaktu telefonicznego z pigułki
// (jak w Leady B2C). Tylko wiersze z kontakty_organic; wiersze z komunikatora
// nie mają statusu — nimi zarządza panel Wiadomości.
app.put('/api/organic/:id', requireOrganicEdit, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Złe ID kontaktu' });
    const status = String(req.body?.status || '').trim();
    if (!status || status.length > 60) return res.status(400).json({ error: 'Podaj poprawny status' });
    const supabase = getClient();
    const { data, error } = await supabase
      .from(KONTAKTY_ORGANIC_TABLE)
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id');
    if (error) throw error;
    if (!data || !data.length) return res.status(404).json({ error: 'Nie ma takiego kontaktu' });
    res.json({ ok: true });
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
    sheet: SHEET_LEADY,
    idField: 'ID Leada',
    fetchRows: fetchLeadyRows,
    // szum, który tylko pali tokeny: długie identyfikatory/linki bez wartości
    // analitycznej + duplikaty telefonu (zostaje _telefon_formatted)
    omit: ['Facebook Leads ID', 'Link do formularza', '_telefon_digits', 'Phone number'],
    // długie pola tekstowe przycinamy — AI ma dostać sedno każdego leada,
    // a nie pełne transkrypcje wszystkich rozmów naraz
    truncate: { 'Treść rozmowy': 400, 'Ocena AI kontaktu': 400, Notes: 400, 'Produkty z wyceny': 200, 'Historia rozmów': 600 },
    fieldsHint: 'Pola zaczynające się od "_" są wyliczane systemowo: _ilosc_polaczen = liczba połączeń z klientem, _kontakt_dzisiaj = czy był kontakt dziś, _ma_wycene = czy istnieje wygenerowana wycena.',
  },
  organic: {
    label: 'Organic',
    sheet: SHEET_ORGANIC,
    idField: '_id',
    fetchRows: fetchOrganicRows,
    omit: ['kom_klient', 'kontakt_id', '_sort'],
    truncate: { historia_rozmow: 600, ocena_ai: 400 },
    fieldsHint: 'To kontakty SPOZA bazy leadów: _typ "telefon" = rozmowy telefoniczne z obcych numerów (mają status, ocenę AI i historię rozmów), _typ "wiadomosci" = nieprzypisane wiadomości z komunikatora (Messenger/Instagram/TikTok/mail/SMS; pole ostatnia_wiadomosc, kierunek "in" = klient napisał i może czekać na odpowiedź).',
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

Pola rekordów (nazwy dokładnie jak w danych): ${columns.join(', ')}. ${cfg.fieldsHint || ''}

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
    // Bramka per arkusz sekcji (nie sztywno leady-b2c) — użytkownik z samym
    // Organic też może pytać AI o swoją listę.
    if (!userCanSheet(req.user, cfg.sheet, 'view')) {
      return res.status(403).json({ error: 'Brak dostępu do tego arkusza' });
    }
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
// do testów na atrapie/skryptem (serwer Vercela używa samego `app`)
module.exports.fetchOrganicRows = fetchOrganicRows;
