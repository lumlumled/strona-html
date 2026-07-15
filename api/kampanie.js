// Wrapper wymagany przez Vercel: cała logika (auth, routing, Supabase) żyje
// w apps/kampanie/server/server.js — ten plik montuje ją pod /kampanie
// (patrz vercel.json rewrites), analogicznie do api/fulfillment.js.
const express = require('express');
const kampanieApp = require('../apps/kampanie/server/server.js');

const wrapper = express();
wrapper.use('/kampanie', kampanieApp);

module.exports = wrapper;
