// Runtime ustawienia w kom_settings (klucz → wartość jsonb). Pierwszy konsument:
// włącznik auto-wysyłki autorespondera (auto_send_enabled). Tabela istniała od
// migracji 005, ale nie miała dotąd kodu.

async function getSetting(db, key, fallback = null) {
  const { data, error } = await db.from('kom_settings').select('value').eq('key', key).limit(1);
  if (error) throw error;
  return data && data.length ? data[0].value : fallback;
}

async function setSetting(db, key, value) {
  const { error } = await db
    .from('kom_settings')
    .upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw error;
  return value;
}

module.exports = { getSetting, setSetting };
