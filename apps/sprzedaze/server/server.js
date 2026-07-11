// Panel Sprzedaże (lumlum.dev/sprzedaze) — ładny widok zamówień: karta z
// adresem/punktem odbioru, produktami ze zdjęciami, linkami do faktury
// i etykiety oraz trackingiem; na górze proste statystyki (placeholder do
// rozbudowy). Dane i karta wspólne z zakładką Wyceny w CRM:
// apps/shared/server/wyceny-endpoints.js + apps/shared/wycena-card.js.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { getClient } = require('./supabase');
const { registerWycenyEndpoints } = require('../../shared/server/wyceny-endpoints');
const { createAuth, clientPayload, panelLinks, isAdmin } = require('../../shared/server/auth');
const { servePushWorker, registerPushEndpoints } = require('../../shared/server/push');

const app = express();
app.use(cors());
app.use(express.json());

// Patrz apps/backlog-b2c/server/server.js — bez no-store Vercel CDN
// cache'owałby odpowiedzi po zalogowaniu i serwował je każdemu.
app.use((req, res, next) => {
  if (!req.path.startsWith('/assets/')) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});

app.get('/assets/:file', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'assets', req.params.file));
});

app.get('/shared/:file', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'shared', req.params.file));
});

const auth = createAuth({ getClient, panelKey: 'sprzedaze', loginTitle: 'Sprzedaże' });
servePushWorker(app);
auth.register(app);
registerPushEndpoints(app, { getClient });

// Dostęp do panelu = dostęp do danych sprzedaży (bramka panelu już
// przepuściła), edycja także — akcje na karcie (link, ponowny kurier) są
// częścią pracy z zamówieniem. Filtr per owner siedzi w samych endpointach.
const allow = (req, res, next) => next();
registerWycenyEndpoints(app, {
  getClient,
  requireView: allow,
  requireEdit: allow,
  isAdmin,
});

const APP_HTML_TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');

app.get('/', (req, res) => {
  const html = APP_HTML_TEMPLATE.replace(
    '<head>',
    `<head>\n<script>window.API_BASE = ${JSON.stringify(req.baseUrl)};\n` +
    `window.LUMLUM_USER = ${JSON.stringify(clientPayload(req.user))};\n` +
    `window.LUMLUM_LINKS = ${JSON.stringify(panelLinks())};</script>`
  );
  res.type('html').send(html);
});

const PORT = process.env.PORT || 3006;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Panel Sprzedaże działa na http://localhost:${PORT}`);
  });
}

module.exports = app;
