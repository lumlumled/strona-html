// Wzorzec jak apps/test/server/supabase.js — leniwy singleton klienta Supabase
// na kluczu service-role (panel działa wyłącznie server-side).
const { createClient } = require('@supabase/supabase-js');

let client = null;

function getClient() {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Brak SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY w env');
    client = createClient(url, key, { auth: { persistSession: false } });
  }
  return client;
}

module.exports = { getClient };
