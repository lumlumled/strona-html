// Weryfikacja seeda: czy fakty/wzorce wracają w retrievalu i czy widoczność działa.
const path = require('path');
const KOM_SERVER = path.join(__dirname, '..', 'apps', 'komunikator', 'server');
require(path.join(KOM_SERVER, 'node_modules', 'dotenv')).config({ path: path.join(KOM_SERVER, '.env') });
const { createClient } = require(path.join(KOM_SERVER, 'node_modules', '@supabase/supabase-js'));
const knowledge = require(path.join(__dirname, '..', 'apps', 'shared', 'server', 'knowledge.js'));

async function main() {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  console.log('--- FAKTY dla "ile kosztuje sterownik i zestaw" (rola team = jak w sugestiach) ---');
  console.log(await knowledge.retrieveForPrompt(db, { query: 'ile kosztuje sterownik i zestaw', role: 'team', k: 5 }) || '(brak)');

  console.log('\n--- Test widoczności: "ile kosztuje metr taśmy" ---');
  const teamMeter = await knowledge.search(db, { query: 'ile kosztuje metr taśmy cyfrowej', role: 'team', k: 5 });
  const ownerMeter = await knowledge.search(db, { query: 'ile kosztuje metr taśmy cyfrowej', role: 'owner', k: 5 });
  console.log('rola team widzi "75 zł/m"?  ', teamMeter.some((f) => /75 zł/.test(f.content)));
  console.log('rola owner widzi "75 zł/m"? ', ownerMeter.some((f) => /75 zł/.test(f.content)));

  console.log('\n--- WZORCE STYLU (kom_match_examples) dla "gdzie mogę zamówić" ---');
  const emb = await knowledge.embed('gdzie mogę zamówić takie taśmy');
  const { data, error } = await db.rpc('kom_match_examples', { query_embedding: emb, match_count: 3 });
  if (error) throw error;
  (data || []).forEach((r, i) => console.log(`${i + 1}. [${(r.tags || []).join(',')}] ${String(r.final).slice(0, 90)}...`));
}

main().catch((err) => { console.error(err); process.exit(1); });
