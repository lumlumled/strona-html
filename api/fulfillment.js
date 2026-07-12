// Wrapper wymagany przez Vercel: cała logika (auth, routing, Supabase) żyje
// w apps/fulfillment/server/server.js — ten plik montuje ją pod /fulfillment
// (patrz vercel.json rewrites), analogicznie do api/sprzedaze.js.
const express = require('express');
const fulfillmentApp = require('../apps/fulfillment/server/server.js');

const wrapper = express();
wrapper.use('/fulfillment', fulfillmentApp);

module.exports = wrapper;
