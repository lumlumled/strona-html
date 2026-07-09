// Wrapper wymagany przez Vercel: cała logika (auth, routing, Supabase) żyje
// w apps/backlog-b2c/server/server.js — ten plik montuje ją pod /backlog-b2c
// (patrz vercel.json rewrites), zamiast duplikować kod, żeby lokalny
// `cd apps/backlog-b2c/server && npm start` i deployment na Vercelu
// korzystały z tego samego źródła. server.js sam się dostosowuje do
// mount-prefixu przez req.baseUrl (patrz redirecty/cookie/API_BASE w
// server.js) — nie jest napisany specyficznie pod ten wrapper.
const express = require('express');
const backlogB2cApp = require('../apps/backlog-b2c/server/server.js');

const wrapper = express();
wrapper.use('/backlog-b2c', backlogB2cApp);

module.exports = wrapper;
