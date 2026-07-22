// ── Panel Feedbacki — kalendarz terminów kontaktu (apps/feedbacki) ───────────
// Widok kalendarza nad tą samą tabelą co watchdog: feedback_watch. RÓŻNICA
// wobec GET /api/watchdog/alerty: tam tylko wiersze JUŻ zaalertowane
// (alerted_at IS NOT NULL, czyli przeterminowane bez aktywności) — kalendarz
// potrzebuje WSZYSTKICH otwartych terminów, także przyszłych, żeby rozłożyć je
// na dni miesiąca/tygodnia.
//
// Zakres (decyzja Antoniego 2026-07-22): domyślnie tylko USTALONE terminy
// (visible=true — jawna data od człowieka lub AI) + obietnice z komunikatora
// (kom_commitments). Ciche watche AI z oceny temperatury (visible=false) są
// szumem na kalendarzu i wchodzą dopiero pod przełącznikiem ?ai=1.
//
// Każdy wiersz wzbogacony o pięć pól karty (imię i nazwisko, telefon, kwota,
// ID) + telefon w cyfrach do otwarcia pełnej karty leada w szufladzie
// (GET /api/leady/pelny?telefon=). Zamykanie „zrobione" idzie przez istniejące
// endpointy watchdoga (registerWatchdogEndpoints: /api/watchdog/alerty/:id/
// zamknij dla watchy, /api/watchdog/obietnice/:id/zamknij dla obietnic).

const watchdog = require('./watchdog');

function digitsNoPrefix(v) {
  return String(v ?? '').replace(/\D/g, '').replace(/^48/, '');
}

// GET /api/feedbacki/kalendarz?ai=0|1
// Zwraca { data: [ { id, object_type, object_id, owner, due_at, visible,
//   set_by, source, reason, alert_text, alerted_at, resolved_at:null,
//   _obiekt: { imie_nazwisko, telefon, telefon_digits, kwota, id, status, public_id } } ] }
// Nie-admin widzi swoje (owner = imię z sesji); admin wszystkie. Obietnice
// (kom_commitments) mają dziś zawsze ownera „Antoni" (wątki nieprzypisane).
function registerFeedbackiEndpoints(app, { getClient, isAdmin }) {
  app.get('/api/feedbacki/kalendarz', async (req, res) => {
    try {
      const supabase = getClient();
      const admin = Boolean(isAdmin && isAdmin(req.user));
      const userName = String(req.user?.name || '').trim();
      const includeSilent = String(req.query.ai || '') === '1';

      // ── Otwarte watche (wyceny + leady) ───────────────────────────────────
      let q = supabase.from(watchdog.FEEDBACK_WATCH_TABLE)
        .select('*').is('resolved_at', null)
        .order('due_at', { ascending: true });
      if (!includeSilent) q = q.eq('visible', true);
      if (!admin) q = userName ? q.ilike('owner', userName) : q.limit(0);
      const { data: watches, error } = await q;
      if (error) throw error;
      const rows = watches || [];

      // ── Wzbogacenie jednym rzutem: wyceny i leady po object_id ─────────────
      const wycenaIds = rows.filter((w) => w.object_type === 'wycena')
        .map((w) => Number(w.object_id)).filter(Number.isFinite);
      const leadIds = rows.filter((w) => w.object_type === 'lead')
        .map((w) => Number(w.object_id)).filter(Number.isFinite);
      const objById = new Map();

      if (wycenaIds.length) {
        const { data: wyceny } = await supabase.from('wyceny')
          .select('id,imie_nazwisko,first_name,last_name,kwota_proponowana_brutto,kwota_sprzedazy_brutto,telefon_e164,telefon_digits,status')
          .in('id', wycenaIds);
        (wyceny || []).forEach((w) => {
          const imie = [w.first_name, w.last_name].filter(Boolean).join(' ').trim()
            || String(w.imie_nazwisko || '').trim();
          const digits = digitsNoPrefix(w.telefon_digits || w.telefon_e164);
          objById.set(`wycena:${w.id}`, {
            imie_nazwisko: imie,
            telefon: w.telefon_e164 || (digits ? `+48${digits}` : ''),
            telefon_digits: digits,
            kwota: w.kwota_sprzedazy_brutto ?? w.kwota_proponowana_brutto ?? null,
            id: w.id,
            status: w.status || '',
          });
        });
      }

      if (leadIds.length) {
        const { data: leady } = await supabase.from('Leady B2C')
          .select('"ID Leada",Name,"Phone number","Deal stage","Kwota wyceny"')
          .in('ID Leada', leadIds);
        (leady || []).forEach((l) => {
          const digits = digitsNoPrefix(l['Phone number']);
          objById.set(`lead:${l['ID Leada']}`, {
            imie_nazwisko: String(l.Name || '').trim(),
            telefon: digits ? `+48${digits}` : '',
            telefon_digits: digits,
            kwota: l['Kwota wyceny'] ?? null,
            id: l['ID Leada'],
            status: l['Deal stage'] || '',
          });
        });
      }

      // ── Obietnice z komunikatora (kom_commitments) ────────────────────────
      // Owner dziś zawsze Antoni — nie-adminowi bez tego imienia ich nie
      // pokazujemy. Miękka degradacja: błąd kom_* nie kładzie kalendarza.
      let obietnice = [];
      if (admin || userName.toLowerCase() === 'antoni') {
        try {
          const { data: kom } = await supabase.from('kom_commitments')
            .select('id,description,owner,due_at,alert_text,alerted_at,created_by,kom_customers(display_name,public_id)')
            .eq('status', 'open')
            .order('due_at', { ascending: true });
          obietnice = (kom || []).map((c) => ({
            id: c.id,
            object_type: 'wiadomosc',
            object_id: c.id,
            owner: 'Antoni',
            due_at: c.due_at,
            visible: true,
            set_by: c.created_by === 'ai' ? 'ai' : 'human',
            source: 'kom_commitment',
            reason: c.description || '',
            alert_text: c.alert_text || null,
            alerted_at: c.alerted_at || null,
            resolved_at: null,
            _obiekt: {
              imie_nazwisko: c.kom_customers?.display_name || c.kom_customers?.public_id || '',
              telefon: '',
              telefon_digits: '',
              kwota: null,
              id: c.kom_customers?.public_id || '',
              status: '',
              public_id: c.kom_customers?.public_id || '',
            },
          }));
        } catch (err) {
          console.error('Feedbacki kalendarz (obietnice):', err.message);
        }
      }

      res.json({
        data: [
          ...rows.map((w) => ({
            id: w.id,
            object_type: w.object_type,
            object_id: w.object_id,
            owner: w.owner,
            due_at: w.due_at,
            visible: w.visible,
            set_by: w.set_by,
            source: w.source,
            reason: w.reason,
            alert_text: w.alert_text,
            alerted_at: w.alerted_at,
            resolved_at: null,
            _obiekt: objById.get(`${w.object_type}:${w.object_id}`) || null,
          })),
          ...obietnice,
        ],
      });
    } catch (err) {
      console.error('Feedbacki kalendarz:', err.message);
      res.status(502).json({ error: err.message });
    }
  });
}

module.exports = { registerFeedbackiEndpoints };
