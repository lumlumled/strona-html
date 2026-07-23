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

// Zwraca { ids, error } — lista id domkniętych wycen (pusta, gdy nie było
// czego domykać). Nie rzuca: to efekt uboczny zmiany statusu leada i nie może
// wywrócić głównej operacji (rozmowy, edycji karty). Błąd ląduje w polu error
// i w logu, żeby dało się go zauważyć.
async function zamknijWycenyStraconego(supabase, { leadId, telefon } = {}) {
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
    const ids = (data || []).map((w) => w.id);
    if (!ids.length) return { ids: [], error: null };

    const { error: updErr } = await supabase
      .from(WYCENY_TABLE)
      .update({ status: 'Stracone' })
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

module.exports = { zamknijWycenyStraconego };
