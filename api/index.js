// Wrapper wymagany przez Vercel: cała logika (auth, routing, Supabase) żyje
// w server/server.js — ten plik tylko go re-eksportuje jako Vercel Function,
// zamiast duplikować kod, żeby lokalny `cd server && npm start` i deployment
// na Vercelu korzystały z tego samego źródła.
module.exports = require('../server/server.js');
