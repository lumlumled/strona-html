// Backfill kolumny kom_threads.wycena_intent (migracja 012) dla ISTNIEJĄCYCH
// wątków. Klasyfikator triage ustawia intencję wyceny tylko dla NOWYCH
// wiadomości, więc rozmowy sprzed wdrożenia bramki trzeba doklasyfikować raz.
//
// Bierze wątki triage='inbox' bez intencji, na każdym uruchamia klasyfikator
// triage na najnowszej przychodzącej wiadomości (+ krótka historia). Gdy AI
// wykryje intencję wyceny → wątek dostaje wycena_intent=true i pojawi się na
// liście Organic w CRM.
//
// Dry-run domyślnie (tylko raport). Zapis: node scripts/backfill-wycena-intent.js --apply
// Limit wątków:                          node scripts/backfill-wycena-intent.js --apply --limit 100
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'server', '.env') });

const { getClient } = require('../server/supabase');
const triage = require('../server/triage');

const CHANNEL_IDENTITY = { messenger: 'fb', instagram: 'ig', whatsapp: 'wa', tiktok: 'tt', email: 'email', phone: 'phone' };

async function main() {
  const apply = process.argv.includes('--apply');
  const limIdx = process.argv.indexOf('--limit');
  const limit = limIdx >= 0 ? Number(process.argv[limIdx + 1]) || 500 : 500;
  const db = getClient();

  const { data: threads, error } = await db
    .from('kom_threads')
    .select('id, customer_id, channel, meta, wycena_intent, triage')
    .eq('triage', 'inbox')
    .eq('wycena_intent', false)
    .neq('channel', 'note')
    .order('last_message_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  console.log(`Wątków inbox bez intencji: ${threads.length}${apply ? '' : ' (dry-run)'}`);

  let hits = 0;
  let done = 0;
  for (const thread of threads) {
    // Najnowsza przychodząca + krótka historia (jak sweep()).
    const { data: msgs } = await db
      .from('kom_messages').select('direction, body, meta, created_at')
      .eq('thread_id', thread.id).eq('direction', 'in')
      .order('created_at', { ascending: false }).limit(6);
    const latest = (msgs || [])[0];
    if (!latest) continue;

    const { data: customers } = await db
      .from('kom_customers').select('display_name').eq('id', thread.customer_id).limit(1);
    const identityType = CHANNEL_IDENTITY[thread.channel];
    const { data: identities } = identityType
      ? await db.from('kom_customer_identities').select('value').eq('customer_id', thread.customer_id).eq('type', identityType).limit(1)
      : { data: [] };

    try {
      const result = await triage.classifyMessage(db, {
        kind: thread.channel === 'email' ? 'email' : (latest.meta?.kind === 'comment' ? 'comment' : 'dm'),
        channel: thread.channel,
        text: latest.body,
        senderName: customers?.[0]?.display_name || null,
        senderType: identityType,
        senderValue: identities?.[0]?.value || null,
        history: (msgs || []).slice(1).reverse(),
      });
      done += 1;
      if (result.wycenaIntent) {
        hits += 1;
        console.log(`  ✓ #${thread.id} (${thread.channel}) → intencja wyceny: ${String(latest.body).slice(0, 70).replace(/\n/g, ' ')}`);
        if (apply) {
          await db.from('kom_threads').update({ wycena_intent: true }).eq('id', thread.id);
        }
      }
    } catch (err) {
      console.error(`  ✗ #${thread.id}:`, err.message);
    }
  }

  console.log(`\nGotowe: przeanalizowano ${done}, z intencją wyceny ${hits}${apply ? ' (zapisane)' : ' (dry-run — dodaj --apply)'}.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
