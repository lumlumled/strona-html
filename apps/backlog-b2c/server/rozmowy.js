// ── Ręczne dodawanie rozmowy (szybki panel /rozmowa) ────────────────────────
// docs/plan-kontakt-karta-leada.md + decyzja Antoniego 2026-07-14 (szybkie
// dodawanie z plusa w topbarze): wklejona transkrypcja rozmowy przechodzi
// przez DOKŁADNIE tę samą analizę co webhook Zadarmy (wspólny moduł
// apps/shared/server/call-analysis.js):
//   • telefon pasuje do Leady B2C  → pełny pipeline leada (status przez
//     lejek, Historia rozmów, Ocena AI, najbliższa akcja, Log zmian
//     zrodlo='rozmowa_reczna', RPC z bypassem triggera, sync planu dnia);
//   • telefon pasuje do kontakty_organic → aktualizacja tego kontaktu;
//   • brak dopasowania → NOWY wiersz w kontakty_organic (źródło domyślnie
//     'organic'), NIE w Leady B2C — rozmowy "z ulicy" nie zaśmiecają lejka.
//
// Moduł jest dependency-injected (deps z server.js: findLeadByPhone, sync
// Umowy, helpery dat) — bez cyklicznego require i testowalny na atrapie.

const { analyzeCall, statusRank, NO_ANSWER_ALLOWED_FROM, parseKwotaZlotych } = require('../../shared/server/call-analysis');

const LEADY_B2C_TABLE = 'Leady B2C';
const LOG_ZMIAN_TABLE = 'Log zmian';
const KONTAKTY_ORGANIC_TABLE = 'kontakty_organic';

function normalizePhoneDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

async function findKontaktOrganic(supabase, phoneDigits) {
  if (!phoneDigits) return null;
  const { data, error } = await supabase
    .from(KONTAKTY_ORGANIC_TABLE)
    .select('*')
    .eq('telefon', phoneDigits)
    .limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

// Nakłada rozmowę na istniejący kontakt organic — lustrzane odbicie ścieżki
// leada z webhooka: lejek statusów (nigdy w dół), historia na górę, ocena AI
// regenerowana, akcja REEWALUOWANA gdy jest analiza. Używane przez POST
// /api/rozmowy/reczna ORAZ webhook Zadarmy (numer w kontakty_organic nie
// tworzy już duplikatu leada). Zwraca { statusAfter, historiaEntry, opis }.
async function applyRozmowaDoKontaktu(supabase, kontakt, { analysis, transcript, label = 'answered', handlowiec, whenText }) {
  const closed = ['Sprzedane', 'Stracony'].includes(kontakt.status);
  let statusAfter = kontakt.status;
  if (!closed) {
    if (label === 'no_answer') {
      if (!kontakt.status || NO_ANSWER_ALLOWED_FROM.has(kontakt.status)) statusAfter = 'Nie odebrał';
    } else if (analysis?.status && statusRank(analysis.status) >= statusRank(kontakt.status)) {
      statusAfter = analysis.status;
    }
  }

  const opis = analysis?.opis || (transcript ? transcript.slice(0, 200) : 'Nie odebrał');
  const historiaEntry = `${whenText} - ${label === 'answered' ? opis : 'Nie odebrał'}`;
  const setAkcja = Boolean(analysis);
  const akcja = (!['Sprzedane', 'Stracony'].includes(statusAfter) && analysis?.najblizsza_akcja) || null;

  const patch = {
    status: statusAfter,
    historia_rozmow: kontakt.historia_rozmow ? `${historiaEntry}\n${kontakt.historia_rozmow}` : historiaEntry,
    tresc_rozmowy: transcript || kontakt.tresc_rozmowy || null,
    ilosc_rozmow: (Number(kontakt.ilosc_rozmow) || 0) + 1,
    ostatni_kontakt: whenText,
    updated_at: new Date().toISOString(),
  };
  if (analysis?.skrocony_opis) patch.ocena_ai = analysis.skrocony_opis;
  if (setAkcja) {
    patch.najblizsza_akcja = akcja;
    patch.najblizsza_akcja_termin = akcja ? (analysis?.najblizsza_akcja_termin || null) : null;
    patch.najblizsza_akcja_owner = akcja ? (handlowiec || null) : null;
  }

  const { error } = await supabase.from(KONTAKTY_ORGANIC_TABLE).update(patch).eq('id', kontakt.id);
  if (error) throw new Error(`Zapis kontaktu organic: ${error.message}`);
  return { statusAfter, historiaEntry, opis };
}

// deps: { getClient, findLeadByPhone, updateStatusInUmowa, markZamknieteInUmowa,
//         warsawDateStr, warsawDateTimeStr, defaultHandlowiec }
function registerRozmowyEndpoints(app, deps) {
  const { getClient, findLeadByPhone, updateStatusInUmowa, markZamknieteInUmowa, warsawDateStr, warsawDateTimeStr } = deps;

  // GET /api/rozmowy/szukaj?telefon= — podgląd dopasowania na żywo w panelu
  // (zanim użytkownik wklei transkrypcję wie, czy pisze do leada, do
  // istniejącego kontaktu organic, czy tworzy nowy).
  app.get('/api/rozmowy/szukaj', async (req, res) => {
    try {
      const digits = normalizePhoneDigits(req.query.telefon);
      if (!digits || digits.length < 9) return res.json({ dopasowanie: null });
      const supabase = getClient();
      const lead = await findLeadByPhone(supabase, digits);
      if (lead) {
        return res.json({
          dopasowanie: 'lead',
          nazwa: lead['Name'] || null,
          status: lead['Deal stage'] || null,
          id_leada: lead['ID Leada'] ?? null,
        });
      }
      const kontakt = await findKontaktOrganic(supabase, digits);
      if (kontakt) {
        return res.json({
          dopasowanie: 'kontakt_organic',
          nazwa: kontakt.imie || null,
          status: kontakt.status || null,
          zrodlo: kontakt.zrodlo,
        });
      }
      res.json({ dopasowanie: null });
    } catch (err) {
      console.error(err);
      res.status(502).json({ error: err.message });
    }
  });

  // GET /api/rozmowy/kontakty-organic — lista do panelu (najświeższe na górze).
  app.get('/api/rozmowy/kontakty-organic', async (req, res) => {
    try {
      const supabase = getClient();
      const { data, error } = await supabase
        .from(KONTAKTY_ORGANIC_TABLE)
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      res.json({ data: data || [] });
    } catch (err) {
      console.error(err);
      res.status(502).json({ error: err.message });
    }
  });

  // POST /api/rozmowy/reczna — { telefon, tresc, kierunek?, zrodlo?, imie? }.
  // Serce szybkiego panelu; szczegóły ścieżek w komentarzu modułu wyżej.
  app.post('/api/rozmowy/reczna', async (req, res) => {
    const supabase = getClient();
    try {
      const digits = normalizePhoneDigits(req.body?.telefon);
      const tresc = String(req.body?.tresc || '').trim();
      // 9 cyfr (bez prefiksu) albo 48+9 — spójnie z resztą systemu, gdzie
      // klucz "Phone number"/Log zmian.telefon bywa w obu wariantach.
      if (!digits || digits.length < 9) return res.status(400).json({ error: 'Podaj poprawny numer telefonu' });
      if (!tresc) return res.status(400).json({ error: 'Pusta transkrypcja' });
      // Kierunek tylko z zamkniętej listy — cokolwiek innego psułoby prompt.
      const kierunek = ['przychodzące', 'wychodzące'].includes(req.body?.kierunek) ? req.body.kierunek : null;
      const handlowiec = (req.user && req.user.name) || deps.defaultHandlowiec || null;
      const receivedAt = new Date();
      const whenText = warsawDateTimeStr(receivedAt);

      const lead = await findLeadByPhone(supabase, digits);
      const kontakt = lead ? null : await findKontaktOrganic(supabase, digits);

      const analysis = await analyzeCall(tresc, {
        kierunek,
        dzisiaj: warsawDateStr(receivedAt),
        poprzedniOpis: lead ? lead['Ocena AI kontaktu'] : (kontakt ? kontakt.ocena_ai : null),
        poprzedniaAkcja: lead ? lead['Najbliższa akcja'] : (kontakt ? kontakt.najblizsza_akcja : null),
      });
      const opis = analysis?.opis || tresc.slice(0, 200);

      // ── Ścieżka 1: lead — pełny pipeline jak webhook Zadarmy ──
      if (lead) {
        const statusBefore = lead['Deal stage'];
        const leadClosed = ['Sprzedane', 'Stracony'].includes(statusBefore);
        let statusAfter = statusBefore;
        if (!leadClosed && analysis?.status && statusRank(analysis.status) >= statusRank(statusBefore)) {
          statusAfter = analysis.status;
        }
        const feedbackAfter = analysis?.data_feedbacku || lead['Data Feedbacku'];
        const historiaEntry = `${whenText} - ${opis}`;
        const setAkcja = Boolean(analysis);
        const akcjaPoRozmowie = (!['Sprzedane', 'Stracony'].includes(statusAfter) && analysis?.najblizsza_akcja) || null;
        const akcjaTermin = akcjaPoRozmowie ? (analysis?.najblizsza_akcja_termin || null) : null;
        const akcjaOwner = akcjaPoRozmowie ? handlowiec : null;

        const { error: insertErr } = await supabase.from(LOG_ZMIAN_TABLE).insert({
          zrodlo: 'rozmowa_reczna',
          telefon: digits,
          status_przed: statusBefore,
          status_po: statusAfter,
          opis,
          data_feedbacku_przed: lead['Data Feedbacku'],
          data_feedbacku_po: feedbackAfter,
          kierunek,
          zamkniete_dzis: Boolean(analysis?.zamkniete_dzis),
          transkrypcja: tresc,
          handlowiec,
          // Brak czas_trwania_s (null, nie 0) — ręczna wklejka nie zna czasu
          // trwania; 0 fałszowałoby średnie w statystykach.
          disposition: 'answered',
          dopasowano_tabela: LEADY_B2C_TABLE,
          dopasowano_id: String(lead['ID'] ?? ''),
        });
        if (insertErr) throw new Error(`Zapis do Log zmian: ${insertErr.message}`);

        const cenaZaproponowana = parseKwotaZlotych(analysis?.cena_zaproponowana);
        const { error: updateErr } = await supabase.rpc('app_update_leady_after_call', {
          p_phone: lead['Phone number'],
          p_ilosc_telefonow: String((Number(lead['Ilość telefonów']) || 0) + 1),
          p_ostatni_kontakt: whenText,
          p_tresc_rozmowy: tresc,
          p_deal_stage: statusAfter,
          p_data_feedbacku: feedbackAfter,
          p_produkty: analysis?.produkty || null,
          p_kwota: cenaZaproponowana ?? null,
          p_ocena_ai: analysis?.skrocony_opis || null,
          p_historia: lead['Historia rozmów'] ? `${historiaEntry}\n${lead['Historia rozmów']}` : historiaEntry,
          p_set_akcja: setAkcja,
          p_akcja: akcjaPoRozmowie,
          p_akcja_termin: akcjaTermin,
          p_akcja_owner: akcjaOwner,
          p_godzina_feedbacku: analysis?.data_feedbacku ? (analysis.godzina_feedbacku || null) : null,
        });
        if (updateErr) throw new Error(`Zapis do Leady B2C: ${updateErr.message}`);

        // Plan dnia: status case'a dociąga się jak po telefonie z Zadarmy
        // (commit f580f96) — kategoria zostaje, status się aktualizuje.
        if (statusAfter) await updateStatusInUmowa(supabase, digits, statusAfter);
        if (analysis?.zamkniete_dzis) await markZamknieteInUmowa(supabase, digits);

        return res.json({
          dopasowanie: 'lead',
          nazwa: lead['Name'] || null,
          status: statusAfter,
          skrocony_opis: analysis?.skrocony_opis || null,
          opis,
          akcja: akcjaPoRozmowie,
          data_feedbacku: analysis?.data_feedbacku || null,
        });
      }

      // ── Ścieżka 2: istniejący kontakt organic ──
      if (kontakt) {
        const wynik = await applyRozmowaDoKontaktu(supabase, kontakt, { analysis, transcript: tresc, handlowiec, whenText });
        const { error: logErr } = await supabase.from(LOG_ZMIAN_TABLE).insert({
          zrodlo: 'rozmowa_reczna',
          telefon: digits,
          status_przed: kontakt.status,
          status_po: wynik.statusAfter,
          opis: wynik.opis,
          kierunek,
          zamkniete_dzis: Boolean(analysis?.zamkniete_dzis),
          transkrypcja: tresc,
          handlowiec,
          disposition: 'answered',
          dopasowano_tabela: KONTAKTY_ORGANIC_TABLE,
          dopasowano_id: String(kontakt.id),
        });
        if (logErr) console.error('Błąd zapisu Log zmian (kontakt organic):', logErr.message);
        return res.json({
          dopasowanie: 'kontakt_organic',
          nazwa: kontakt.imie || null,
          status: wynik.statusAfter,
          skrocony_opis: analysis?.skrocony_opis || null,
          opis: wynik.opis,
          akcja: analysis?.najblizsza_akcja || null,
        });
      }

      // ── Ścieżka 3: nowy kontakt organic ──
      const zrodlo = String(req.body?.zrodlo || '').trim() || 'organic';
      const imie = String(req.body?.imie || '').trim() || null;
      const { data: created, error: createErr } = await supabase
        .from(KONTAKTY_ORGANIC_TABLE)
        .insert({ telefon: digits, imie, zrodlo, owner: handlowiec })
        .select('*')
        .single();
      if (createErr) throw new Error(`Nie utworzono kontaktu: ${createErr.message}`);
      const wynik = await applyRozmowaDoKontaktu(supabase, created, { analysis, transcript: tresc, handlowiec, whenText });
      const { error: logErr } = await supabase.from(LOG_ZMIAN_TABLE).insert({
        zrodlo: 'rozmowa_reczna',
        telefon: digits,
        status_po: wynik.statusAfter,
        opis: wynik.opis,
        kierunek,
        zamkniete_dzis: Boolean(analysis?.zamkniete_dzis),
        transkrypcja: tresc,
        handlowiec,
        disposition: 'answered',
        dopasowano_tabela: KONTAKTY_ORGANIC_TABLE,
        dopasowano_id: String(created.id),
      });
      if (logErr) console.error('Błąd zapisu Log zmian (nowy kontakt):', logErr.message);
      res.json({
        dopasowanie: 'nowy_kontakt',
        nazwa: imie,
        zrodlo,
        status: wynik.statusAfter,
        skrocony_opis: analysis?.skrocony_opis || null,
        opis: wynik.opis,
        akcja: analysis?.najblizsza_akcja || null,
      });
    } catch (err) {
      console.error(err);
      res.status(502).json({ error: err.message });
    }
  });
}

module.exports = { registerRozmowyEndpoints, findKontaktOrganic, applyRozmowaDoKontaktu };
