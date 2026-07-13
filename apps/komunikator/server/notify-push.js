// ── Push „Nowa wiadomość" (komunikator) ─────────────────────────────────────
// Odpala się, gdy PRZYCHODZĄCA wiadomość zostaje zaklasyfikowana do 'inbox'
// (realne zapytanie wymagające uwagi — nie spam/hejt/automat). Wzorzec 1:1 z
// notifyWyceny/notifyNewLead: cel = admini (Antoni) + env KOM_NOTIFY (loginy po
// przecinku). Deep-link /wiadomosci/?klient=<public_id> (openFromUrl w app.html).
// Nigdy nie wywala ingestu/triage — błędy tylko logujemy.

const CHANNEL_LABEL = {
  messenger: 'Messenger', instagram: 'Instagram', whatsapp: 'WhatsApp',
  tiktok: 'TikTok', email: 'E-mail', phone: 'Telefon', note: 'Notatka',
};

async function notifyNewMessage(db, { thread, body }) {
  try {
    const push = require('../../shared/server/push');
    if (!push || !push.notifyUser || !thread) return;

    const wanted = new Set(
      String(process.env.KOM_NOTIFY || '')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    );
    const { data: users } = await db.from('app_users').select('id,name,role').eq('active', true);
    const targets = (users || []).filter((u) => u.role === 'admin'
      || wanted.has(String(u.name || '').trim().toLowerCase()));
    if (!targets.length) return;

    const { data: cust } = await db.from('kom_customers')
      .select('public_id,display_name').eq('id', thread.customer_id).limit(1);
    const publicId = cust?.[0]?.public_id || null;
    const nazwa = cust?.[0]?.display_name || 'Klient';
    const kanal = CHANNEL_LABEL[thread.channel] || thread.channel;
    const tekst = String(body || '').replace(/\s+/g, ' ').trim().slice(0, 120) || '(bez treści)';
    const url = publicId ? `/wiadomosci/?klient=${encodeURIComponent(publicId)}` : '/wiadomosci/';

    for (const u of targets) {
      await push.notifyUser(() => db, u.id, {
        title: `Nowa wiadomość · ${kanal}`,
        body: `${nazwa}: ${tekst}`,
        url,
        tag: `kom-msg-${thread.id}`, // kolejne wiadomości z tego wątku zwijają się w jedno
      });
    }
  } catch (err) {
    console.warn('Push nowej wiadomości nie wyszedł:', err.message);
  }
}

module.exports = { notifyNewMessage };
