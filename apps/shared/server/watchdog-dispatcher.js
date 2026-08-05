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
// Reuse 1:1 z reguły 5 panelu Test (obietnica dotrzymana = telefon z numerem
// w DNIU terminu): ten sam klucz numeru i ta sama doba warszawska.
const { last9, warsaw } = require('./test-panel-metrics');

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

// Jedno zdanie alertu dla LEADA. Jawny watch (mirror "Data Feedbacku") mówi
// o minionym UMÓWIONYM terminie; cichy watch AI (temperatura z rozmowy) — o
// dniach ciszy od ostatniej rozmowy.
async function alertTextLead(lead, watch, now) {
  const kto = String(lead.Name || '').trim() || 'lead bez nazwy';
  const dniPoTerminie = Math.max(0, Math.floor((now - new Date(watch.due_at).getTime()) / 86400000));
  const dniCiszy = Math.max(1, Math.round((now - new Date(watch.baseline_at).getTime()) / 86400000));
  const fallback = watch.visible
    ? `Lead ${kto}: termin kontaktu minął ${dniPoTerminie ? `${dniPoTerminie} dni temu` : 'dziś'}, brak nowej rozmowy - warto zadzwonić.`
    : `Lead ${kto}: ${dniCiszy} dni ciszy od rozmowy, brak nowego kontaktu - warto wrócić do tematu.`;
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
          { role: 'system', content: 'Jesteś asystentem CRM. Napisz JEDNO krótkie zdanie po polsku dla handlowca: temat z leadem wisi i warto się odezwać. Podaj imię i sedno (miniony umówiony termin ALBO dni ciszy od rozmowy). Bez wykrzykników, bez emoji, bez półpauzy "—" (używaj "-"). Zwróć JSON {"alert": "..."}.' },
          { role: 'user', content: watch.visible
            ? `Lead: ${kto}, status: ${lead['Deal stage'] || 'brak'}. Umówiony termin kontaktu minął ${dniPoTerminie ? `${dniPoTerminie} dni temu` : 'dzisiaj'}, brak nowej rozmowy. Skąd termin: ${watch.reason || 'ustawiony ręcznie'}.`
            : `Lead: ${kto}, status: ${lead['Deal stage'] || 'brak'}. Cisza od ostatniej rozmowy: ${dniCiszy} dni, brak nowego kontaktu (termin ustawiony automatycznie: ${watch.reason || 'ocena AI z rozmowy'}).` },
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

// ── Auto-domknięcie: próba kontaktu w DNIU terminu (reguła 5 panelu Test) ────
// "Zadzwonię jutro o 9" wykonane w dniu terminu = obietnica dotrzymana, więc
// feedback odhacza się sam zamiast czekać na ręczne "Zrobione". Liczy się
// KAŻDE połączenie z tym numerem (oba kierunki, także nieodebrana próba —
// klient, który sam oddzwonił, też domyka temat). Guard na baseline_at:
// rozmowa, w której dopiero umówiono dzisiejszy termin, nie odhacza go od
// razu (wpis w Log zmian powstaje PRZED mirrorem terminu, więc jest starszy
// niż baseline watcha). Tylko jawne terminy (visible) — ciche watche AI
// domyka istniejąca ścieżka 'activity' po przeterminowaniu.
async function sweepDotrzymaneDzis(supabase, raport) {
  try {
    const todayYmd = warsaw(new Date()).ymd;
    const { data: watches, error } = await supabase.from(watchdog.FEEDBACK_WATCH_TABLE)
      .select('*').is('resolved_at', null).eq('visible', true);
    if (error) throw error;
    const dzisiejsze = (watches || []).filter((w) => warsaw(w.due_at).ymd === todayYmd);
    if (!dzisiejsze.length) return;

    // Telefony obiektów jednym rzutem: lead -> Leady B2C, wycena -> wyceny.
    const leadIds = [...new Set(dzisiejsze.filter((w) => w.object_type === 'lead')
      .map((w) => Number(w.object_id)).filter(Number.isFinite))];
    const wycenaIds = [...new Set(dzisiejsze.filter((w) => w.object_type === 'wycena')
      .map((w) => Number(w.object_id)).filter(Number.isFinite))];
    const phoneByKey = new Map();
    if (leadIds.length) {
      const { data: leady, error: lErr } = await supabase.from('Leady B2C')
        .select('"ID Leada","Phone number"').in('ID Leada', leadIds);
      if (lErr) throw lErr;
      (leady || []).forEach((l) => {
        phoneByKey.set(`lead:${watchdog.leadObjectId(l)}`, last9(l['Phone number']));
      });
    }
    if (wycenaIds.length) {
      const { data: wyceny, error: wErr } = await supabase.from('wyceny')
        .select('id,telefon_digits,telefon_e164').in('id', wycenaIds);
      if (wErr) throw wErr;
      (wyceny || []).forEach((w) => {
        phoneByKey.set(`wycena:${w.id}`, last9(w.telefon_digits || w.telefon_e164));
      });
    }

    // Dzisiejsze połączenia (Log zmian, kierunek != null): 36 h wstecz i filtr
    // po dobie warszawskiej — bez ręcznego liczenia północy przez DST.
    const { data: logs, error: logErr } = await supabase.from('Log zmian')
      .select('telefon,data_zmiany').not('kierunek', 'is', null)
      .gte('data_zmiany', new Date(Date.now() - 36 * 3600 * 1000).toISOString());
    if (logErr) throw logErr;
    const callsToday = new Map(); // last9 -> [timestamp ms]
    (logs || []).forEach((r) => {
      if (warsaw(r.data_zmiany).ymd !== todayYmd) return;
      const key = last9(r.telefon);
      if (!key) return;
      const arr = callsToday.get(key) || [];
      arr.push(new Date(r.data_zmiany).getTime());
      callsToday.set(key, arr);
    });
    if (!callsToday.size) return;

    for (const w of dzisiejsze) {
      const calls = callsToday.get(phoneByKey.get(`${w.object_type}:${w.object_id}`) || '') || [];
      const baseline = new Date(w.baseline_at || w.created_at || 0).getTime();
      if (!calls.some((t) => t > baseline)) continue;
      try {
        await watchdog.resolveWatch(supabase, { objectType: w.object_type, objectId: w.object_id, resolution: 'activity' });
        raport.resolved_obietnica += 1;
      } catch (err) {
        raport.errors.push(`obietnica-dzis ${w.object_type} ${w.object_id}: ${err.message}`);
      }
    }
  } catch (err) {
    raport.errors.push(`obietnice-dzis: ${err.message}`);
  }
}

async function runWatchdogSweep(supabase, { notifyOwner } = {}) {
  const raport = { armed: 0, alerted: 0, resolved_activity: 0, resolved_obietnica: 0, resolved_closed: 0, errors: [] };

  // Najpierw auto-domknięcia z dzisiejszych prób kontaktu — domknięty watch
  // nie może zaraz potem zaalertować "temat ucieka" w tym samym przebiegu.
  await sweepDotrzymaneDzis(supabase, raport);

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
// Uzbrajanie cichych watchy AI na leadach z transkrypcją rozmowy bez żadnej
// daty feedbacku (docs §4, etap e — przypadek "klient odezwie się sam / termin
// brak"). Ten sam mechanizm robi backfill istniejących I ciągłe uzbrajanie
// nowych leadów, którym przybędzie transkrypcja (sweep chodzi co 30 min, więc
// nie trzeba żadnego hooka w flow Zadarmy). Zapis wyłącznie do feedback_watch.
async function armLeady(supabase, raport, { coveredLeadIds }) {
  try {
    const { data: leady, error } = await supabase.from('Leady B2C')
      .select('"ID Leada",Name,Owner,"Deal stage","Treść rozmowy","Historia rozmów","Ilość telefonów","Ostatni kontakt","Data Feedbacku","Najbliższa akcja termin"')
      .not('Treść rozmowy', 'is', null);
    if (error) { raport.errors.push(`arm-leady-fetch: ${error.message}`); return; }
    // Wlot: transkrypcja niepusta, brak jawnego terminu (Data Feedbacku ani
    // Najbliższa akcja termin), status otwarty. Pokrycie otwartą wyceną i
    // istniejący watch odfiltrowujemy niżej (dedup z watchem wyceny).
    const kandydaci = (leady || []).filter((l) => String(l['Treść rozmowy'] || '').trim()
      && !String(l['Data Feedbacku'] || '').trim()
      && !String(l['Najbliższa akcja termin'] || '').trim()
      && !watchdog.LEAD_EXCLUDED_STAGES.has(String(l['Deal stage'] || '').trim()));
    if (!kandydaci.length) return;
    const idOf = new Map(kandydaci.map((l) => [l, watchdog.leadObjectId(l)]));
    const ids = [...idOf.values()].filter(Boolean);
    const open = await watchdog.getOpenWatches(supabase, 'lead', ids);
    const doUzbrojenia = kandydaci.filter((l) => {
      const id = idOf.get(l);
      return id && !open.has(id) && !coveredLeadIds.has(id);
    }).slice(0, ARM_LIMIT_PER_RUN);
    for (const l of doUzbrojenia) {
      try {
        const armed = await watchdog.armLead(supabase, l);
        if (armed) raport.armed += 1;
      } catch (err) { raport.errors.push(`arm-lead ${l['ID Leada']}: ${err.message}`); }
    }
  } catch (err) {
    raport.errors.push(`arm-leady: ${err.message}`);
  }
}

async function sweepLeady(supabase, raport, { notifyOwner, coveredLeadIds }) {
  await armLeady(supabase, raport, { coveredLeadIds });
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
      // Push tylko dla JAWNYCH watchy leadów (mirror Data Feedbacku). Ciche
      // watche AI (visible=false) na start idą wyłącznie do paneli (hub +
      // Backlog) — decyzja Antoniego 2026-07-12; push dołożymy po tygodniu.
      if (notifyOwner && watch.visible) {
        await notifyOwner({ owner: ownerName, title: 'Watchdog: temat ucieka', body: text, url: '/crm', tag: `watchdog-${watch.id}` })
          .catch((err) => raport.errors.push(`push lead ${watch.id}: ${err.message}`));
      }
    } catch (err) {
      raport.errors.push(`alert lead ${watch.object_id}: ${err.message}`);
    }
  }
}

// ── "Temat ucieka": co realnie kwalifikuje się do alarmu (decyzje Antoniego
// 2026-08-05) ────────────────────────────────────────────────────────────────
// Alarm = piłka po stronie klienta i temat stygnie, a da się zadziałać. NIE
// mieszamy tu naszych "do zrobienia" (obietnice owner='my' -> osobny worek),
// martwych bezimiennych importów wycen ani automatów e-mail (faktury, Zadarma).

// Świeżość wyceny bez leada/imienia: quick-add z samym numerem jest wart
// telefonu, dopóki świeży; stare bezimienne importy (legacy) wypadają.
const FRESH_QUOTE_DAYS = 60;

// Wycena kwalifikuje się do "cisza po wycenie", jeśli jest realna i wykonalna:
// ma leada albo imię (wtedy zawsze), albo ma telefon i jest świeża (można
// zadzwonić). Bezimienny import bez telefonu / stary -> odpada.
function wycenaKwalifikuje(w) {
  if (!w) return false;
  const maImie = String(w.imie_nazwisko || '').trim() !== '';
  const maLead = w.lead_id != null && String(w.lead_id).trim() !== '';
  const maTel = String(w.telefon_digits || '').trim() !== '' || String(w.telefon_e164 || '').trim() !== '';
  if (maLead || maImie) return true;
  if (maTel && w.created_at) {
    return Date.now() - new Date(w.created_at).getTime() <= FRESH_QUOTE_DAYS * 86400000;
  }
  return false;
}

// Automatyczni / płatnościowi nadawcy e-mail, których nie chcemy w alarmie
// (faktury, powiadomienia telefonii). Długi ogon dobija przycisk "wyklucz
// maila" (trwała lista, faza 2).
const SENDER_DENYLIST = ['zadarma', 'base.com', 'noreply', 'no-reply', 'notifications', 'powiadomien'];
function nadawcaZablokowany(name, publicId) {
  const s = `${name || ''} ${publicId || ''}`.toLowerCase();
  return SENDER_DENYLIST.some((k) => s.includes(k));
}

// Routing obietnicy do HANDLOWCA (nie mylić z owner='my'/'klient' = strona
// zobowiązania). Sygnały per handlowiec w komunikatorze: SMS po numerze
// (meta.sms_user); social (Msg/WA/IG/TikTok) nie ma przypisania -> Antoni
// (kanały admin-only); e-mail -> skrzynka (na razie Antoni, TODO kom_mailboxes).
function handlowiecObietnicy(channel, threadMeta) {
  if (channel === 'sms') return threadMeta?.sms_user || 'Lorenzo';
  return 'Antoni';
}

// GET /api/watchdog/alerty — otwarte, zaalertowane "temat ucieka" dla oglądającego.
// KAŻDY (także admin) widzi wyłącznie swoje: watche leadów/wycen po owner oraz
// obietnice klienta zroutowane do niego po kanale. Wiersze wzbogacone o dane
// obiektu do renderu bez drugiego zapytania po stronie frontu.
function registerWatchdogEndpoints(app, { getClient, isAdmin }) {
  app.get('/api/watchdog/alerty', async (req, res) => {
    try {
      const supabase = getClient();
      const name = String(req.user?.name || '').trim();
      // Podział per właściciel: bez imienia z sesji nie pokazujemy nic (nie
      // wyciekamy cudzych alertów). Admin też jest tu "sobą" - koniec bypassu.
      if (!name) return res.json({ data: [] });

      // Watche leadów/wycen (feedback_watch). Ciche AI (visible=false) TEŻ
      // wchodzą - "stygnie po rozmowie" to również temat, który ucieka.
      // Realność wyceny sprawdzamy niżej, po dociągnięciu jej danych.
      const { data: watcheRaw, error } = await supabase.from(watchdog.FEEDBACK_WATCH_TABLE)
        .select('*').is('resolved_at', null).not('alerted_at', 'is', null)
        .ilike('owner', name)
        .order('due_at', { ascending: true });
      if (error) throw error;
      const watche = watcheRaw || [];

      const wycenaIds = watche.filter((a) => a.object_type === 'wycena').map((a) => Number(a.object_id)).filter(Number.isFinite);
      const leadIds = watche.filter((a) => a.object_type === 'lead').map((a) => Number(a.object_id)).filter(Number.isFinite);
      const objById = new Map();
      const wycenaById = new Map();
      if (wycenaIds.length) {
        const { data: wyceny } = await supabase.from('wyceny')
          .select('id,imie_nazwisko,kwota_proponowana_brutto,status,typ,lead_id,telefon_digits,telefon_e164,created_at')
          .in('id', wycenaIds);
        (wyceny || []).forEach((w) => { wycenaById.set(String(w.id), w); objById.set(`wycena:${w.id}`, w); });
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
      // Odsiew wycen: zostają tylko realne/wykonalne (ma leada/imię, albo świeży
      // telefon). Martwe bezimienne importy wypadają z alarmu. Leady zostają.
      const watcheOk = watche.filter((a) => (
        a.object_type !== 'wycena' || wycenaKwalifikuje(wycenaById.get(String(a.object_id)))
      ));

      // Obietnice z wiadomości (kom_commitments): tylko owner='klient' (klient
      // miał coś zrobić i nie zrobił); "my" -> nasze "do odpisania", inny worek.
      // Routing do handlowca per kanał, potem pokazujemy tylko przypisane do
      // oglądającego. Blokada nadawców-automatów. Miękka degradacja: błąd kom_*
      // nie kładzie listy alertów.
      let obietnice = [];
      try {
        const { data: kom } = await supabase.from('kom_commitments')
          .select('id,description,owner,due_at,alert_text,alerted_at,thread_id,customer_id')
          .eq('status', 'open').eq('owner', 'klient').not('alerted_at', 'is', null)
          .order('due_at', { ascending: true });
        const komRows = kom || [];
        const threadIds = [...new Set(komRows.map((c) => c.thread_id).filter(Boolean))];
        const custIds = [...new Set(komRows.map((c) => c.customer_id).filter(Boolean))];
        const threadById = new Map();
        const custById = new Map();
        if (threadIds.length) {
          const { data: th } = await supabase.from('kom_threads').select('id,channel,meta').in('id', threadIds);
          (th || []).forEach((t) => threadById.set(t.id, t));
        }
        if (custIds.length) {
          const { data: cu } = await supabase.from('kom_customers').select('id,display_name,public_id,alerts_excluded').in('id', custIds);
          (cu || []).forEach((c) => custById.set(c.id, c));
        }
        obietnice = komRows.reduce((acc, c) => {
          const th = threadById.get(c.thread_id) || {};
          const cu = custById.get(c.customer_id) || {};
          // Automat (denylist) albo ręcznie wykluczony nadawca (przycisk
          // "wyklucz maila", flaga kom_customers.alerts_excluded) -> poza alarmem.
          if (nadawcaZablokowany(cu.display_name, cu.public_id) || cu.alerts_excluded) return acc;
          const owner = handlowiecObietnicy(th.channel, th.meta);
          if (owner.toLowerCase() !== name.toLowerCase()) return acc;
          acc.push({
            id: c.id,
            object_type: 'wiadomosc',
            object_id: c.id,
            customer_id: c.customer_id,
            owner,
            channel: th.channel || null,
            due_at: c.due_at,
            alert_text: c.alert_text,
            alerted_at: c.alerted_at,
            visible: true,
            // public_id -> deep-link hubu do wątku klienta (/wiadomosci/?klient=).
            _obiekt: {
              imie_nazwisko: cu.display_name || cu.public_id || '',
              public_id: cu.public_id || '',
            },
          });
          return acc;
        }, []);
      } catch (err) {
        console.error('Watchdog alerty (obietnice):', err.message);
      }

      res.json({
        data: [
          ...watcheOk.map((a) => ({
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

  // POST /api/watchdog/nadawcy/:customerId/wyklucz — trwałe wykluczenie nadawcy
  // z alarmu "temat ucieka" (przycisk "wyklucz maila" w hubie). Flaga na
  // kom_customers; jego obietnice nie wpadają już do listy. NIE rusza inboxa
  // komunikatora - to wyciszenie dotyczy wyłącznie tego alarmu.
  app.post('/api/watchdog/nadawcy/:customerId/wyklucz', async (req, res) => {
    try {
      if (!String(req.user?.name || '').trim()) return res.status(403).json({ error: 'Brak uprawnień' });
      const { data, error } = await getClient().from('kom_customers')
        .update({ alerts_excluded: true })
        .eq('id', String(req.params.customerId)).select('id');
      if (error) throw error;
      if (!data || !data.length) return res.status(404).json({ error: 'Nie znaleziono nadawcy' });
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
}

module.exports = { runWatchdogSweep, registerWatchdogEndpoints, sweepDotrzymaneDzis };
