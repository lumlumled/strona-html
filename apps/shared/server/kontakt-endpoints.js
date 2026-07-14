// ── Panel Kontakt na karcie leada (Backlog B2C + CRM) ────────────────────────
// Etap 1 planu docs/plan-kontakt-karta-leada.md: scalona oś czasu kontaktu.
// Telefony/notatki żyją w kolumnie "Historia rozmów" i "Log zmian" (front ma
// je pod ręką), a ten endpoint dokłada wiadomości z komunikatora (mail/DM/
// komentarze, docelowo SMS) dopasowane po telefonie/e-mailu leada — wzorzec
// read-time jak GET /api/wyceny/dla-leada, bez nowej tabeli.
//
// Przy pierwszym trafieniu zapisuje kom_customers.crm_lead_id — "jedyny most
// do CRM" z migracji komunikatora (001_init.sql), dotąd nieużywany. Dzięki
// temu kolejne odczyty i przyszłe odwrotne lookupy (komunikator → karta) mają
// trwały link; istniejącego, INNEGO powiązania nigdy nie nadpisujemy.

// Czysta logika tożsamości komunikatora (normalizacja 48XXXXXXXXX, łańcuch
// merged_into) — moduł jest dependency-injected, więc require przez appki
// CRM/Backlog jest bezpieczny (Vercel dociąga plik przez trace require()).
const identity = require('../../komunikator/server/identity');

function normalizePhoneDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

function handleError(res, err, fallbackStatus = 400) {
  console.error(err);
  const message = err.message || 'Wewnętrzny błąd serwera';
  res.status(fallbackStatus).json({ error: message });
}

function registerKontaktEndpoints(app, { getClient, requireView }) {
  const view = requireView || ((req, res, next) => next());

  // GET /api/kontakt/dla-leada?telefon=&email=&lead_id= — klienci komunikatora
  // dopasowani do leada + ich wiadomości (wszystkie kanały, najnowsze pierwsze,
  // limit 300). Front skleja to z wpisami karty w jedną oś czasu.
  app.get('/api/kontakt/dla-leada', view, async (req, res) => {
    try {
      const db = getClient();
      const digits = normalizePhoneDigits(req.query.telefon);
      const email = String(req.query.email || '').trim().toLowerCase();
      // lead_id kanonicznie int-jako-tekst ("314", nie "314.0") — spójnie
      // z wyceny.lead_id i GET /api/wyceny/szukaj-leada.
      const leadIdNum = Number(req.query.lead_id);
      const leadId = Number.isFinite(leadIdNum) ? String(leadIdNum) : null;
      if (!digits && !email && !leadId) {
        return res.status(400).json({ error: 'Podaj telefon, email lub lead_id' });
      }

      // Twarde identyfikatory → kom_customer_identities (telefon w formacie
      // komunikatora: 9 cyfr dostaje prefiks 48). Dwa osobne zapytania zamiast
      // .or() — e-mail z przecinkiem/nawiasem rozsypałby składnię filtra.
      const komPhone = digits ? identity.normalize('phone', digits) : '';
      const lookups = [];
      if (komPhone) {
        lookups.push(db.from('kom_customer_identities').select('customer_id').eq('type', 'phone').eq('value', komPhone));
      }
      if (email) {
        lookups.push(db.from('kom_customer_identities').select('customer_id').eq('type', 'email').eq('value', email));
      }
      const results = await Promise.all(lookups);
      for (const r of results) if (r.error) throw r.error;
      const ids = new Set();
      results.forEach((r) => (r.data || []).forEach((row) => ids.add(row.customer_id)));

      // Klienci już powiązani z leadem (poprzednie wizyty zapisały most).
      if (leadId) {
        const { data: linked, error: linkedErr } = await db
          .from('kom_customers')
          .select('id')
          .eq('crm_lead_id', leadId)
          .is('merged_into', null);
        if (linkedErr) throw linkedErr;
        (linked || []).forEach((r) => ids.add(r.id));
      }

      // Tożsamości mogą wskazywać rekordy scalone — podążamy za merged_into
      // do żywych klientów i deduplikujemy.
      const customers = [];
      const seen = new Set();
      for (const id of ids) {
        const c = await identity.loadCustomer(db, id);
        if (c && !seen.has(c.id)) {
          seen.add(c.id);
          customers.push(c);
        }
      }

      // Most do CRM: dopiero co dopasowany klient bez powiązania dostaje
      // ID Leada. Błąd zapisu nie psuje odczytu (oś czasu i tak wraca).
      if (leadId) {
        for (const c of customers) {
          if (c.crm_lead_id) continue;
          const { error: updErr } = await db.from('kom_customers').update({ crm_lead_id: leadId }).eq('id', c.id);
          if (updErr) console.warn('kontakt: zapis crm_lead_id nie powiódł się:', updErr.message);
          else c.crm_lead_id = leadId;
        }
      }

      if (!customers.length) return res.json({ customers: [], messages: [] });

      const { data: threads, error: thErr } = await db
        .from('kom_threads')
        .select('id, channel')
        .in('customer_id', customers.map((c) => c.id));
      if (thErr) throw thErr;
      const threadChannel = new Map((threads || []).map((t) => [t.id, t.channel]));

      let messages = [];
      if (threadChannel.size) {
        const { data: msgs, error: msgErr } = await db
          .from('kom_messages')
          .select('id, thread_id, direction, body, sent_by, created_at, meta')
          .in('thread_id', [...threadChannel.keys()])
          .order('created_at', { ascending: false })
          .limit(300);
        if (msgErr) throw msgErr;
        messages = (msgs || []).map((m) => ({
          id: m.id,
          channel: threadChannel.get(m.thread_id) || 'note',
          direction: m.direction,
          body: m.body || '',
          sent_by: m.sent_by || null,
          created_at: m.created_at,
          // meta.kind: 'comment' = publiczny komentarz FB/IG/TikTok (nie DM).
          kind: (m.meta && m.meta.kind) || null,
        }));
      }

      res.json({
        customers: customers.map((c) => ({
          public_id: c.public_id,
          display_name: c.display_name || null,
          // Deep-link jak z hubu — komunikator otwiera klienta po public_id.
          url: `/wiadomosci/?klient=${encodeURIComponent(c.public_id)}`,
        })),
        messages,
      });
    } catch (err) {
      handleError(res, err, 502);
    }
  });
}

module.exports = { registerKontaktEndpoints };
