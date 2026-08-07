// ── Domykanie wycen straconego klienta ──────────────────────────────────────
// Decyzja Antoniego 2026-07-23 (lead 467 Kamil Marciniec): lead poszedł na
// "Stracony" po rozmowie ("za drogo, mam ofertę za 3300 od elektryka"), ale
// jego wycena na 6027,50 zł została w tabeli `wyceny` ze statusem 'Open' — i
// dalej wisiała w Backlogu jako temat do domknięcia. Backlog buduje kubełki
// wycen wyłącznie z `status='Open'` (patrz zapytania w backlog-b2c/server),
// więc przestawienie statusu na 'Stracone' usuwa taką wycenę z planu dnia raz
// na zawsze, bez żadnego dodatkowego filtra po stronie widoku.
//
// Zakres celowo wąski:
//   • tylko typ 'WYCENA' — 'ZAMÓWIENIE' to rzecz, którą klient już kupił,
//     strata leada nie może cofać sprzedaży;
//   • tylko status 'Open' — 'Waiting for payment' zostaje nietknięte, bo to
//     płatność w toku (klient dostał link), a nie temat do domknięcia.
// Dopasowanie po lead_id ORAZ po telefonie: większość wycen nie ma lead_id
// (sieroty z formularza — patrz projekt "wyceny bez leada"), więc sam lead_id
// przepuściłby dokładnie te przypadki, o które chodzi.

const { resolveWatch } = require('./watchdog');

const WYCENY_TABLE = 'wyceny';

// Konwencja tabeli `wyceny`: telefon_digits to 9 cyfr BEZ prefiksu 48
// (patrz apps/formularz), a Leady B2C trzyma "Phone number" z 48 — stąd
// zdejmowanie prefiksu przed dopasowaniem.
function nine(v) {
  return String(v || '').replace(/\D/g, '').replace(/^48/, '');
}

// "DD.MM.YYYY HH:mm" w czasie warszawskim — format wpisów w "Historia rozmów"
// (parsowany przez kartę leada). Liczony lokalnie, żeby ten moduł nie ciągnął
// helperów z serwera Backlogu.
function warsawDateTimeStr(date) {
  const f = new Intl.DateTimeFormat('pl-PL', {
    timeZone: 'Europe/Warsaw',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(date).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
}

// Zwraca { ids, error } — lista id domkniętych wycen (pusta, gdy nie było
// czego domykać). Nie rzuca: to efekt uboczny zmiany statusu leada i nie może
// wywrócić głównej operacji (rozmowy, edycji karty). Błąd ląduje w polu error
// i w logu, żeby dało się go zauważyć.
// `powod` (opcjonalny) wędruje na wycenę razem ze statusem — bez niego wycena
// wyglądała jak domknięta "z automatu", bez śladu dlaczego (patrz stracony.js).
// `pomijajId` (opcjonalny) wyklucza jedną wycenę z domykania — używane przy
// sprzedaży, żeby świeżo opłacana wycena nigdy nie zamknęła sama siebie,
// niezależnie od tego, czy jej status w bazie zdążył już zejść z 'Open'.
async function zamknijWycenyStraconego(supabase, { leadId, telefon, powod, pomijajId } = {}) {
  const d9 = nine(telefon);
  const idNum = Number(leadId);
  const maLead = Number.isFinite(idNum) && idNum > 0;
  if (!maLead && !d9) return { ids: [], error: null };
  try {
    // Kandydaci wybierani jednym zapytaniem po OR — dopiero potem update po
    // konkretnych id, żeby nigdy nie polecieć szerszym warunkiem niż to, co
    // realnie sprawdziliśmy.
    const filtry = [];
    if (maLead) filtry.push(`lead_id.eq.${idNum}`);
    if (d9) filtry.push(`telefon_digits.eq.${d9}`);
    const { data, error } = await supabase
      .from(WYCENY_TABLE)
      .select('id')
      .eq('typ', 'WYCENA')
      .eq('status', 'Open')
      .or(filtry.join(','));
    if (error) throw error;
    const ids = (data || []).map((w) => w.id).filter((id) => id !== pomijajId);
    if (!ids.length) return { ids: [], error: null };

    const { error: updErr } = await supabase
      .from(WYCENY_TABLE)
      .update({ status: 'Stracone', ...(powod ? { powod_straty: powod } : {}) })
      .in('id', ids);
    if (updErr) throw updErr;

    // Sam status nie wystarcza: wycena pod otwartym watchem wraca do Backlogu
    // kategorią "Alerty — temat ucieka", która czyta feedback_watch i dociąga
    // dane wyceny BEZ patrzenia na jej status (fetchAlertyWatchdoga). Bez tego
    // domknięty temat wracałby drugimi drzwiami — zaobserwowane na wszystkich
    // czterech wycenach z backfillu 23.07.2026.
    for (const id of ids) {
      try {
        await resolveWatch(supabase, { objectType: 'wycena', objectId: id, resolution: 'cancelled' });
      } catch (err) {
        console.error(`Nie udało się zamknąć watcha wyceny ${id}:`, err.message);
      }
    }
    return { ids, error: null };
  } catch (err) {
    console.error('Nie udało się domknąć wycen straconego leada:', err.message);
    return { ids: [], error: err.message };
  }
}

// ── Kierunek odwrotny: wycena "Stracone" → lead "Stracony" ──────────────────
// Decyzja Antoniego 2026-07-23: to ma działać na tej samej zasadzie w obie
// strony. Wycena i lead to jeden temat — domknięcie po którejkolwiek stronie
// nie może zostawiać drugiej jako żywej, bo backlog zaraz pokaże ją jako
// otwarty case do dzwonienia.
//
// Zapis idzie tym samym RPC co ręczne domknięcie z karty (app_lead_stracony,
// migracja 013): jedna transakcja ustawia status + powód, czyści feedback i
// akcję (inaczej lead wracałby alertem watchdoga) i wyłącza trigger
// log_zmian_from_leady, bo własny, bogatszy wiersz do "Log zmian" wstawiamy
// tutaj — bez bypassu jedno domknięcie logowałoby się dwa razy.
//
// Nie rzuca — jak zamknijWycenyStraconego. Zwraca { leadId, statusPrzed } albo
// null, gdy nie było czego domykać (brak leada / lead już stracony).
async function stracLeadaPoWycenie(supabase, wycena, { powod, handlowiec, whenText } = {}) {
  if (!wycena) return null;
  try {
    const d9 = nine(wycena.telefon_digits || wycena.telefon_e164);
    const idNum = Number(wycena.lead_id);
    let lead = null;
    if (Number.isFinite(idNum) && idNum > 0) {
      const { data, error } = await supabase
        .from('Leady B2C').select('*').eq('ID Leada', idNum).limit(1);
      if (error) throw error;
      lead = data[0] || null;
    }
    if (!lead && d9) {
      // Leady B2C trzyma numer z prefiksem 48 jako liczbę (patrz findLeadByPhone).
      const { data, error } = await supabase
        .from('Leady B2C').select('*').eq('Phone number', Number(`48${d9}`)).limit(1);
      if (error) throw error;
      lead = data[0] || null;
    }
    if (!lead) return null;

    const statusPrzed = lead['Deal stage'] || null;
    // Już domknięty (albo sprzedany — strata wyceny nie cofa sprzedaży).
    if (statusPrzed === 'Stracony' || statusPrzed === 'Sprzedane') return null;

    const opis = `[Stracony] ${powod || `Wycena ${wycena.id} oznaczona jako stracona`}`;
    const historiaEntry = `${whenText || warsawDateTimeStr(new Date())} - ${opis}`;
    const { error: rpcErr } = await supabase.rpc('app_lead_stracony', {
      p_id_leada: Number(lead['ID Leada']),
      p_powod: powod || null,
      p_historia: lead['Historia rozmów'] ? `${historiaEntry}\n${lead['Historia rozmów']}` : historiaEntry,
    });
    if (rpcErr) throw rpcErr;

    const { error: logErr } = await supabase.from('Log zmian').insert({
      zrodlo: 'wycena_stracona',
      telefon: d9 ? `48${d9}` : null,
      status_przed: statusPrzed,
      status_po: 'Stracony',
      opis,
      handlowiec: handlowiec || null,
      dopasowano_tabela: 'Leady B2C',
      dopasowano_id: String(lead['ID'] ?? ''),
    });
    if (logErr) console.error('Nie zapisano straty leada do Log zmian:', logErr.message);

    return { leadId: Number(lead['ID Leada']), statusPrzed, telefon: d9 ? `48${d9}` : null };
  } catch (err) {
    console.error('Nie udało się oznaczyć leada jako straconego po wycenie:', err.message);
    return null;
  }
}

// ── Kierunek sprzedaży: wycena opłacona/zrealizowana → lead "Sprzedane" ──────
// Brakująca połówka symetrii (lead 438 Adam Van Bendler, 2026-08-07):
// zamówienie #1996 opłacone i wysłane, a lead dalej "Wycena wysłana" —
// płatność szła eventem do Meta CAPI, ale "Deal stage" nikt nie ruszał.
// Wołane z punktów paid=true pipeline (obok metaCapi.notifyPurchase) oraz
// z ręcznej zmiany statusu wyceny na Fulfilled/Closed (PUT /api/wyceny/:id).
//
// 'Stracony' NIE blokuje: płatność to twardy fakt — klient, który wcześniej
// odpadł, a potem zapłacił, jest sprzedany (statusPrzed zostaje w Log zmian).
// Blokuje tylko już ustawione 'Sprzedane'. Zapis przez RPC app_lead_sprzedany
// (migracja 022) — jedna transakcja, bypass triggera logu, czyszczenie
// feedbacku/akcji jak przy stracie. Nie rzuca — realizacja zamówienia
// (faktura, przesyłka, mail) nie może się wywrócić o sam status leada.
async function sprzedajLeadaPoWycenie(supabase, wycena, { kwota, handlowiec, opis: opisText, whenText } = {}) {
  if (!wycena) return null;
  const d9 = nine(wycena.telefon_digits || wycena.telefon_e164);

  // Reguła "to albo to" (decyzja Antoniego 2026-08-07, wyceny 1995/1996):
  // warianty tej samej instalacji powstają w podobnym czasie i klient kupuje
  // jeden z nich — pozostałe otwarte wyceny tego klienta idą na 'Stracone'
  // z powodem wskazującym zakup, żeby nie wisiały w Backlogu jako tematy do
  // dzwonienia. Robione PRZED dotknięciem leada: działa też dla sierot bez
  // leada i przy drugiej sprzedaży (lead już 'Sprzedane').
  const { ids: wycenyZamkniete } = await zamknijWycenyStraconego(supabase, {
    leadId: wycena.lead_id,
    telefon: d9,
    powod: `Klient kupił inną konfigurację u nas (zamówienie #${wycena.id})`,
    pomijajId: wycena.id,
  });

  try {
    const idNum = Number(wycena.lead_id);
    let lead = null;
    if (Number.isFinite(idNum) && idNum > 0) {
      const { data, error } = await supabase
        .from('Leady B2C').select('*').eq('ID Leada', idNum).limit(1);
      if (error) throw error;
      lead = data[0] || null;
    }
    if (!lead && d9) {
      // Leady B2C trzyma numer z prefiksem 48 jako liczbę (patrz findLeadByPhone).
      const { data, error } = await supabase
        .from('Leady B2C').select('*').eq('Phone number', Number(`48${d9}`)).limit(1);
      if (error) throw error;
      lead = data[0] || null;
    }
    // Bez leada / lead już sprzedany — nic do przestawiania, ale domknięte
    // bliźniacze wyceny raportujemy wołającemu (PUT pokazuje je w odpowiedzi).
    if (!lead) return wycenyZamkniete.length ? { leadId: null, wycenyZamkniete } : null;

    const statusPrzed = lead['Deal stage'] || null;
    if (statusPrzed === 'Sprzedane') return wycenyZamkniete.length ? { leadId: null, wycenyZamkniete } : null;

    const kw = Number(kwota ?? wycena.kwota_sprzedazy_brutto ?? wycena.kwota_proponowana_brutto);
    const opis = `[Sprzedane] ${opisText || `Zamówienie #${wycena.id} opłacone`}${Number.isFinite(kw) && kw > 0 ? ` (${kw} zł)` : ''}`;
    const historiaEntry = `${whenText || warsawDateTimeStr(new Date())} - ${opis}`;
    const { error: rpcErr } = await supabase.rpc('app_lead_sprzedany', {
      p_id_leada: Number(lead['ID Leada']),
      p_historia: lead['Historia rozmów'] ? `${historiaEntry}\n${lead['Historia rozmów']}` : historiaEntry,
    });
    if (rpcErr) throw rpcErr;

    // ⚠️ Nowe źródło 'wycena_sprzedana' musi siedzieć w NIE_TELEFON_ZRODLA
    // i NIE_ROZMOWA_ZRODLA (wszystkie kopie) — to nie jest telefon.
    const { error: logErr } = await supabase.from('Log zmian').insert({
      zrodlo: 'wycena_sprzedana',
      telefon: d9 ? `48${d9}` : null,
      status_przed: statusPrzed,
      status_po: 'Sprzedane',
      opis,
      handlowiec: handlowiec || null,
      dopasowano_tabela: 'Leady B2C',
      dopasowano_id: String(lead['ID'] ?? ''),
    });
    if (logErr) console.error('Nie zapisano sprzedaży leada do Log zmian:', logErr.message);

    return { leadId: Number(lead['ID Leada']), statusPrzed, telefon: d9 ? `48${d9}` : null, wycenyZamkniete };
  } catch (err) {
    console.error('Nie udało się oznaczyć leada jako sprzedanego po wycenie:', err.message);
    return wycenyZamkniete.length ? { leadId: null, wycenyZamkniete } : null;
  }
}

module.exports = { zamknijWycenyStraconego, stracLeadaPoWycenie, sprzedajLeadaPoWycenie };
