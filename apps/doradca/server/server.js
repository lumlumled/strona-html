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
  const { messages, deep } = req.body || {};
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

const PORT = process.env.PORT || 3011;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Panel Doradca działa na http://localhost:${PORT}`));
}

module.exports = app;
