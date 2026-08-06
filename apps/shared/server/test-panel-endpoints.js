// Endpointy panelu Test (kokpit umowy 30 dni handlowca) — montowane w
// apps/test/server/server.js za bramką auth (panel adminOnly, więc widzi go
// wyłącznie admin). Cała matematyka żyje w test-panel-metrics.js (czysta,
// testowana); tu tylko dowóz danych z Supabase i ocenianie transkrypcji AI.
const { computeKokpit, pickOdsluch, HANDLOWIEC } = require('./test-panel-metrics');

const LOG_TABLE = 'Log zmian';
const LEADY_TABLE = 'Leady B2C';
const SCORES_TABLE = 'test_call_scores';

// Start testu: pierwszy dzień umowy (2026-08-06 00:00 czasu Warszawy — dzień
// rozmowy Antoniego z Lorenzem). Nowe leady liczone od tej daty — wcześniejsze
// świadomie poza panelem ("nie patrzmy wstecznie").
const TEST_START = process.env.TEST_START_DATE || '2026-08-05T22:00:00Z';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// gpt-5-mini jak w call-analysis/watchdog; wymaga reasoning_effort, inaczej
// potrafi zwrócić pusty content (patrz memory projektu o watchdogu).
const SCORER_MODEL = process.env.TEST_SCORER_MODEL || 'gpt-5-mini';

const SCORER_PROMPT = `Jesteś surowym trenerem sprzedaży w firmie LumLum (premium systemy oświetlenia LED: kaskada schodowa, podszafkowe, elewacje; model: lead z reklamy -> telefon -> wycena szyta na miarę -> zamówienie). Oceniasz JEDNĄ transkrypcję rozmowy telefonicznej handlowca (Lorenzo) z klientem. Transkrypcja nie ma oznaczonych mówców - rozpoznaj ich po kontekście (handlowiec dzwoni z firmy Lumlum / odpowiada na zgłoszenie z formularza).

Oceń handlowca w skali 1-5 (1=fatalnie, 3=poprawnie, 5=wzorowo). Jeżeli dane kryterium NIE MIAŁO OKAZJI wystąpić (np. klient nie zgłosił żadnej obiekcji, o cenie w ogóle nie było mowy), daj null zamiast oceny:
- "otwarcie": przedstawił się z imienia, podał powód telefonu, nawiązał do zgłoszenia klienta zamiast suchego "dzwonię z firmy X"
- "potrzeba": pytał o pomieszczenie/metry/efekt/etap remontu ORAZ o kwestie handlowe (termin decyzji, budżet, kto decyduje)
- "wartosc": sprzedał system i efekt (jakość, gwarancja 3 lata, żywotność, dobór za klienta) ZANIM padła goła cena za metr; nie rozdawał rabatów nieproszony
- "obiekcje": po "za drogo / pomyślę / porównam / zapytam żony" dopytał o prawdziwy powód i podjął DRUGĄ próbę; nie skapitulował po pierwszym "nie"
- "next_step": rozmowa skończyła się KONKRETNĄ datą/godziną następnego kroku (nie "jesteśmy w kontakcie" / "proszę dzwonić w razie czego")

Flagi (boolean, true tylko gdy ewidentne w transkrypcji):
- "rabat_bez_zobowiazania": obniżył cenę lub dał gratis, nie prosząc klienta o nic w zamian
- "odeslanie_do_konkurencji": zasugerował klientowi szukanie produktu gdzie indziej
- "brak_next_stepu": rozmowa handlowa skończyła się bez umówionego terminu
- "kapitulacja_po_obiekcji": po obiekcji poddał się bez drugiej próby ("nie zmuszam", "w razie czego proszę dzwonić")
- "zapytam_kolegi": nie znał własnego produktu/parametrów i odsyłał do "bardziej technicznego kolegi"

Zwróć WYŁĄCZNIE JSON:
{"otwarcie":1-5|null,"potrzeba":1-5|null,"wartosc":1-5|null,"obiekcje":1-5|null,"next_step":1-5|null,"flagi":{"rabat_bez_zobowiazania":bool,"odeslanie_do_konkurencji":bool,"brak_next_stepu":bool,"kapitulacja_po_obiekcji":bool,"zapytam_kolegi":bool},"cytat":"najbardziej znaczący DOSŁOWNY cytat z rozmowy","rada":"jedna konkretna rada na następną taką rozmowę","podsumowanie":"jedno zdanie o tej rozmowie"}

Jeśli to nie jest rozmowa handlowa (pomyłka, kurier, czysta logistyka wysyłki), zwróć {"pomin":true}.`;

async function scoreTranscript(transcript) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: SCORER_MODEL,
      response_format: { type: 'json_object' },
      reasoning_effort: 'minimal',
      messages: [
        { role: 'system', content: SCORER_PROMPT },
        { role: 'user', content: transcript },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return JSON.parse(body.choices?.[0]?.message?.content || '{}');
}

// Supabase domyślnie tnie do 1000 wierszy — range() z zapasem, bo w 30 dni
// testu Log zmian spokojnie przekroczy tysiąc.
async function fetchDane(supabase) {
  const [leadyRes, callsRes, paidRes, openRes] = await Promise.all([
    supabase.from(LEADY_TABLE).select('*').range(0, 4999),
    supabase.from(LOG_TABLE)
      .select('id,data_zmiany,zrodlo,telefon,kierunek,disposition,czas_trwania_s,status_przed,status_po,data_feedbacku_po,handlowiec')
      .not('kierunek', 'is', null).order('data_zmiany', { ascending: true }).range(0, 9999),
    supabase.from('wyceny')
      .select('id,telefon_digits,status,paid,paid_at,kwota_sprzedazy_brutto,imie_nazwisko,owner')
      .eq('paid', true).gte('paid_at', TEST_START),
    supabase.from('wyceny')
      .select('id,telefon_digits,status')
      .eq('paid', false).in('status', ['Open', 'Waiting for payment']),
  ]);
  for (const r of [leadyRes, callsRes, paidRes, openRes]) if (r.error) throw new Error(r.error.message);
  return { leads: leadyRes.data || [], calls: callsRes.data || [], wycenyPaid: paidRes.data || [], wycenyOpen: openRes.data || [] };
}

// Buduje pełny kokpit umowy (te same liczby dla /test i /moje — panel Lorenza
// reużywa tego samego silnika). Flagi stylu (reguła 6) tylko z rozmów OD STARTU
// testu — karta ocen może zawierać starsze rozmowy (materiał na odsłuch), ale
// one nie obciążają wyniku umowy.
async function buildKokpit(supabase) {
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const odKiedy = weekAgo > TEST_START ? weekAgo : TEST_START;
  const [dane, scoresRes] = await Promise.all([
    fetchDane(supabase),
    supabase.from(SCORES_TABLE).select('log_id,scores,flagi,pominieta').gte('data_rozmowy', odKiedy),
  ]);
  if (scoresRes.error) throw new Error(scoresRes.error.message);
  return computeKokpit({ ...dane, scoresWeek: (scoresRes.data || []).filter((s) => !s.pominieta), start: TEST_START });
}

function registerTestPanelEndpoints(app, { getClient }) {
  app.get('/api/test/kokpit', async (req, res) => {
    try {
      res.json(await buildKokpit(getClient()));
    } catch (err) {
      console.error('Kokpit testu:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Ocenia AI-ką nieocenione jeszcze rozmowy z ostatnich 7 dni (idempotentne:
  // log_id UNIQUE + filtr po już ocenionych). limit chroni czas funkcji.
  app.post('/api/test/karta', async (req, res) => {
    try {
      if (!OPENAI_API_KEY) return res.status(400).json({ error: 'Brak OPENAI_API_KEY' });
      const supabase = getClient();
      const limit = Math.min(Number(req.body?.limit) || 40, 60);
      const od = new Date(Date.now() - 7 * 864e5).toISOString();
      const [callsRes, doneRes] = await Promise.all([
        supabase.from(LOG_TABLE)
          .select('id,data_zmiany,telefon,kierunek,disposition,czas_trwania_s,transkrypcja,handlowiec')
          .eq('handlowiec', HANDLOWIEC).eq('disposition', 'answered')
          .gte('data_zmiany', od).not('transkrypcja', 'is', null)
          .order('data_zmiany', { ascending: false }).range(0, 499),
        supabase.from(SCORES_TABLE).select('log_id').gte('data_rozmowy', od),
      ]);
      if (callsRes.error) throw new Error(callsRes.error.message);
      if (doneRes.error) throw new Error(doneRes.error.message);
      const ocenione = new Set((doneRes.data || []).map((r) => String(r.log_id)));
      const kandydaci = (callsRes.data || [])
        .filter((c) => !ocenione.has(String(c.id)) && (c.czas_trwania_s || 0) >= 40 && String(c.transkrypcja).length >= 200)
        .slice(0, limit);

      let zapisane = 0; const bledy = [];
      // Po 4 naraz: 40 rozmów mieści się w maxDuration 180 s funkcji huba.
      for (let i = 0; i < kandydaci.length; i += 4) {
        await Promise.all(kandydaci.slice(i, i + 4).map(async (c) => {
          try {
            const wynik = await scoreTranscript(c.transkrypcja);
            const row = {
              log_id: String(c.id), telefon: c.telefon, data_rozmowy: c.data_zmiany,
              czas_trwania_s: c.czas_trwania_s, model: SCORER_MODEL,
              pominieta: wynik.pomin === true,
              scores: wynik.pomin ? {} : {
                otwarcie: wynik.otwarcie ?? null, potrzeba: wynik.potrzeba ?? null,
                wartosc: wynik.wartosc ?? null, obiekcje: wynik.obiekcje ?? null,
                next_step: wynik.next_step ?? null,
              },
              flagi: wynik.flagi || {},
              cytat: wynik.cytat || null, rada: wynik.rada || null, podsumowanie: wynik.podsumowanie || null,
            };
            const { error } = await getClient().from(SCORES_TABLE).upsert(row, { onConflict: 'log_id', ignoreDuplicates: true });
            if (error) throw new Error(error.message);
            zapisane += 1;
          } catch (err) {
            bledy.push({ logId: c.id, error: err.message });
          }
        }));
      }
      res.json({ ocenione: zapisane, kandydatow: kandydaci.length, bledy });
    } catch (err) {
      console.error('Karta ocen:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Karta tygodnia: średnie per kryterium, flagi, 5 rozmów na odsłuch
  // (1 wzorcowa + 4 problemowe, każda z innym dominującym problemem).
  app.get('/api/test/karta', async (req, res) => {
    try {
      const supabase = getClient();
      const od = new Date(Date.now() - 7 * 864e5).toISOString();
      const { data, error } = await supabase.from(SCORES_TABLE).select('*').gte('data_rozmowy', od).order('data_rozmowy', { ascending: false });
      if (error) throw new Error(error.message);
      const scores = (data || []).filter((s) => !s.pominieta);

      const KRYTERIA = ['otwarcie', 'potrzeba', 'wartosc', 'obiekcje', 'next_step'];
      const srednie = {};
      for (const k of KRYTERIA) {
        const vals = scores.map((s) => s.scores?.[k]).filter((v) => typeof v === 'number');
        srednie[k] = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
      }
      const flagi = {};
      for (const s of scores) for (const [k, v] of Object.entries(s.flagi || {})) if (v === true) flagi[k] = (flagi[k] || 0) + 1;

      const odsluch = pickOdsluch(scores);
      // Transkrypcje tylko dla wybranej 5 — reszta karty ich nie potrzebuje.
      const wybrane = [odsluch.wzorcowa, ...odsluch.problemowe].filter(Boolean);
      if (wybrane.length) {
        const ids = wybrane.map((s) => s.log_id);
        const { data: trans, error: tErr } = await supabase.from(LOG_TABLE).select('id,transkrypcja,czas_trwania_s,telefon').in('id', ids);
        if (tErr) throw new Error(tErr.message);
        const byId = new Map((trans || []).map((t) => [String(t.id), t]));
        for (const s of wybrane) s.transkrypcja = byId.get(String(s.log_id))?.transkrypcja || null;
      }
      res.json({ ocenionych: scores.length, pominietych: (data || []).length - scores.length, srednie, flagi, odsluch });
    } catch (err) {
      console.error('Karta ocen (GET):', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerTestPanelEndpoints, buildKokpit, TEST_START, scoreTranscript, fetchDane };
