// Wrapper wymagany przez Vercel: cała logika (auth, routing, Supabase) żyje
// w apps/wyceny/server/server.js — ten plik montuje ją pod /wyceny (patrz
// vercel.json rewrites), analogicznie do api/sprzedaze.js.
const express = require('express');
const wycenyApp = require('../apps/wyceny/server/server.js');

const wrapper = express();
wrapper.use('/wyceny', wycenyApp);

module.exports = wrapper;
