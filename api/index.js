// Wrapper wymagany przez Vercel: panel główny lumlum.dev (karta startowa
// narzędzi + logowanie na całą domenę) żyje w apps/hub/server/server.js —
// ten plik montuje go w korzeniu (patrz vercel.json rewrites), analogicznie
// do api/backlog-b2c.js i api/crm.js.
//
// Panel Feedbacki DZIELI tę funkcję z hubem zamiast mieć własny api/feedbacki.js.
// Powód: Vercel traktuje KAŻDY plik w api/ jako osobną funkcję serverless, a
// plan Hobby dopuszcza max 12 — osobny wrapper byłby 13. i wywalił deploy.
// Trasy /feedbacki obsługuje jego własna appka (własna bramka auth, własne
// API_BASE=/feedbacki); vercel.json przekierowuje /feedbacki/* -> /api/index.
// Lokalnie ten plik nie jest używany — feedbacki stoi samodzielnie na :3013.
const express = require('express');
const hubApp = require('../apps/hub/server/server.js');
const feedbackiApp = require('../apps/feedbacki/server/server.js');

const wrapper = express();
wrapper.use('/feedbacki', feedbackiApp);
wrapper.use('/', hubApp);

module.exports = wrapper;
