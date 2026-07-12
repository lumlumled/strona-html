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

// Jedno zdanie alertu dla LEADA (termin z Data Feedbacku minął, cisza).
async function alertTextLead(lead, watch, now) {
  const kto = String(lead.Name || '').trim() || 'lead bez nazwy';
  const dniPoTerminie = Math.max(0, Math.floor((now - new Date(watch.due_at).getTime()) / 86400000));
  const fallback = `Lead ${kto}: termin kontaktu minął ${dniPoTerminie ? `${dniPoTerminie} dni temu` : 'dziś'}, brak nowej rozmowy - warto zadzwonić.`;
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
          { role: 'system', content: 'Jesteś asystentem CRM. Napisz JEDNO krótkie zdanie po polsku dla handlowca: umówiony termin kontaktu z leadem minął i nie było żadnej rozmowy - warto zadzwonić. Podaj imię i ile dni po terminie. Bez wykrzykników, bez emoji, bez półpauzy "—" (używaj "-"). Zwróć JSON {"alert": "..."}.' },
          { role: 'user', content: `Lead: ${kto}, status: ${lead['Deal stage'] || 'brak'}, termin kontaktu minął ${dniPoTerminie ? `${dniPoTerminie} dni temu` : 'dzisiaj'}.` },
        ],
      }),
    });
    if (!aiRes.ok) return fallback;
    const body = await aiRes.json();
    const parsed = JSON.parse(body.choices?.[0]?.message?.content || '');
    return String(parsed.alert || '').trim() || fallback;
  } catch (err) {
    console.warn(`Watchdog: alert AI leada ${lead['ID Leada']} nie powiódł się:`, err.message);
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

  // Leady pokryte otwartą wyceną — ich watche (mirror) nie alertują osobno.
  const coveredLeadIds = new Set(wyceny.filter((w) => w.lead_id).map((w) => String(w.lead_id)));

  // 3. Przeterminowane watche: aktywność vs alert.
  const now = Date.now();
  const overdue = watches.filter((w) => wycenaById.has(w.object_id) && new Date(w.due_at).getTime() <= now);
  if (!overdue.length) {
    await sweepLeady(supabase, raport, { notifyOwner, coveredLeadIds });
    return raport;
  }

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
    // na ślepo; przerywamy przebieg alertów wycen, uzbrajanie już się odbyło.
    raport.errors.push(`activity-context: ${err.message}`);
    await sweepLeady(supabase, raport, { notifyOwner, coveredLeadIds });
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
  await sweepLeady(supabase, raport, { notifyOwner, coveredLeadIds });
  await sweepObietnice(supabase, raport, { notifyOwner });
  return raport;
}

// ── Wiadomości: unia z kom_commitments (docs/plan-watchdog-feedback.md §4) ──
// Ekstrakcję i auto-zamykanie robi worker komunikatora (commitments.js);
// tu tylko alertujemy przeterminowane otwarte obietnice. Owner wiadomości =
// dziś Antoni (wątki nieprzypisane per user).
async function sweepObietnice(supabase, raport, { notifyOwner }) {
  try {
    const { data, error } = await supabase.from('kom_commitments')
      .select('id,description,owner,due_at,created_at,alerted_at,kom_customers(display_name,public_id)')
      .eq('status', 'open')
      .lte('due_at', new Date().toISOString())
      .is('alerted_at', null)
      .order('due_at', { ascending: true })
      .limit(ALERT_LIMIT_PER_RUN);
    if (error) throw error;
    for (const c of data || []) {
      const kto = c.kom_customers?.display_name || c.kom_customers?.public_id || 'klient';
      const dni = Math.max(0, Math.floor((Date.now() - new Date(c.due_at).getTime()) / 86400000));
      const kierunek = c.owner === 'klient' ? `${kto} miał(a) się odezwać` : `obiecaliśmy ${kto}`;
      const text = `Obietnica: "${c.description}" - ${kierunek}, termin minął ${dni ? `${dni} dni temu` : 'dziś'}.`;
      const { error: upErr } = await supabase.from('kom_commitments')
        .update({ alert_text: text, alerted_at: new Date().toISOString() })
        .eq('id', c.id).eq('status', 'open');
      if (upErr) { raport.errors.push(`obietnica ${c.id}: ${upErr.message}`); continue; }
      raport.alerted += 1;
      if (notifyOwner) {
        await notifyOwner({ owner: 'Antoni', title: 'Watchdog: obietnica bez odzewu', body: text, url: '/wiadomosci', tag: `watchdog-kom-${c.id}` })
          .catch((err) => raport.errors.push(`push obietnica ${c.id}: ${err.message}`));
      }
    }
  } catch (err) {
    raport.errors.push(`obietnice: ${err.message}`);
  }
}

// ── Leady: watche z mirrora "Data Feedbacku" (trigger, migracja 004) ────────
// Alertujemy TYLKO przeterminowane bez aktywności w "Log zmian" od baseline.
// Lead pokryty otwartą wyceną (wycena.lead_id) NIE alertuje — watch wyceny
// pilnuje tego samego kontaktu i alertuje konkretniej (bez dubli po
// propagacji terminu wycena->lead).
async function sweepLeady(supabase, raport, { notifyOwner, coveredLeadIds }) {
  const now = Date.now();
  const { data: watches, error } = await supabase.from(watchdog.FEEDBACK_WATCH_TABLE)
    .select('*').eq('object_type', 'lead').is('resolved_at', null);
  if (error) { raport.errors.push(`leady-watches: ${error.message}`); return; }
  const overdue = (watches || []).filter((w) => new Date(w.due_at).getTime() <= now);
  if (!overdue.length) return;

  const leadIds = [...new Set(overdue.map((w) => Number(w.object_id)).filter(Number.isFinite))];
  const { data: leady, error: lErr } = await supabase.from('Leady B2C')
    .select('"ID Leada",Name,"Phone number","Deal stage",Owner').in('ID Leada', leadIds);
  if (lErr) { raport.errors.push(`leady-fetch: ${lErr.message}`); return; }
  const leadById = new Map((leady || []).map((l) => [String(l['ID Leada']), l]));

  const phoneOf = (l) => String(l?.['Phone number'] ?? '').replace(/\D/g, '').replace(/^48/, '');
  const minBaseline = overdue.reduce((min, w) => Math.min(min, new Date(w.baseline_at).getTime()), Infinity);
  const logByPhone = new Map();
  const phones = [...new Set(overdue.map((w) => phoneOf(leadById.get(w.object_id))).filter(Boolean))];
  if (phones.length) {
    const { data: logs, error: logErr } = await supabase.from('Log zmian')
      .select('telefon,data_zmiany').in('telefon', phones)
      .gte('data_zmiany', new Date(minBaseline).toISOString());
    if (logErr) { raport.errors.push(`leady-log: ${logErr.message}`); return; }
    (logs || []).forEach((r) => {
      const key = String(r.telefon);
      const arr = logByPhone.get(key) || [];
      arr.push(new Date(r.data_zmiany).getTime());
      logByPhone.set(key, arr);
    });
  }

  let alertsLeft = ALERT_LIMIT_PER_RUN;
  for (const watch of overdue) {
    const lead = leadById.get(watch.object_id);
    try {
      if (!lead || ['Sprzedane', 'Stracony'].includes(String(lead['Deal stage'] || ''))) {
        await watchdog.resolveWatch(supabase, { objectType: 'lead', objectId: watch.object_id, resolution: 'done' });
        raport.resolved_closed += 1;
        continue;
      }
      const baseline = new Date(watch.baseline_at).getTime();
      const logs = logByPhone.get(phoneOf(lead)) || [];
      if (logs.some((t) => t > baseline)) {
        await watchdog.resolveWatch(supabase, { objectType: 'lead', objectId: watch.object_id, resolution: 'activity' });
        raport.resolved_activity += 1;
        continue;
      }
      if (coveredLeadIds.has(watch.object_id)) continue; // pilnuje watch wyceny
      if (watch.alerted_at || alertsLeft <= 0) continue;
      const text = await alertTextLead(lead, watch, now);
      const { error: upErr } = await supabase.from(watchdog.FEEDBACK_WATCH_TABLE)
        .update({ alert_text: text, alerted_at: new Date().toISOString() })
        .eq('id', watch.id).is('resolved_at', null);
      if (upErr) throw upErr;
      alertsLeft -= 1;
      raport.alerted += 1;
      const ownerName = watch.owner || String(lead.Owner || '').trim();
      if (notifyOwner) {
        await notifyOwner({ owner: ownerName, title: 'Watchdog: temat ucieka', body: text, url: '/crm', tag: `watchdog-${watch.id}` })
          .catch((err) => raport.errors.push(`push lead ${watch.id}: ${err.message}`));
      }
    } catch (err) {
      raport.errors.push(`alert lead ${watch.object_id}: ${err.message}`);
    }
  }
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
      const leadIds = (alerty || []).filter((a) => a.object_type === 'lead').map((a) => Number(a.object_id)).filter(Number.isFinite);
      const objById = new Map();
      if (wycenaIds.length) {
        const { data: wyceny } = await supabase.from('wyceny')
          .select('id,imie_nazwisko,kwota_proponowana_brutto,status,typ').in('id', wycenaIds);
        (wyceny || []).forEach((w) => objById.set(`wycena:${w.id}`, w));
      }
      if (leadIds.length) {
        const { data: leady } = await supabase.from('Leady B2C')
          .select('"ID Leada",Name,"Phone number","Deal stage"').in('ID Leada', leadIds);
        (leady || []).forEach((l) => objById.set(`lead:${l['ID Leada']}`, {
          id: l['ID Leada'],
          imie_nazwisko: l.Name || '',
          telefon: l['Phone number'] != null ? String(l['Phone number']) : '',
          status: l['Deal stage'] || '',
        }));
      }
      // Obietnice z wiadomości (kom_commitments) — owner dziś zawsze Antoni,
      // więc nie-adminowi bez tego imienia ich nie pokazujemy. Miękka
      // degradacja: błąd kom_* nie może położyć listy alertów.
      let obietnice = [];
      const userName = String(req.user?.name || '').trim().toLowerCase();
      if ((isAdmin && isAdmin(req.user)) || userName === 'antoni') {
        try {
          const { data: kom } = await supabase.from('kom_commitments')
            .select('id,description,owner,due_at,alert_text,alerted_at,kom_customers(display_name,public_id)')
            .eq('status', 'open').not('alerted_at', 'is', null)
            .order('due_at', { ascending: true });
          obietnice = (kom || []).map((c) => ({
            id: c.id,
            object_type: 'wiadomosc',
            object_id: c.id,
            owner: 'Antoni',
            due_at: c.due_at,
            alert_text: c.alert_text,
            alerted_at: c.alerted_at,
            visible: true,
            _obiekt: { imie_nazwisko: c.kom_customers?.display_name || c.kom_customers?.public_id || '' },
          }));
        } catch (err) {
          console.error('Watchdog alerty (obietnice):', err.message);
        }
      }
      res.json({
        data: [
          ...(alerty || []).map((a) => ({
            ...a,
            _obiekt: objById.get(`${a.object_type}:${a.object_id}`) || null,
          })),
          ...obietnice,
        ],
      });
    } catch (err) {
      console.error('Watchdog alerty:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // POST /api/watchdog/obietnice/:id/zamknij — ręczne "zrobione" obietnicy.
  app.post('/api/watchdog/obietnice/:id/zamknij', async (req, res) => {
    try {
      const { data, error } = await getClient().from('kom_commitments')
        .update({ status: 'done', resolved_at: new Date().toISOString() })
        .eq('id', String(req.params.id)).eq('status', 'open').select('id');
      if (error) throw error;
      if (!data || !data.length) return res.status(404).json({ error: 'Nie znaleziono obietnicy' });
      res.json({ ok: true });
    } catch (err) {
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
