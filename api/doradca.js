// Wrapper Vercel: panel Doradca (apps/doradca/server/server.js) montowany pod
// /doradca. Analogicznie do api/statystyki.js. Silnik doradcy reużywa fasady
// danych ze Statystyk (apps/statystyki/server/queries.js) — musi być w
// includeFiles (patrz vercel.json).
const express = require('express');
const doradcaApp = require('../apps/doradca/server/server.js');

const wrapper = express();
wrapper.use('/doradca', doradcaApp);

module.exports = wrapper;
