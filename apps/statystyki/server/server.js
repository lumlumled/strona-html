// Panel Statystyki — API dla wewnętrznego AI-doradcy (v1: Sprzedaż + Outreach +
// Leady + Pipeline + Snapshot). JEDNA fasada /api/stats/* (guardrails §0):
// AI-doradca pyta tylko to, nigdy bazy bezpośrednio. Read-only, token-gated.
// Definicje metryk: queries.js. Guardrails: docs/statystyki-doradca-build-guardrails.md.
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { getClient } = require('./supabase');
const Q = require('./queries');

const app = express();
app.use(cors());
app.use(express.json());
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// --- Autoryzacja tokenem (endpoint maszynowy, bez sesji) ---
function requireToken(req, res, next) {
  const expected = process.env.STATS_API_TOKEN;
  if (!expected) return res.status(503).json({ error: 'STATS_API_TOKEN nie ustawiony — endpoint wyłączony' });
  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const token = bearer || req.query.token;
  if (token !== expected) return res.status(401).json({ error: 'Nieprawidłowy token' });
  next();
}

// Opakowanie: łapie błędy, zwraca 502 z komunikatem (nie wywala funkcji).
const handler = (fn) => async (req, res) => {
  try {
    const db = getClient();
    res.json(await fn(db, req));
  } catch (err) {
    console.error('stats error:', err.message);
    res.status(502).json({ error: err.message });
  }
};

const str = (v) => (v == null ? undefined : String(v).trim() || undefined);
const int = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// GŁÓWNY: pełny obraz firmy w jednym strzale (rollup A–D + close rate + alerty).
app.get('/api/stats/snapshot', requireToken, handler((db) => Q.snapshot(db)));

// Segmentowe (doszczegółowienie).
app.get('/api/stats/sprzedaz', requireToken, handler((db, req) => Q.sprzedaz(db, { owner: str(req.query.owner) })));
app.get('/api/stats/pipeline', requireToken, handler((db, req) => Q.pipeline(db, {
  olderThanDays: int(req.query.olderThanDays, 0),
  minKwota: int(req.query.minKwota, 0),
  owner: str(req.query.owner),
  limit: int(req.query.limit, 10),
})));
app.get('/api/stats/outreach', requireToken, handler((db, req) => Q.outreach(db, {
  from: str(req.query.from), to: str(req.query.to), handlowiec: str(req.query.handlowiec),
})));
app.get('/api/stats/leady', requireToken, handler((db) => Q.leady(db)));
app.get('/api/stats/close-rate', requireToken, handler((db) => Q.closeRate(db)));

// Health bez tokena — sprawdzenie, czy funkcja żyje po deployu.
app.get('/api/stats/health', (req, res) => {
  res.json({ ok: true, panel: 'statystyki', token_set: Boolean(process.env.STATS_API_TOKEN), ts: new Date().toISOString() });
});

const PORT = process.env.PORT || 3010;
if (require.main === module) {
  app.listen(PORT, () => console.log(`API Statystyki działa na http://localhost:${PORT}`));
}

module.exports = app;
