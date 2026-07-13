// Panel Statystyki (lumlum.dev/statystyki) — Kokpit sprzedaży dla Antoniego +
// AI-doradca Fable. Fasada metryk: queries.js (JEDNO źródło liczb, guardrails §0).
// Dwie bramki na jednej funkcji:
//   • /api/stats/*  — MASZYNOWE, token (STATS_API_TOKEN), dla zewnętrznego
//     doradcy (docs/statystyki-ai-handoff.md). Rejestrowane PRZED auth.gate,
//     żeby Bearer-call nie leciał na /login.
//   • /, /api/snapshot, /api/doradca/chat — SESYJNE (ciasteczko huba), front.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { getClient } = require('./supabase');
const { createAuth, clientPayload, panelLinks, isAdmin } = require('../../shared/server/auth');
const Q = require('./queries');
const doradca = require('./doradca');

const app = express();
app.use(cors());
app.use(express.json());
// no-store poza /assets — inaczej Vercel CDN serwowałby odpowiedzi po zalogowaniu.
app.use((req, res, next) => { if (!req.path.startsWith('/assets/')) res.set('Cache-Control', 'no-store'); next(); });

// ── Statyki: ikony/manifest z assetów huba (bez duplikacji binariów), topbar z shared ──
app.get('/assets/:file', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'hub', 'assets', req.params.file));
});
app.get('/shared/:file', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'shared', req.params.file));
});
app.get('/statystyki.webmanifest', (req, res) => {
  res.type('application/manifest+json').json({
    name: 'LumLum — Statystyki', short_name: 'Statystyki',
    description: 'Kokpit sprzedaży + AI-doradca.',
    start_url: `${req.baseUrl}/`, scope: `${req.baseUrl}/`,
    display: 'standalone', orientation: 'portrait', background_color: '#0a0a0a', theme_color: '#000000',
    icons: [
      { src: `${req.baseUrl}/assets/lumlum-icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `${req.baseUrl}/assets/lumlum-icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `${req.baseUrl}/assets/lumlum-icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  });
});

// ── FASADA MASZYNOWA /api/stats/* (token, PRZED bramką sesji) ────────────────
function requireToken(req, res, next) {
  const expected = process.env.STATS_API_TOKEN;
  if (!expected) return res.status(503).json({ error: 'STATS_API_TOKEN nie ustawiony — endpoint wyłączony' });
  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const token = bearer || req.query.token;
  if (token !== expected) return res.status(401).json({ error: 'Nieprawidłowy token' });
  next();
}
const machine = (fn) => async (req, res) => {
  try { res.json(await fn(getClient(), req)); }
  catch (err) { console.error('stats error:', err.message); res.status(502).json({ error: err.message }); }
};
const str = (v) => (v == null ? undefined : String(v).trim() || undefined);
const int = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// Health bez tokena — sprawdzenie, czy funkcja żyje po deployu.
app.get('/api/stats/health', (req, res) => {
  res.json({ ok: true, panel: 'statystyki', token_set: Boolean(process.env.STATS_API_TOKEN), ts: new Date().toISOString() });
});
app.get('/api/stats/snapshot', requireToken, machine((db) => Q.snapshot(db)));
app.get('/api/stats/sprzedaz', requireToken, machine((db, req) => Q.sprzedaz(db, { owner: str(req.query.owner) })));
app.get('/api/stats/pipeline', requireToken, machine((db, req) => Q.pipeline(db, {
  olderThanDays: int(req.query.olderThanDays, 0), minKwota: int(req.query.minKwota, 0),
  owner: str(req.query.owner), limit: int(req.query.limit, 10),
})));
app.get('/api/stats/outreach', requireToken, machine((db, req) => Q.outreach(db, {
  from: str(req.query.from), to: str(req.query.to), handlowiec: str(req.query.handlowiec),
})));
app.get('/api/stats/leady', requireToken, machine((db) => Q.leady(db)));
app.get('/api/stats/close-rate', requireToken, machine((db) => Q.closeRate(db)));

// ── Bramka sesji huba (ciasteczko Path=/) ────────────────────────────────────
const auth = createAuth({ getClient, panelKey: 'statystyki', loginTitle: 'Statystyki' });
auth.register(app);

// ── Front (Kokpit + Doradca) ─────────────────────────────────────────────────
const APP_HTML = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
function injectGlobals(template, req) {
  return template.replace(
    '<head>',
    `<head>\n<script>window.API_BASE = ${JSON.stringify(req.baseUrl)};\n`
    + `window.LUMLUM_USER = ${JSON.stringify(clientPayload(req.user))};\n`
    + `window.LUMLUM_LINKS = ${JSON.stringify(panelLinks())};</script>`
  );
}
app.get('/', (req, res) => { res.type('html').send(injectGlobals(APP_HTML, req)); });

// Kokpit: snapshot scoped per owner dla nie-admina (Lorenzo widzi swoje).
app.get('/api/snapshot', async (req, res) => {
  try {
    const owner = isAdmin(req.user) ? undefined : (req.user && req.user.name);
    res.json(await Q.snapshot(getClient(), { owner }));
  } catch (err) { console.error('snapshot error:', err.message); res.status(502).json({ error: err.message }); }
});

// Doradca — czat SSE. ADMIN-only: system prompt (docs/fable-doradca-lumlum.md)
// zawiera marże/strategię właściciela; firmowy widok danych.
app.post('/api/doradca/chat', auth.requireAdmin, async (req, res) => {
  const { messages, deep } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'Brak wiadomości' });

  res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  if (res.flushHeaders) res.flushHeaders();
  const send = (event, data) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  let closed = false;
  req.on('close', () => { closed = true; });

  try {
    await doradca.chat({
      db: getClient(),
      deep: Boolean(deep),
      messages: messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') })),
      onEvent: (e) => { if (!closed) send(e.type, e); },
    });
  } catch (err) {
    console.error('doradca error:', err.message);
    if (!closed) send('error', { message: err.message });
  } finally {
    if (!closed) { send('end', {}); res.end(); }
  }
});

const PORT = process.env.PORT || 3010;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Panel Statystyki działa na http://localhost:${PORT}`));
}

module.exports = app;
