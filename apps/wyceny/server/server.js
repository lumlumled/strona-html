// Panel Wyceny (lumlum.dev/wyceny) — osobne narzędzie w hubie (wyjęte z CRM,
// który zostaje do leadów): lista wycen/notatek (typ ≠ ZAMÓWIENIE), szybkie
// dodanie tekstem (AI), pełny edytor, link do formularza. Dane i karta
// wspólne z panelem Sprzedaże: apps/shared/server/wyceny-endpoints.js +
// apps/shared/wycena-card.js. Sprzedaże (typ ZAMÓWIENIE) mają własny panel.
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

const auth = createAuth({ getClient, panelKey: 'wyceny', loginTitle: 'Wyceny' });
servePushWorker(app);
auth.register(app);
registerPushEndpoints(app, { getClient });

// Dostęp do panelu = dostęp do danych wycen (bramka panelu już przepuściła),
// edycja także — dodawanie/edycja wyceny i wysłanie linku to praca z wyceną.
// Filtr per owner siedzi w samych endpointach (nie-admin widzi tylko swoje).
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

const PORT = process.env.PORT || 3008;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Panel Wyceny działa na http://localhost:${PORT}`);
  });
}

module.exports = app;
