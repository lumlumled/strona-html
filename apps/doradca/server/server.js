// Panel Doradca (lumlum.dev/doradca) — AI-doradca Fable jako OSOBNY panel
// (decyzja Antoniego: wyjęty ze Statystyk). Silnik: fable.js (reużywa fasady
// danych queries.js ze Statystyk). Pamięć/uczenie: pamiec.js. Admin-only —
// system prompt zawiera marże/strategię właściciela.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { getClient } = require('../../statystyki/server/supabase');
const { createAuth, clientPayload, panelLinks } = require('../../shared/server/auth');
const { notifyUser } = require('../../shared/server/push');
const fable = require('./fable');
const pamiec = require('./pamiec');

const app = express();
app.use(cors());
app.use(express.json());
app.use((req, res, next) => { if (!req.path.startsWith('/assets/')) res.set('Cache-Control', 'no-store'); next(); });

// Ikony/manifest z assetów huba, topbar/css z shared (bez duplikacji).
app.get('/assets/:file', (req, res) => res.sendFile(path.join(__dirname, '..', '..', 'hub', 'assets', req.params.file)));
app.get('/shared/:file', (req, res) => res.sendFile(path.join(__dirname, '..', '..', 'shared', req.params.file)));
app.get('/doradca.webmanifest', (req, res) => {
  res.type('application/manifest+json').json({
    name: 'LumLum — Doradca', short_name: 'Doradca',
    description: 'AI-doradca Fable: pyta o firmę, kopie w dane, uczy się.',
    start_url: `${req.baseUrl}/`, scope: `${req.baseUrl}/`,
    display: 'standalone', orientation: 'portrait', background_color: '#0a0a0a', theme_color: '#000000',
    icons: [
      { src: `${req.baseUrl}/assets/lumlum-icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `${req.baseUrl}/assets/lumlum-icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  });
});

// Bramka sesji huba (ciasteczko Path=/).
const auth = createAuth({ getClient, panelKey: 'doradca', loginTitle: 'Doradca' });
auth.register(app);

const APP_HTML = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
function injectGlobals(template, req) {
  return template.replace('<head>',
    `<head>\n<script>window.API_BASE = ${JSON.stringify(req.baseUrl)};\n`
    + `window.LUMLUM_USER = ${JSON.stringify(clientPayload(req.user))};\n`
    + `window.LUMLUM_LINKS = ${JSON.stringify(panelLinks())};</script>`);
}
app.get('/', (req, res) => res.type('html').send(injectGlobals(APP_HTML, req)));

const ownerOf = (req) => (req.user && req.user.name) || 'Antoni';

// ── Czat SSE (admin-only) — pamięć w kontekście + uczenie po odpowiedzi ──────
app.post('/api/doradca/chat', auth.requireAdmin, async (req, res) => {
  const { messages, deep, model, kontekst } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'Brak wiadomości' });
  const owner = ownerOf(req);

  res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  if (res.flushHeaders) res.flushHeaders();
  const send = (event, data) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  let closed = false;
  req.on('close', () => { closed = true; });

  const clean = messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }));
  try {
    const db = getClient();
    let memoryText = '';
    try { memoryText = pamiec.formatujDoPromptu(await pamiec.getOpen(db, owner)); }
    catch (e) { console.error('doradca pamięć (odczyt):', e.message); }

    const answer = await fable.chat({
      db, deep: Boolean(deep), messages: clean, memoryText,
      modelKey: typeof model === 'string' ? model : '',
      extraContext: typeof kontekst === 'string' ? kontekst : '',
      onEvent: (e) => { if (!closed) send(e.type, e); },
    });

    // Uczenie na podstawie odpowiedzi — po streamie, przed zamknięciem (Vercel
    // ubija funkcję po res.end, więc musi być await, nie fire-and-forget).
    try {
      const nauka = await pamiec.uczSie(db, owner, { messages: clean, answer });
      if (!closed && (nauka.inserted.length || nauka.bumped)) send('nauczono', nauka);
    } catch (e) { console.error('doradca uczenie:', e.message); }
  } catch (err) {
    console.error('doradca error:', err.message);
    if (!closed) send('error', { message: err.message });
  } finally {
    if (!closed) { send('end', {}); res.end(); }
  }
});

// ── Pamięć: podgląd + domknięcie (accountability) ────────────────────────────
app.get('/api/doradca/pamiec', auth.requireAdmin, async (req, res) => {
  try {
    const rows = await pamiec.getOpen(getClient(), ownerOf(req));
    res.json({ items: rows, tytuly: pamiec.TYTUL });
  } catch (err) { res.status(502).json({ error: err.message }); }
});
app.post('/api/doradca/pamiec/:id/rozwiaz', auth.requireAdmin, async (req, res) => {
  try { res.json(await pamiec.rozwiaz(getClient(), Number(req.params.id), (req.body || {}).status)); }
  catch (err) { res.status(502).json({ error: err.message }); }
});

// ── Historia czatów (osobne rozmowy, sync między urządzeniami) ───────────────
// Tabela doradca_chaty (migracja 010). Per owner. Trzyma messages + ostatni
// model + dodatkowy kontekst danej rozmowy.
const CHATY = 'doradca_chaty';
function tytulZWiadomosci(messages) {
  const first = (Array.isArray(messages) ? messages : []).find((m) => m && m.role === 'user' && String(m.content || '').trim());
  return (first ? String(first.content).trim().replace(/\s+/g, ' ') : 'Nowa rozmowa').slice(0, 60);
}

app.get('/api/doradca/chaty', auth.requireAdmin, async (req, res) => {
  try {
    const { data, error } = await getClient()
      .from(CHATY).select('id,tytul,updated_at')
      .eq('owner', ownerOf(req)).order('updated_at', { ascending: false }).limit(200);
    if (error) throw error;
    res.json({ items: data || [] });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

app.get('/api/doradca/chaty/:id', auth.requireAdmin, async (req, res) => {
  try {
    const { data, error } = await getClient()
      .from(CHATY).select('id,tytul,messages,model,kontekst,updated_at')
      .eq('id', req.params.id).eq('owner', ownerOf(req)).limit(1);
    if (error) throw error;
    const row = (data || [])[0];
    if (!row) return res.status(404).json({ error: 'Nie ma takiej rozmowy' });
    res.json(row);
  } catch (err) { res.status(502).json({ error: err.message }); }
});

app.post('/api/doradca/chaty', auth.requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const row = {
      owner: ownerOf(req),
      tytul: (typeof b.tytul === 'string' && b.tytul.trim()) ? b.tytul.trim().slice(0, 120) : tytulZWiadomosci(b.messages),
      messages: Array.isArray(b.messages) ? b.messages : [],
      model: typeof b.model === 'string' ? b.model : null,
      kontekst: typeof b.kontekst === 'string' ? b.kontekst : null,
    };
    const { data, error } = await getClient().from(CHATY).insert(row).select('id,tytul,updated_at');
    if (error) throw error;
    res.json((data || [])[0] || {});
  } catch (err) { res.status(502).json({ error: err.message }); }
});

app.put('/api/doradca/chaty/:id', auth.requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const patch = { updated_at: new Date().toISOString() };
    if (Array.isArray(b.messages)) patch.messages = b.messages;
    if (typeof b.tytul === 'string') patch.tytul = b.tytul.slice(0, 120);
    if (typeof b.model === 'string') patch.model = b.model;
    if (typeof b.kontekst === 'string') patch.kontekst = b.kontekst;
    const { data, error } = await getClient()
      .from(CHATY).update(patch).eq('id', req.params.id).eq('owner', ownerOf(req)).select('id,tytul,updated_at');
    if (error) throw error;
    if (!data || !data.length) return res.status(404).json({ error: 'Nie ma takiej rozmowy' });
    res.json(data[0]);
  } catch (err) { res.status(502).json({ error: err.message }); }
});

app.delete('/api/doradca/chaty/:id', auth.requireAdmin, async (req, res) => {
  try {
    const { error } = await getClient().from(CHATY).delete().eq('id', req.params.id).eq('owner', ownerOf(req));
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// ── Klikalny case: resolver leada/wyceny → streszczenie + link do panelu ─────
// Zasila pigułkę ⟦case:TYP:ID⟧ w odpowiedzi doradcy. Read-only.
app.get('/api/doradca/case', auth.requireAdmin, async (req, res) => {
  try {
    const type = String(req.query.type || '');
    const id = String(req.query.id || '').trim();
    if (!id || (type !== 'wycena' && type !== 'lead')) return res.status(400).json({ error: 'Zły typ lub id' });
    const db = getClient();
    const links = panelLinks();

    if (type === 'wycena') {
      const { data, error } = await db.from('wyceny')
        .select('id,imie_nazwisko,first_name,last_name,kwota_proponowana_brutto,status,owner,telefon_e164,telefon_digits,created_at,lead_id')
        .eq('id', id).limit(1);
      if (error) throw error;
      const w = (data || [])[0];
      if (!w) return res.status(404).json({ error: `Nie znaleziono wyceny #${id}` });
      const name = w.imie_nazwisko || [w.first_name, w.last_name].filter(Boolean).join(' ') || null;
      const wiek = w.created_at ? Math.floor((Date.now() - new Date(w.created_at).getTime()) / 86400000) : null;
      // Link: karta leada w CRM (pokazuje lead + jego wyceny) gdy znamy lead_id,
      // inaczej panel Wyceny.
      const link = w.lead_id ? `${links.crm}?lead=${encodeURIComponent(w.lead_id)}` : links.wyceny;
      return res.json({
        type, id: w.id, tytul: name || `Wycena #${w.id}`,
        kwota: Number(w.kwota_proponowana_brutto) || null, status: w.status || null,
        owner: w.owner || null, telefon: w.telefon_e164 || w.telefon_digits || null,
        wiek_dni: wiek, link, link_label: w.lead_id ? 'Otwórz lead w CRM' : 'Otwórz w Wycenach',
      });
    }

    const { data, error } = await db.from('Leady B2C')
      .select('"ID Leada","Name","Phone number","Owner","Deal stage","Historia rozmów"')
      .eq('ID Leada', id).limit(1);
    if (error) throw error;
    const l = (data || [])[0];
    if (!l) return res.status(404).json({ error: `Nie znaleziono leada #${id}` });
    const hist = l['Historia rozmów'];
    const histStr = typeof hist === 'string' ? hist : (hist ? JSON.stringify(hist) : '');
    const ostatnia = histStr.trim() ? histStr.trim().split('\n').filter(Boolean).slice(-1)[0].slice(0, 240) : null;
    return res.json({
      type, id: l['ID Leada'], tytul: l['Name'] || `Lead #${l['ID Leada']}`,
      status: l['Deal stage'] || null, owner: l['Owner'] || null, telefon: l['Phone number'] || null,
      ostatnia_notatka: ostatnia,
      link: `${links.crm}?lead=${encodeURIComponent(l['ID Leada'])}`, link_label: 'Otwórz lead w CRM',
    });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// ── Akcja delegowania: zadanie na górę planu dnia (priorytet_dzis) + push ─────
// Napędza przycisk „Wyślij do Lorenzo" z odpowiedzi doradcy. Dokładamy do
// WSZYSTKICH istniejących wersji Umowy (draft/poprawka/final) — jak webhook
// Zadarmy — żeby zatwierdzenie (poprawka→final) nie skasowało zadania.
const STANDUP_TABLE = 'Standup Log Lorenzo';
const UMOWA_FIELDS = ['Umowa - draft - JSON', 'Umowa - draft poprawka AI - JSON', 'Umowa - final - JSON'];

function warsawTodayKeys() {
  const s = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [y, m, d] = s.split('-');
  return { iso: `${y}-${m}-${d}`, pl: `${d}.${m}.${y}` };
}
function parseDoc(v) {
  if (!v) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
  return typeof v === 'object' ? v : null;
}
function maxLp(json) {
  let mx = 0;
  const scan = (arr) => { if (Array.isArray(arr)) arr.forEach((it) => { const n = Number(it && it.lp); if (Number.isFinite(n) && n > mx) mx = n; }); };
  scan(json.priorytet_dzis);
  if (json.kategorie && typeof json.kategorie === 'object') Object.values(json.kategorie).forEach(scan);
  return mx;
}

app.post('/api/doradca/akcja', auth.requireAdmin, async (req, res) => {
  try {
    const { tytul, szczegol, owner } = req.body || {};
    const tytulClean = String(tytul || '').trim();
    if (!tytulClean) return res.status(400).json({ error: 'Brak tytułu zadania' });
    const ownerClean = (String(owner || '').trim() || process.env.DEFAULT_HANDLOWIEC || 'Lorenzo');

    const db = getClient();
    const { iso, pl } = warsawTodayKeys();
    let row = null; let dataValue = iso;
    for (const key of [iso, pl]) {
      const { data, error } = await db.from(STANDUP_TABLE).select('*').eq('Data', key).limit(1);
      if (error) throw error;
      if (data && data[0]) { row = data[0]; dataValue = key; break; }
    }
    if (!row) return res.status(404).json({ error: `Brak planu dnia na dziś (${iso}). Odpal najpierw poranny plan, potem dodam zadanie.` });

    const nowIso = new Date().toISOString();
    const patch = {};
    let lpAssigned = null;
    UMOWA_FIELDS.forEach((col) => {
      const wasString = typeof row[col] === 'string';
      const json = parseDoc(row[col]);
      if (!json) return;
      const lp = maxLp(json) + 1;
      if (lpAssigned == null) lpAssigned = lp;
      const task = {
        lp, imie: tytulClean, opis: String(szczegol || '').trim(), telefon: '',
        status: 'Nowy', owner: ownerClean, zrodlo: 'doradca',
        zamkniete: 0, zadzwonil_dzis: false, dodany_o: nowIso,
      };
      if (!Array.isArray(json.priorytet_dzis)) json.priorytet_dzis = [];
      json.priorytet_dzis.unshift(task);
      patch[col] = wasString ? JSON.stringify(json) : json;
    });
    if (!Object.keys(patch).length) return res.status(409).json({ error: 'Plan dnia na dziś jest pusty/nieczytelny — nic nie dodano.' });

    const { error: upErr } = await db.from(STANDUP_TABLE).update(patch).eq('Data', dataValue);
    if (upErr) throw upErr;

    // Push do ownera zadania (best-effort, jak przy nowym leadzie).
    let powiadomiono = false;
    try {
      const { data: users } = await db.from('app_users').select('id,name').eq('active', true);
      const target = (users || []).find((u) => String(u.name || '').trim().toLowerCase() === ownerClean.toLowerCase());
      if (target) {
        await notifyUser(getClient, target.id, {
          title: 'Nowe zadanie od doradcy',
          body: tytulClean + (String(szczegol || '').trim() ? ' — ' + String(szczegol).trim() : ''),
          url: '/backlog-b2c/',
          tag: `doradca-akcja-${dataValue}-${lpAssigned}`,
        });
        powiadomiono = true;
      }
    } catch (e) { console.warn('doradca akcja push:', e.message); }

    res.json({ ok: true, lp: lpAssigned, owner: ownerClean, data: dataValue, powiadomiono });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3011;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Panel Doradca działa na http://localhost:${PORT}`));
}

module.exports = app;
