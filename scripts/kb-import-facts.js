// Import faktów do Bazy Wiedzy z pliku JSON (tablica obiektów w formacie
// proposeFact: title, content, tags, visibility, status, source, sourceRef).
// Domyślnie status 'proposed' — wszystko przechodzi przez review Antoniego.
// Użycie: node scripts/kb-import-facts.js /ścieżka/do/faktów.json
const path = require('path');
const fs = require('fs');
const KOM_SERVER = path.join(__dirname, '..', 'apps', 'komunikator', 'server');
require(path.join(KOM_SERVER, 'node_modules', 'dotenv')).config({ path: path.join(KOM_SERVER, '.env') });
const { createClient } = require(path.join(KOM_SERVER, 'node_modules', '@supabase/supabase-js'));
const knowledge = require(path.join(__dirname, '..', 'apps', 'shared', 'server', 'knowledge.js'));

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Podaj ścieżkę do pliku JSON z faktami');
  const facts = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(facts)) throw new Error('Plik musi zawierać tablicę faktów');
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  let n = 0;
  for (const f of facts) {
    await knowledge.proposeFact(db, {
      title: f.title,
      content: f.content,
      tags: f.tags || [],
      visibility: f.visibility || 'owner',
      status: f.status || 'proposed',
      source: f.source || 'extracted',
      sourceRef: f.sourceRef || null,
      createdBy: f.createdBy || 'ai:claude-code',
    });
    n += 1;
    console.log(`✓ ${f.title}`);
  }
  console.log(`OK — zaimportowano ${n} faktów`);
}

main().catch((err) => { console.error(err); process.exit(1); });
