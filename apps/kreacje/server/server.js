// Panel Kreacje (lumlum.dev/kreacje) — Content Intelligence dla marketingu/SMM.
// Split platform (TikTok/IG/FB) + timeline treść↔sprzedaż + katalog rolek +
// format→sprzedaż. Reużywa fasadę queries.js panelu Statystyki (JEDNO źródło liczb).
// FOLDOWANY do funkcji api/statystyki.js (limit 12 funkcji Vercel Hobby) —
// mount pod /kreacje. Osobna bramka (panelKey:'kreacje') + własne API_BASE=/kreacje,
// więc dla użytkownika to w pełni odrębny panel (dostęp nadawany osobno, np. dla SMM).
// Lokalnie stoi samodzielnie na :3016.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { getClient } = require('../../statystyki/server/supabase');
const { createAuth, clientPayload, panelLinks } = require('../../shared/server/auth');
const Q = require('../../statystyki/server/queries');

const app = express();
app.use(cors());
app.use(express.json());
app.use((req, res, next) => { if (!req.path.startsWith('/assets/')) res.set('Cache-Control', 'no-store'); next(); });

// Statyki: ikony z assetów huba, topbar/pliki z shared (bez duplikacji binariów).
app.get('/assets/:file', (req, res) => { res.sendFile(path.join(__dirname, '..', '..', 'hub', 'assets', req.params.file)); });
app.get('/shared/:file', (req, res) => { res.sendFile(path.join(__dirname, '..', '..', 'shared', req.params.file)); });

// Bramka sesji huba — wymaga uprawnienia panelu 'kreacje' (admin ma zawsze).
const auth = createAuth({ getClient, panelKey: 'kreacje', loginTitle: 'Kreacje' });
auth.register(app);

// Front.
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

// Dane panelu.
const sesyjny = (fn) => async (req, res) => {
  try { res.json(await fn(getClient(), req)); }
  catch (err) { console.error('kreacje error:', err.message); res.status(502).json({ error: err.message }); }
};
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const dayRe = /^\d{4}-\d{2}-\d{2}$/;
app.get('/api/kreacje', sesyjny((db, req) => Q.kreacje(db, {
  weeks: int(req.query.weeks, 26),
  from: dayRe.test(req.query.from || '') ? req.query.from : undefined,
  to: dayRe.test(req.query.to || '') ? req.query.to : undefined,
})));

// Upload ręcznych eksportów dziennych FB (Business Suite → CSV) — Graph API v21
// nie oddaje treściowych metryk strony, więc Antoni/SMM wrzuca je z panelu.
// Za bramką sesji (auth.register wyżej); logika w apps/shared/server/fb-csv-ingest.js.
const fbCsv = require('../../shared/server/fb-csv-ingest');
app.post('/api/fb-csv', express.raw({ type: 'multipart/form-data', limit: '40mb' }), async (req, res) => {
  try {
    const files = fbCsv.parseMultipart(req.body, req.headers['content-type']);
    if (!files.length) return res.status(400).json({ error: 'Brak plików w żądaniu.' });
    res.json(await fbCsv.ingest(getClient(), files));
  } catch (err) { console.error('kreacje fb-csv error:', err.message); res.status(502).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3016;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Panel Kreacje działa na http://localhost:${PORT}`));
}

module.exports = app;
