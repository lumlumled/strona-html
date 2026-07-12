// Panel Fulfillment (lumlum.dev/fulfillment) — ADMIN-ONLY pulpit pakowania.
// Osobny widok nad tymi samymi danymi co Sprzedaże: co spakować i nadać
// (produkty ze zdjęciami, etykieta, tracking, dane odbiorcy). Maszyna stanów,
// tracking i faktury żyją w apps/shared/server/wyceny-pipeline.js; endpointy
// panelu w apps/shared/server/fulfillment-endpoints.js. Etykieta PDF idzie
// przez wspólny /api/wyceny/label/:shipmentId (registerWycenyEndpoints).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { getClient } = require('./supabase');
const { registerWycenyEndpoints } = require('../../shared/server/wyceny-endpoints');
const { registerFulfillmentEndpoints } = require('../../shared/server/fulfillment-endpoints');
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

const auth = createAuth({ getClient, panelKey: 'fulfillment', loginTitle: 'Fulfillment' });
servePushWorker(app);
auth.register(app);
registerPushEndpoints(app, { getClient });

// Panel jest adminOnly (bramka panelu wpuszcza tylko admina). Etykieta/karta
// zamówienia dostępne przez wspólne endpointy wycen; akcje pakowania w module
// fulfillment. requireAdmin jako druga warstwa na mutacjach.
const allow = (req, res, next) => next();
registerWycenyEndpoints(app, {
  getClient,
  requireView: allow,
  requireEdit: allow,
  isAdmin,
});
registerFulfillmentEndpoints(app, { getClient, requireAdmin: auth.requireAdmin });

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

const PORT = process.env.PORT || 3009;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Panel Fulfillment działa na http://localhost:${PORT}`);
  });
}

module.exports = app;
