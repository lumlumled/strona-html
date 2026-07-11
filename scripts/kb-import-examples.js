// Import wzorców stylu odpowiedzi do kom_examples (korpus, z którego uczą
// się sugestie Komunikatora): JSON [{context, final, tags?}] → wiersze
// source='import' z embeddingiem kontekstu (pod przyszłą selekcję wektorową).
// Idempotentny per plik: usuwa wcześniejsze wiersze z tym samym tagiem partii.
// Użycie: node scripts/kb-import-examples.js plik.json tag-partii [tag2,tag3]
const path = require('path');
const fs = require('fs');
const KOM_SERVER = path.join(__dirname, '..', 'apps', 'komunikator', 'server');
require(path.join(KOM_SERVER, 'node_modules', 'dotenv')).config({ path: path.join(KOM_SERVER, '.env') });
const { createClient } = require(path.join(KOM_SERVER, 'node_modules', '@supabase/supabase-js'));
const knowledge = require(path.join(__dirname, '..', 'apps', 'shared', 'server', 'knowledge.js'));

async function main() {
  const [file, batchTag, extraTags] = process.argv.slice(2);
  if (!file || !batchTag) throw new Error('Użycie: kb-import-examples.js plik.json tag-partii [tagi,po,przecinku]');
  const pairs = JSON.parse(fs.readFileSync(file, 'utf8'));
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { error: delErr } = await db.from('kom_examples').delete().contains('tags', [batchTag]);
  if (delErr) throw delErr;

  const tags = [batchTag, ...(extraTags ? extraTags.split(',') : [])];
  let n = 0;
  for (const p of pairs) {
    if (!p.context || !p.final) continue;
    const embedding = await knowledge.embed(p.context);
    const { error } = await db.from('kom_examples').insert({
      source: 'import',
      context: p.context,
      final: p.final,
      tags: p.tags ? [...tags, ...p.tags] : tags,
      embedding,
    });
    if (error) throw error;
    n += 1;
  }
  console.log(`OK — zaimportowano ${n} wzorców (tag: ${batchTag})`);
}

main().catch((err) => { console.error(err); process.exit(1); });
