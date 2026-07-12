// Wrapper wymagany przez Vercel: publiczne endpointy formularza zamówienia
// (GET dane / POST zapis / webhook inFakt) żyją w apps/formularz/server/ —
// ten plik montuje je pod /formularz (patrz vercel.json rewrites).
const express = require('express');
const formularzApp = require('../apps/formularz/server/server.js');

const wrapper = express();
wrapper.use('/formularz', formularzApp);

module.exports = wrapper;
