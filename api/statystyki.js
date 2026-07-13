// Wrapper wymagany przez Vercel: logika API statystyk żyje w
// apps/statystyki/server/server.js — ten plik montuje ją pod /statystyki
// (patrz vercel.json rewrites: /statystyki/api/:path* → /api/statystyki),
// analogicznie do api/sprzedaze.js. Human-facing /statystyki (strona
// "wkrótce") nadal renderuje hub — tu wpada tylko ruch /statystyki/api/*.
const express = require('express');
const statystykiApp = require('../apps/statystyki/server/server.js');

const wrapper = express();
wrapper.use('/statystyki', statystykiApp);

module.exports = wrapper;
