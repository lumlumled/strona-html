// Wrapper wymagany przez Vercel: cała logika (auth, routing, Supabase) żyje
// w apps/sprzedaze/server/server.js — ten plik montuje ją pod /sprzedaze
// (patrz vercel.json rewrites), analogicznie do api/crm.js.
const express = require('express');
const sprzedazeApp = require('../apps/sprzedaze/server/server.js');

const wrapper = express();
wrapper.use('/sprzedaze', sprzedazeApp);

module.exports = wrapper;
