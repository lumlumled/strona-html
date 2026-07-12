// ── Watchdog "temat ucieka" — dispatcher (docs/plan-watchdog-feedback.md §7) ──
// Jeden przebieg (pg_cron -> /api/cron/watchdog, co 30 min 8-20 Warsaw):
//   1. gasi watche wycen, które przestały być otwarte (sprzedane/stracone),
//   2. uzbraja wyceny bez watcha (armWycena: jawna przesłanka albo cichy
//      termin z oceny temperatury) — pokrywa też backfill i re-ewaluację,
//   3. dla przeterminowanych watchy sprawdza aktywność od baseline_at:
//      była -> resolve 'activity' (następny przebieg uzbroi od nowa),
//      cisza -> generuje alert (AI, fallback deterministyczny) + push do ownera.
// Limity AI per przebieg trzymają koszt w ryzach; reszta dojedzie w kolejnych
// przebiegach (co 30 min), co przy horyzoncie dni nie ma znaczenia.

const watchdog = require('./watchdog');

const ARM_LIMIT_PER_RUN = 25;
const ALERT_LIMIT_PER_RUN = 15;

function digitsOf(w) {
  return String(w.telefon_digits || String(w.telefon_e164 || '').replace(/\D/g, '').replace(/^48/, '')).trim();
}

// Jedno zdanie alertu po polsku. AI dla naturalności, deterministyczny
// fallback gdy AI niedostępne/wywali się. Jawny termin (visible) opowiada
// o minionym terminie kontaktu; cichy — o dniach ciszy od ustawienia.
async function alertText(wycena, watch, now) {
  const kto = String(wycena.imie_nazwisko || '').trim()
    || (digitsOf(wycena) ? `+48${digitsOf(wycena)}` : 'klient bez nazwy');
  const dniCiszy = Math.max(1, Math.round((now - new Date(watch.baseline_at).getTime()) / 86400000));
  const dniPoTerminie = Math.max(0, Math.floor((now - new Date(watch.due_at).getTime()) / 86400000));
  const fallback = watch.visible
    ? `Wycena #${wycena.id} (${kto}): termin kontaktu minął ${dniPoTerminie ? `${dniPoTerminie} dni temu` : 'dziś'} - warto się odezwać.`
    : `Wycena #${wycena.id} (${kto}): ${dniCiszy} dni ciszy - warto się odezwać.`;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) return fallback;
  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: process.env.WATCHDOG_MODEL || 'gpt-5-mini',
        response_format: { type: 'json_object' },
        reasoning_effort: 'minimal',
        messages: [
          {
            role: 'system',
            content: 'Jesteś asystentem CRM. Napisz JEDNO krótkie zdanie po polsku dla handlowca: przypomnienie, że temat z klientem wisi i warto się odezwać. Konkretnie: numer wyceny, jak nazwać klienta (imię, a bez imienia telefon), sedno (miniony umówiony termin ALBO dni ciszy), kwota jeśli znacząca. Bez wykrzykników, bez emoji, bez półpauzy "—" (używaj "-"). Zwróć JSON {"alert": "..."}.',
          },
          {
            role: 'user',
            content: [
              `Wycena #${wycena.id}, klient: ${kto}, kwota: ${wycena.kwota_proponowana_brutto ?? 'brak'} zł, etap: ${wycena.process_stage || 'NEW'}.`,
              watch.visible
                ? `Umówiony termin kontaktu minął ${dniPoTerminie ? `${dniPoTerminie} dni temu` : 'dzisiaj'}. Skąd termin: ${watch.reason || 'ustawiony ręcznie'}.`
                : `Cisza od ${dniCiszy} dni (termin ustawiony automatycznie: ${watch.reason || 'ocena AI'}).`,
            ].join('\n'),
          },
        ],
      }),
    });
    if (!aiRes.ok) return fallback;
    const body = await aiRes.json();
    const parsed = JSON.parse(body.choices?.[0]?.message?.content || '');
    return String(parsed.alert || '').trim() || fallback;
  } catch (err) {
    console.warn(`Watchdog: alert AI wyceny ${wycena.id} nie powiódł się:`, err.message);
    return fallback;
  }
}

// Aktywność na wycenie od baseline: event pipeline'u, edycja wiersza albo —
// gdy podpięty lead — wpis w "Log zmian" (rozmowa/notatka/edycja leada).
function buildActivityChecker({ eventsByWycena, logByPhone, leadPhoneByLeadId }) {
  return (watch, wycena) => {
    const baseline = new Date(watch.baseline_at).getTime();
    if (wycena.updated_at && new Date(wycena.updated_at).getTime() > baseline) return true;
    const events = eventsByWycena.get(Number(wycena.id)) || [];
    if (events.some((t) => t > baseline)) return true;
    const phone = wycena.lead_id ? leadPhoneByLeadId.get(String(wycena.lead_id)) : digitsOf(wycena);
    if (phone) {
      const logs = logByPhone.get(phone) || [];
      if (logs.some((t) => t > baseline)) return true;
    }
    return false;
  };
}

async function runWatchdogSweep(supabase, { notifyOwner } = {}) {
  const raport = { armed: 0, alerted: 0, resolved_activity: 0, resolved_closed: 0, errors: [] };

  // Otwarte wyceny + wszystkie otwarte watche wycen.
  const [wycenyRes, watchesRes] = await Promise.all([
    supabase.from('wyceny')
      .select('id,typ,status,owner,imie_nazwisko,kwota_proponowana_brutto,created_at,updated_at,process_stage,opis_zamowienia,komentarz,history_log,lead_id,telefon_digits,telefon_e164,email')
      .eq('typ', 'WYCENA').eq('status', 'Open'),
    supabase.from(watchdog.FEEDBACK_WATCH_TABLE)
      .select('*').eq('object_type', 'wycena').is('resolved_at', null),
  ]);
  if (wycenyRes.error) throw wycenyRes.error;
  if (watchesRes.error) throw watchesRes.error;
  const wyceny = wycenyRes.data || [];
  const watches = watchesRes.data || [];
  const wycenaById = new Map(wyceny.map((w) => [String(w.id), w]));

  // 1. Watch bez otwartej wyceny (sprzedana/stracona/skasowana) -> done.
  for (const watch of watches) {
    if (!wycenaById.has(watch.object_id)) {
      try {
        await watchdog.resolveWatch(supabase, { objectType: 'wycena', objectId: watch.object_id, resolution: 'done' });
        raport.resolved_closed += 1;
      } catch (err) { raport.errors.push(`resolve-closed ${watch.object_id}: ${err.message}`); }
    }
  }

  // 2. Uzbrajanie wycen bez watcha (limit per przebieg).
  const watchedIds = new Set(watches.map((w) => w.object_id));
  const doUzbrojenia = wyceny.filter((w) => !watchedIds.has(String(w.id))).slice(0, ARM_LIMIT_PER_RUN);
  for (const w of doUzbrojenia) {
    try {
      const armed = await watchdog.armWycena(supabase, w);
      if (armed) raport.armed += 1;
    } catch (err) { raport.errors.push(`arm ${w.id}: ${err.message}`); }
  }

  // 3. Przeterminowane watche: aktywność vs alert.
  const now = Date.now();
  const overdue = watches.filter((w) => wycenaById.has(w.object_id) && new Date(w.due_at).getTime() <= now);
  if (!overdue.length) return raport;

  // Kontekst aktywności jednym rzutem: eventy wycen, telefony leadów, Log zmian.
  const overdueIds = overdue.map((w) => Number(w.object_id));
  const minBaseline = overdue.reduce((min, w) => Math.min(min, new Date(w.baseline_at).getTime()), Infinity);
  const leadIds = [...new Set(overdue.map((w) => wycenaById.get(w.object_id)?.lead_id).filter(Boolean).map(String))];

  const eventsByWycena = new Map();
  const logByPhone = new Map();
  const leadPhoneByLeadId = new Map();
  try {
    const { data: events } = await supabase.from('wyceny_events')
      .select('wycena_id,created_at').in('wycena_id', overdueIds)
      .gte('created_at', new Date(minBaseline).toISOString());
    (events || []).forEach((e) => {
      const arr = eventsByWycena.get(e.wycena_id) || [];
      arr.push(new Date(e.created_at).getTime());
      eventsByWycena.set(e.wycena_id, arr);
    });
    if (leadIds.length) {
      const { data: leady } = await supabase.from('Leady B2C')
        .select('"ID Leada","Phone number"').in('ID Leada', leadIds);
      (leady || []).forEach((l) => {
        const digits = String(l['Phone number'] ?? '').replace(/\D/g, '').replace(/^48/, '');
        if (digits) leadPhoneByLeadId.set(String(l['ID Leada']), digits);
      });
    }
    const phones = [...new Set([
      ...leadPhoneByLeadId.values(),
      ...overdue.map((w) => digitsOf(wycenaById.get(w.object_id) || {})).filter(Boolean),
    ])];
    if (phones.length) {
      const { data: logs } = await supabase.from('Log zmian')
        .select('telefon,data_zmiany').in('telefon', phones)
        .gte('data_zmiany', new Date(minBaseline).toISOString());
      (logs || []).forEach((r) => {
        const key = String(r.telefon);
        const arr = logByPhone.get(key) || [];
        arr.push(new Date(r.data_zmiany).getTime());
        logByPhone.set(key, arr);
      });
    }
  } catch (err) {
    // Kontekst aktywności to optymalizacja — bez niego lepiej NIE alertować
    // na ślepo; przerywamy przebieg alertów, uzbrajanie już się odbyło.
    raport.errors.push(`activity-context: ${err.message}`);
    return raport;
  }

  const hasActivity = buildActivityChecker({ eventsByWycena, logByPhone, leadPhoneByLeadId });
  let alertsLeft = ALERT_LIMIT_PER_RUN;
  for (const watch of overdue) {
    const wycena = wycenaById.get(watch.object_id);
    try {
      if (hasActivity(watch, wycena)) {
        await watchdog.resolveWatch(supabase, { objectType: 'wycena', objectId: watch.object_id, resolution: 'activity' });
        raport.resolved_activity += 1;
        continue;
      }
      if (watch.alerted_at || alertsLeft <= 0) continue; // już alertowane / limit
      const text = await alertText(wycena, watch, now);
      const { error } = await supabase.from(watchdog.FEEDBACK_WATCH_TABLE)
        .update({ alert_text: text, alerted_at: new Date().toISOString() })
        .eq('id', watch.id).is('resolved_at', null);
      if (error) throw error;
      alertsLeft -= 1;
      raport.alerted += 1;
      if (notifyOwner) {
        await notifyOwner({ owner: watch.owner, title: 'Watchdog: temat ucieka', body: text, url: '/wyceny', tag: `watchdog-${watch.id}` })
          .catch((err) => raport.errors.push(`push ${watch.id}: ${err.message}`));
      }
    } catch (err) {
      raport.errors.push(`alert ${watch.object_id}: ${err.message}`);
    }
  }
  return raport;
}

// GET /api/watchdog/alerty — otwarte, zaalertowane watche dla hubu/Backlogu.
// Nie-admin widzi swoje (owner = imię z sesji); admin wszystkie. Wiersze
// wzbogacone o dane wyceny (nazwa, kwota) do renderu bez drugiego zapytania.
function registerWatchdogEndpoints(app, { getClient, isAdmin }) {
  app.get('/api/watchdog/alerty', async (req, res) => {
    try {
      const supabase = getClient();
      let q = supabase.from(watchdog.FEEDBACK_WATCH_TABLE)
        .select('*').is('resolved_at', null).not('alerted_at', 'is', null)
        .order('due_at', { ascending: true });
      if (!(isAdmin && isAdmin(req.user))) {
        const name = String(req.user?.name || '').trim();
        q = name ? q.ilike('owner', name) : q.limit(0);
      }
      const { data: alerty, error } = await q;
      if (error) throw error;
      const wycenaIds = (alerty || []).filter((a) => a.object_type === 'wycena').map((a) => Number(a.object_id));
      const objById = new Map();
      if (wycenaIds.length) {
        const { data: wyceny } = await supabase.from('wyceny')
          .select('id,imie_nazwisko,kwota_proponowana_brutto,status,typ').in('id', wycenaIds);
        (wyceny || []).forEach((w) => objById.set(`wycena:${w.id}`, w));
      }
      res.json({
        data: (alerty || []).map((a) => ({
          ...a,
          _obiekt: objById.get(`${a.object_type}:${a.object_id}`) || null,
        })),
      });
    } catch (err) {
      console.error('Watchdog alerty:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // POST /api/watchdog/alerty/:id/zamknij — ręczne "zrobione" z panelu.
  app.post('/api/watchdog/alerty/:id(\\d+)/zamknij', async (req, res) => {
    try {
      const supabase = getClient();
      let q = supabase.from(watchdog.FEEDBACK_WATCH_TABLE)
        .update({ resolved_at: new Date().toISOString(), resolution: 'done' })
        .eq('id', Number(req.params.id)).is('resolved_at', null);
      if (!(isAdmin && isAdmin(req.user))) {
        const name = String(req.user?.name || '').trim();
        if (!name) return res.status(403).json({ error: 'Brak uprawnień' });
        q = q.ilike('owner', name);
      }
      const { data, error } = await q.select('id');
      if (error) throw error;
      if (!data || !data.length) return res.status(404).json({ error: 'Nie znaleziono alertu' });
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
}

module.exports = { runWatchdogSweep, registerWatchdogEndpoints };
