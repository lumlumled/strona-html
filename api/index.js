// Wrapper wymagany przez Vercel: panel główny lumlum.dev (karta startowa
// narzędzi + logowanie na całą domenę) żyje w apps/hub/server/server.js —
// ten plik montuje go w korzeniu (patrz vercel.json rewrites), analogicznie
// do api/backlog-b2c.js i api/crm.js.
const hubApp = require('../apps/hub/server/server.js');

module.exports = hubApp;
