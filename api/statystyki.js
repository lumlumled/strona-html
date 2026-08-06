// Wrapper wymagany przez Vercel: logika API statystyk żyje w
// apps/statystyki/server/server.js — ten plik montuje ją pod /statystyki
// (patrz vercel.json rewrites: /statystyki/api/:path* → /api/statystyki),
// analogicznie do api/sprzedaze.js. Human-facing /statystyki (strona
// "wkrótce") nadal renderuje hub — tu wpada tylko ruch /statystyki/api/*.
const express = require('express');
const statystykiApp = require('../apps/statystyki/server/server.js');
// Panel Kreacje (Content Intelligence dla SMM) DZIELI tę funkcję — limit 12
// funkcji na Vercel Hobby. Reużywa queries.js Statystyk. Osobny mount /kreacje
// = w pełni odrębny panel (własna bramka panelKey:'kreacje', własne API_BASE).
const kreacjeApp = require('../apps/kreacje/server/server.js');

const wrapper = express();
wrapper.use('/statystyki', statystykiApp);
wrapper.use('/kreacje', kreacjeApp);

module.exports = wrapper;
