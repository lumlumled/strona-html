// Backfill kom_attachments z historycznych kom_messages.meta.attachments
// (wiadomości sprzed wdrożenia media.js). Idempotentny: captureZernio robi
// upsert z ignoreDuplicates po (message_id, position). Pobranie plików i
// analizę AI zrobi worker (media.sweep) — część linków CDN Mety już wygasła,
// te wiersze skończą jako status 'expired' z czytelnym chipem w panelu.
// Użycie: node scripts/backfill-kom-attachments.js
const path = require('path');
const KOM = path.join(__dirname, '..', 'apps', 'komunikator', 'server');
require(path.join(KOM, 'node_modules', 'dotenv')).config({ path: path.join(KOM, '.env') });
const { getClient } = require(path.join(KOM, 'supabase'));
const media = require(path.join(KOM, 'media'));

(async () => {
  const db = getClient();
  const { data: msgs, error } = await db.from('kom_messages')
    .select('id,thread_id,direction,meta,created_at')
    .not('meta->attachments', 'is', null)
    .order('created_at', { ascending: true });
  if (error) throw error;

  let captured = 0;
  for (const m of msgs || []) {
    const atts = m.meta?.attachments;
    if (!Array.isArray(atts) || !atts.length) continue;
    const r = await media.captureZernio(db, {
      messageId: m.id,
      threadId: m.thread_id,
      direction: m.direction === 'out' ? 'out' : 'in',
      attachments: atts,
    });
    captured += r.captured;
    console.log(`${m.created_at} msg=${m.id} dir=${m.direction} → ${r.captured} zał.`);
  }
  console.log(`Wiadomości z załącznikami: ${(msgs || []).length}, wierszy kom_attachments: ${captured}`);
})().catch((e) => { console.error(e); process.exit(1); });
