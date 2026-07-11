// Wrapper wymagany przez Vercel: cała logika (auth, webhooki, Supabase) żyje
// w apps/komunikator/server/server.js — ten plik montuje ją pod /wiadomosci
// (patrz vercel.json rewrites), analogicznie do api/crm.js.
const express = require('express');
const komunikatorApp = require('../apps/komunikator/server/server.js');

const wrapper = express();
wrapper.use('/wiadomosci', komunikatorApp);

module.exports = wrapper;
