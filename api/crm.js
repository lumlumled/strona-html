// Wrapper wymagany przez Vercel: cała logika (auth, routing, Supabase) żyje
// w apps/crm/server/server.js — ten plik montuje ją pod /crm (patrz
// vercel.json rewrites), analogicznie do api/backlog-b2c.js.
const express = require('express');
const crmApp = require('../apps/crm/server/server.js');

const wrapper = express();
wrapper.use('/crm', crmApp);

module.exports = wrapper;
