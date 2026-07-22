require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { getClient } = require('./supabase');
const { registerLeadyEndpoints } = require('../../shared/server/leady-endpoints');
const { registerWycenyEndpoints } = require('../../shared/server/wyceny-endpoints');
const { registerKontaktEndpoints } = require('../../shared/server/kontakt-endpoints');
const { registerWatchdogEndpoints } = require('../../shared/server/watchdog-dispatcher');
const { registerFeedbackiEndpoints } = require('../../shared/server/feedbacki-endpoints');
const { createAuth, clientPayload, panelLinks, isAdmin } = require('../../shared/server/auth');
const { servePushWorker, registerPushEndpoints } = require('../../shared/server/push');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Bez tego Vercel CDN cache'owałby odpowiedzi (w tym stronę po zalogowaniu)
// i serwował je z pominięciem bramki hasła — patrz apps/crm/server/server.js.
app.use((req, res, next) => {
  if (!req.path.startsWith('/assets/')) res.set('Cache-Control', 'no-store');
  next();
});

// Assets i wspólne pliki karty leada PRZED bramką auth (statyki: logo, style
// karty). Te same pliki apps/shared/* serwuje CRM/Backlog pod swoim /shared/.
app.get('/assets/:file', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'assets', req.params.file));
});
app.get('/shared/:file', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'shared', req.params.file));
});

const auth = createAuth({ getClient, panelKey: 'feedbacki', loginTitle: 'Feedbacki' });
servePushWorker(app);
auth.register(app);
registerPushEndpoints(app, { getClient });

// Szuflada z pełną kartą klienta reużywa wspólną LeadKarta, więc panel musi
// wystawić DOKŁADNIE te same endpointy co CRM (leady, wyceny, kontakt).
// Uprawnienia per arkusz: kartę leada widzi ktoś z podglądem „Leady B2C".
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

// Dane kalendarza + zamykanie „zrobione" (watchdog: /api/watchdog/alerty/:id/
// zamknij dla watchy, /api/watchdog/obietnice/:id/zamknij dla obietnic).
registerFeedbackiEndpoints(app, { getClient, isAdmin });
registerWatchdogEndpoints(app, { getClient, isAdmin });

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

const PORT = process.env.PORT || 3013;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Serwer Feedbacki działa na http://localhost:${PORT}`);
  });
}

module.exports = app;
