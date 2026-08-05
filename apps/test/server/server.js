require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { getClient } = require('./supabase');
const { createAuth, clientPayload, panelLinks } = require('../../shared/server/auth');
const { registerTestPanelEndpoints } = require('../../shared/server/test-panel-endpoints');
const { servePushWorker, registerPushEndpoints } = require('../../shared/server/push');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Bez tego Vercel CDN cache'owałby odpowiedzi z pominięciem bramki hasła —
// patrz apps/crm/server/server.js.
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

// Panel jest adminOnly w rejestrze PANELS (auth.js), więc bramka wpuszcza
// wyłącznie adminów — Lorenzo nie zobaczy własnego kokpitu kontroli.
const auth = createAuth({ getClient, panelKey: 'test', loginTitle: 'Test' });
servePushWorker(app);
auth.register(app);
registerPushEndpoints(app, { getClient });

registerTestPanelEndpoints(app, { getClient });

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

const PORT = process.env.PORT || 3014;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Serwer Test działa na http://localhost:${PORT}`);
  });
}

module.exports = app;
