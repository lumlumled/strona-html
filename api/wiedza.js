// Wrapper wymagany przez Vercel: cała logika żyje w
// apps/wiedza/server/server.js — ten plik montuje ją pod /wiedza
// (patrz vercel.json rewrites), analogicznie do api/crm.js.
const express = require('express');
const wiedzaApp = require('../apps/wiedza/server/server.js');

const wrapper = express();
wrapper.use('/wiedza', wiedzaApp);

module.exports = wrapper;
