// Autoresponder — silnik decyzji (tani, w webhooku) + worker (cron).
// Zasady i katalog: docs/plan-auto-odpowiedzi-komentarze.md.
//
// PROJEKT BEZPIECZEŃSTWA:
// - Włącznik kom_settings.auto_send_enabled steruje CZY wysyłamy. OFF (domyślnie)
//   = tryb podglądu: worker generuje treść i oznacza 'held' ("wysłałby"), ale
//   NIC nie idzie do klienta. ON = te same decyzje realnie się wysyłają.
// - Decyzja w webhooku jest REGUŁOWA (bez LLM), żeby zmieścić się w budżecie
//   ~5 s i nigdy nie wywrócić ingestu (consider nie rzuca — łapie własne błędy).
// - Auto tylko dla PIERWSZEGO kontaktu (brak naszej wcześniejszej odpowiedzi w
//   wątku). Follow-upy i wątki z załącznikiem idą ścieżką propozycji (suggest.js
//   na otwarcie wątku), nie automatem.

const SETTING_KEY = 'auto_send_enabled';
const MIN_DELAY_MS = 2 * 60 * 1000;   // opóźnienie anty-bot: 2 min
const MAX_DELAY_MS = 15 * 60 * 1000;  // ...do 15 min
const BATCH = 8;                      // ile pozycji na przebieg workera

const DM_CHANNELS = new Set(['messenger', 'instagram', 'whatsapp']);

function randomDelayMs() {
  return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
}

function looksLikeOwnPage(customer) {
  const name = (customer && customer.display_name) || '';
  return /lumlum/i.test(name);
}

// Wołane z ingest/zernio.js po zapisaniu wiadomości i triage'u. Szybkie,
// nie rzuca. Kwalifikuje pierwszy kontakt do auto-odpowiedzi → wiersz 'queued'.
async function consider(db, { thread, messageId, verdict, channel, kind, hasAttachment, customer }) {
  try {
    if (!thread || !messageId) return { skipped: 'no-input' };
    // Tylko sprawy warte odpowiedzi (bramka intencji triage'u).
    if (verdict && (verdict.triage !== 'inbox' || verdict.needsReply === false)) {
      return { skipped: 'triage' };
    }
    // Zakres kanałów: komentarz (private reply) albo DM Messenger/IG/WhatsApp.
    const isComment = kind === 'comment';
    if (!isComment && !DM_CHANNELS.has(channel)) return { skipped: `channel:${channel}` };
    // Załącznik od klienta → wymaga oceny człowieka, nigdy auto.
    if (hasAttachment) return { skipped: 'attachment' };
    // Nasz własny komentarz wciągnięty jako inbound — nie odpowiadamy sobie.
    if (looksLikeOwnPage(customer)) return { skipped: 'own-page' };

    // Pierwszy kontakt? Jeśli już kiedyś wysłaliśmy coś w tym wątku → follow-up,
    // zostawiamy ścieżce propozycji (suggest.js na otwarcie wątku).
    const { count: outCount, error: outErr } = await db
      .from('kom_messages')
      .select('id', { count: 'exact', head: true })
      .eq('thread_id', thread.id)
      .eq('direction', 'out');
    if (outErr) throw outErr;
    if (outCount && outCount > 0) return { skipped: 'follow-up' };

    // Dedup: już rozpatrzony ten wątek (nie kolejkujemy drugi raz).
    const { data: existing, error: exErr } = await db
      .from('kom_autoreply')
      .select('id')
      .eq('thread_id', thread.id)
      .in('status', ['queued', 'held', 'sent'])
      .limit(1);
    if (exErr) throw exErr;
    if (existing && existing.length) return { skipped: 'already-considered' };

    const sendAfter = new Date(Date.now() + randomDelayMs()).toISOString();
    const { error: insErr } = await db.from('kom_autoreply').insert({
      thread_id: thread.id,
      in_message_id: messageId,
      channel,
      kind: isComment ? 'comment' : 'dm',
      verdict: 'send',
      reason: 'first-contact',
      send_after: sendAfter,
      status: 'queued',
    });
    if (insErr) throw insErr;
    return { queued: true, send_after: sendAfter };
  } catch (err) {
    // Nigdy nie wywracamy ingestu przez autoresponder.
    console.error('autoreply.consider:', err.message);
    return { error: err.message };
  }
}

// Worker (cron /api/cron/outbox). ctx wstrzykuje funkcje z server.js, żeby
// uniknąć cyklicznego require: { getSetting, generateSuggestion, loadCustomer,
// computeSendState, sendViaZernio, sendPrivateReply }.
async function sweep(db, ctx) {
  const enabled = (await ctx.getSetting(db, SETTING_KEY, false)) === true;
  const nowIso = new Date().toISOString();
  const { data: due, error } = await db
    .from('kom_autoreply')
    .select('*')
    .eq('status', 'queued')
    .lte('send_after', nowIso)
    .order('send_after', { ascending: true })
    .limit(BATCH);
  if (error) throw error;

  const result = { enabled, processed: 0, sent: 0, held: 0, skipped: 0, failed: 0 };

  for (const row of due || []) {
    result.processed += 1;
    try {
      const { data: threads, error: tErr } = await db
        .from('kom_threads').select('*').eq('id', row.thread_id).limit(1);
      if (tErr) throw tErr;
      const thread = threads && threads[0];
      if (!thread) { await mark(db, row.id, 'skipped', { reason: 'no-thread' }); result.skipped += 1; continue; }

      const { data: messages, error: mErr } = await db
        .from('kom_messages').select('*')
        .eq('thread_id', thread.id).order('created_at', { ascending: true }).limit(100);
      if (mErr) throw mErr;

      // Twarda walidacja okna Meta (to samo źródło prawdy co wysyłka z panelu).
      const sendState = ctx.computeSendState(thread, messages || []);
      if (['closed', 'none', 'manual_only'].includes(sendState.mode)) {
        await mark(db, row.id, 'skipped', { reason: `send-${sendState.mode}:${sendState.reason || ''}` });
        result.skipped += 1;
        continue;
      }

      const customer = await ctx.loadCustomer(db, thread.customer_id);
      const { data: ids } = await db
        .from('kom_customer_identities').select('type').eq('customer_id', customer.id);
      customer.identities = ids || [];

      const gen = await ctx.generateSuggestion(db, thread, customer, messages || []);
      const text = (gen && gen.text || '').trim();
      if (!text) { await mark(db, row.id, 'failed', { error: 'empty-generation' }); result.failed += 1; continue; }

      // Wyłączone → podgląd na sucho: zapisz co BY wysłał, nic nie wychodzi.
      if (!enabled) {
        await mark(db, row.id, 'held', { generated_text: text, suggestion_id: gen.id || null });
        result.held += 1;
        continue;
      }

      // Włączone → realna wysyłka per kanał.
      const outMeta = { auto: true };
      if (sendState.mode === 'private_reply') {
        await ctx.sendPrivateReply(thread, sendState.comment, text);
        outMeta.private_reply_to = sendState.comment.commentId;
      } else {
        await ctx.sendViaZernio(thread, text, { humanAgent: sendState.mode === 'human_agent' });
        if (sendState.mode === 'human_agent') outMeta.human_agent = true;
      }
      // Historia (external_message_id dla Zernio NULL — webhook message.sent
      // dopina ID po treści, tak jak przy wysyłce z panelu).
      await db.from('kom_messages').insert({
        thread_id: thread.id,
        direction: 'out',
        body: text,
        sent_by: 'ai_auto',
        suggestion_id: gen.id || null,
        meta: outMeta,
      });
      await db.from('kom_threads')
        .update({ status: 'waiting', last_message_at: new Date().toISOString() })
        .eq('id', thread.id);
      await mark(db, row.id, 'sent', { generated_text: text, suggestion_id: gen.id || null, sent_at: new Date().toISOString() });
      result.sent += 1;
    } catch (err) {
      const windowClosed = err && err.windowClosed;
      await mark(db, row.id, windowClosed ? 'skipped' : 'failed', { error: err.message, ...(windowClosed ? { reason: 'window-closed' } : {}) });
      result[windowClosed ? 'skipped' : 'failed'] += 1;
      console.error('autoreply.sweep row:', err.message);
    }
  }
  return result;
}

async function mark(db, id, status, patch = {}) {
  await db.from('kom_autoreply').update({ status, ...patch }).eq('id', id);
}

module.exports = { consider, sweep, SETTING_KEY };
