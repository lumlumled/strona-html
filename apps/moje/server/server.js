require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { getClient } = require('./supabase');
const { createAuth, clientPayload, panelLinks, isAdmin } = require('../../shared/server/auth');
const { registerMojePanelEndpoints } = require('../../shared/server/moje-panel-endpoints');
const { registerLeadyEndpoints } = require('../../shared/server/leady-endpoints');
const { registerWycenyEndpoints } = require('../../shared/server/wyceny-endpoints');
const { registerKontaktEndpoints } = require('../../shared/server/kontakt-endpoints');
const { servePushWorker, registerPushEndpoints } = require('../../shared/server/push');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Bez tego Vercel CDN cache'owałby odpowiedzi z pominięciem bramki hasła —
// patrz apps/test/server/server.js.
app.use((req, res, next) => {
  if (!req.path.startsWith('/assets/')) res.set('Cache-Control', 'no-store');
  next();
});

// Statyki przed bramką auth (logo do topbara + wspólne style).
app.get('/assets/:file', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'assets', req.params.file));
});
app.get('/shared/:file', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'shared', req.params.file));
});

// Panel NIE jest adminOnly (rejestr PANELS w auth.js) — wpuszcza każdego, kto ma
// panel 'moje' w permissions.panels. Dla Lorenza to jego własny kokpit umowy;
// admin też może wejść (podgląd). Dane i tak dotyczą wyłącznie handlowca.
const auth = createAuth({ getClient, panelKey: 'moje', loginTitle: 'Moje wyniki' });
servePushWorker(app);
auth.register(app);
registerPushEndpoints(app, { getClient });

registerMojePanelEndpoints(app, { getClient });

// Szuflada z pełną kartą leada reużywa wspólną LeadKarta (jak Feedbacki), więc
// /moje musi wystawić DOKŁADNIE te same endpointy co CRM (leady, wyceny,
// kontakt). Karta widoczna dla kogoś z podglądem „Leady B2C" — Lorenzo ma edit.
const requireLeadyView = auth.requireSheet('leady-b2c', 'view');
const requireLeadyEdit = auth.requireSheet('leady-b2c', 'edit');
registerWycenyEndpoints(app, {
  getClient,
  requireView: auth.requireSheet('wyceny', 'view'),
  requireEdit: auth.requireSheet('wyceny', 'edit'),
  isAdmin,
});
registerLeadyEndpoints(app, { getClient, requireView: requireLeadyView, requireEdit: requireLeadyEdit });
registerKontaktEndpoints(app, { getClient, requireView: requireLeadyView, requireEdit: requireLeadyEdit });

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

const PORT = process.env.PORT || 3015;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Serwer Moje działa na http://localhost:${PORT}`);
  });
}

module.exports = app;
