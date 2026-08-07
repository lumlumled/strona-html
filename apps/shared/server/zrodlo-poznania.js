// ── "Skąd klient nas zna" — atrybucja źródła z transkrypcji rozmowy ─────────
// Decyzja Antoniego 07.08.2026 (po werdykcie Rady AI /kreacje v2): jedyne
// miejsce, gdzie atrybucja per-film istnieje NAPRAWDĘ, to deklaracja klienta
// w rozmowie. Moduł obsługuje całą ścieżkę:
//   1. reguły promptu (ZRODLO_PROMPT_RULES) — wspólne dla pełnej analizy
//      rozmowy (call-analysis.js) i odchudzonej ekstrakcji backfillu;
//   2. extractZrodlo() — ekstrakcja-only dla backfillu po starych
//      transkrypcjach z "Log zmian" (scripts/backfill-zrodla-poznania.js);
//   3. matchFilm() — dopasowanie opisu klienta ("ten o ledach na schodach")
//      do bazy rolek marketing_video_analysis: KANDYDACI z pewnością, nigdy
//      pewnik; przy zbyt ogólnym opisie świadomie pusta lista;
//   4. zapiszZrodloPoznania() — zapis do lead_zrodla_poznania (źródło prawdy
//      analitycznej, migr. 023) + denormalizacja "Skąd nas zna" na kartę.
// Wywoływane z webhooka Zadarmy i rozmowy ręcznej — dlatego NIE RZUCA:
// każdy błąd łykamy z console.warn, atrybucja nigdy nie może wywrócić
// zapisu rozmowy.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Ten sam model co analiza rozmowy (gpt-5-mini wymaga reasoning_effort —
// patrz watchdog, feedback 2026-07-12).
const ZRODLO_MODEL = process.env.OPENAI_UMOWA_MODEL || 'gpt-5-mini';

const ZRODLA_KODY = ['tiktok', 'instagram', 'facebook', 'youtube', 'social', 'google', 'polecenie', 'reklama', 'inne'];

const ZRODLO_LABELS = {
  tiktok: 'TikTok', instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube',
  social: 'Social media', google: 'Google', polecenie: 'Polecenie', reklama: 'Reklama', inne: 'Inne',
};

// Wspólne reguły ekstrakcji — wstrzykiwane 1:1 do promptu pełnej analizy
// rozmowy (buildCallAnalysisPrompt) i do promptu backfillu. Jedno źródło
// prawdy, żeby żywa ścieżka i backfill nigdy nie rozjechały się w polityce
// "nie zgaduj".
const ZRODLO_PROMPT_RULES = `===== ZASADY zrodlo_poznania (skąd klient nas zna) =====
Wypełnij TYLKO, gdy klient WPROST powiedział, skąd zna firmę / gdzie ją zobaczył
("zobaczyłem was na Facebooku", "obserwuję na Instagramie", "z TikToka",
"kolega polecił", "znalazłem w Google"). Kody:
- tiktok / instagram / facebook / youtube — padła nazwa platformy
- social — social media / "widziałem wasz filmik" BEZ nazwy platformy
- google — wyszukiwarka, "wygooglowałem"
- polecenie — znajomy, rodzina, elektryk, wykonawca, projektant polecił
- reklama — klient mówi wprost o reklamie
- inne — inne jawnie NAZWANE źródło poznania (targi, artykuł, forum, ogłoszenie)
Brak deklaracji → null. NIE zgaduj z kontekstu — to, że klient zna produkt,
NIE znaczy, że powiedział skąd. Odpowiedź klienta ma pierwszeństwo przed
sugestią handlowca w pytaniu.
UWAGA: kanał ZGŁOSZENIA to NIE źródło poznania. "Zgłaszał się pan przez
formularz", "wypełniłem formularz", "na stronie poczytałem", "wysłałem maila"
mówią JAK klient się skontaktował, nie SKĄD nas zna → zrodlo_poznania = null
(chyba że pada też, skąd trafił na stronę/formularz — wtedy koduj TAMTO źródło).

zrodlo_obserwuje: true TYLKO gdy klient mówi, że OBSERWUJE / śledzi profil
("obserwuję was", "śledzę wasze filmiki", "oglądam was od dawna"). Inaczej false.

zrodlo_cytat: możliwie dosłowny cytat wypowiedzi klienta o źródle, max 15 słów.
null gdy zrodlo_poznania = null.

film_opis: TYLKO gdy klient opisuje TREŚĆ konkretnego filmu ("ten o schodach",
"jak montowaliście ledy w ogrodzie", "z tym sterownikiem w ręce") → opis
słowami klienta, max 20 słów. Sama wzmianka "widziałem filmik" bez treści → null.`;

// Pola dokładane do JSON-a analizy rozmowy + fallback (call-analysis.js).
const ZRODLO_OUTPUT_FIELDS = `  "zrodlo_poznania": "kod z listy lub null",
  "zrodlo_obserwuje": true lub false,
  "zrodlo_cytat": "max 15 słów lub null",
  "film_opis": "max 20 słów lub null"`;

const ZRODLO_FALLBACK = { zrodlo_poznania: null, zrodlo_obserwuje: false, zrodlo_cytat: null, film_opis: null };

// Detekcja z surowego JSON-a modelu → znormalizowana (śmieciowy kod → null,
// czyli "nie wykryto"; lepiej zgubić detekcję niż zapisać wymysł).
function normalizeZrodlo(parsed) {
  const kod = ZRODLA_KODY.includes(parsed?.zrodlo_poznania) ? parsed.zrodlo_poznania : null;
  if (!kod) return { ...ZRODLO_FALLBACK };
  return {
    zrodlo_poznania: kod,
    zrodlo_obserwuje: parsed.zrodlo_obserwuje === true,
    zrodlo_cytat: parsed.zrodlo_cytat || null,
    film_opis: parsed.film_opis || null,
  };
}

// ── Ekstrakcja-only (backfill) ───────────────────────────────────────────────
// Odchudzony prompt zamiast pełnego analyzeCall — backfill leci po tysiącach
// starych transkrypcji, płacimy tylko za to jedno pytanie.
async function extractZrodlo(transcript) {
  if (!OPENAI_API_KEY || !transcript) return { ...ZRODLO_FALLBACK };
  const system = `Jesteś asystentem CRM firmy LumLum (oświetlenie LED premium).
Dostajesz transkrypcję rozmowy telefonicznej handlowca z klientem.
Interesuje nas WYŁĄCZNIE, czy klient powiedział, skąd zna firmę.
Zwróć WYŁĄCZNIE jeden obiekt JSON, bez tekstu przed ani po.

${ZRODLO_PROMPT_RULES}

Poczta głosowa / monolog handlowca / brak wypowiedzi klienta → wszystkie pola null/false.

===== FORMAT WYJŚCIOWY =====
{
${ZRODLO_OUTPUT_FIELDS}
}`;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: ZRODLO_MODEL,
        response_format: { type: 'json_object' },
        reasoning_effort: 'minimal',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: transcript },
        ],
      }),
    });
    if (!res.ok) return { ...ZRODLO_FALLBACK };
    const body = await res.json();
    return normalizeZrodlo(JSON.parse(body.choices?.[0]?.message?.content || '{}'));
  } catch (err) {
    console.warn('extractZrodlo nie powiodło się:', err.message);
    return { ...ZRODLO_FALLBACK };
  }
}

// ── Dopasowanie opisu filmu do bazy rolek ───────────────────────────────────
function truncate(str, n) {
  const s = String(str || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// Jedna linia katalogu dla modelu: id | data | format | hook | co widać.
function catalogLine(row) {
  const summary = row.summary || row.caption || '';
  const date = row.published_at ? String(row.published_at).slice(0, 10) : '?';
  return `${row.platform}:${row.video_id} | ${date} | ${row.format || '?'} | ${truncate(row.hook, 90)} | ${truncate(summary, 140)}`;
}

// Odpowiedź modelu → {kandydaci, film_format}. Format bierzemy z KATALOGU
// (faktyczny format wskazanej rolki), nie z deklaracji modelu — model może
// halucynować slug. Próg pewności 0.3: poniżej nie udajemy dopasowania.
function parseMatchResponse(parsed, rowsById) {
  const kandydaci = (Array.isArray(parsed?.kandydaci) ? parsed.kandydaci : [])
    .map((k) => {
      const row = rowsById.get(String(k?.id || ''));
      const pewnosc = Number(k?.pewnosc);
      if (!row || !(pewnosc >= 0.3)) return null;
      return {
        platform: row.platform,
        video_id: row.video_id,
        url: row.url || null,
        format: row.format || null,
        pewnosc: Math.min(1, pewnosc),
        dlaczego: truncate(k.dlaczego, 160) || null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.pewnosc - a.pewnosc)
    .slice(0, 3);
  return {
    kandydaci,
    film_format: kandydaci[0]?.format || null,
    temat: truncate(parsed?.temat, 60) || null,
  };
}

async function matchFilm(supabase, filmOpis, { zrodloKod } = {}) {
  const empty = { kandydaci: [], film_format: null, temat: null };
  if (!OPENAI_API_KEY || !filmOpis) return empty;
  try {
    const { data: rows, error } = await supabase
      .from('marketing_video_analysis')
      .select('platform,video_id,url,format,published_at,hook,caption,summary:visual->>summary')
      .eq('status', 'done')
      .order('published_at', { ascending: false })
      .limit(400);
    if (error || !rows?.length) return empty;
    const rowsById = new Map(rows.map((r) => [`${r.platform}:${r.video_id}`, r]));

    const system = `Klient w rozmowie telefonicznej opisał film, który widział u LumLum (oświetlenie LED).
Masz katalog naszych rolek (jedna linia = jedna rolka):
id | data publikacji | format | hook (pierwsze sekundy) | co widać na filmie

Wskaż MAKSYMALNIE 3 rolki, które klient mógł mieć na myśli, z pewnością 0-1.
- Pewność ≥ 0.7 tylko przy wyraźnej zbieżności treści (temat + szczegół).
- Opis zbyt ogólny, pasuje do dziesiątek rolek → PUSTA lista kandydatów
  (uczciwe "nie wiadomo" jest lepsze niż zmyślone dopasowanie).
- Crossposty: klient mógł widzieć na Facebooku/Instagramie rolkę z katalogu
  TikToka — NIE odrzucaj kandydata przez platformę.
- "ostatnio", "wczoraj", "niedawno" w opisie → preferuj nowsze daty.
Dodatkowo "temat": 2-5 słów, o czym był opisany film (zawsze wypełnij).
Zwróć WYŁĄCZNIE JSON:
{"temat":"...","kandydaci":[{"id":"platform:video_id","pewnosc":0.0,"dlaczego":"max 15 słów"}]}`;
    const user = `OPIS KLIENTA: "${filmOpis}"${zrodloKod ? `\nGDZIE WIDZIAŁ (deklaracja): ${ZRODLO_LABELS[zrodloKod] || zrodloKod}` : ''}

KATALOG:
${rows.map(catalogLine).join('\n')}`;

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: ZRODLO_MODEL,
        response_format: { type: 'json_object' },
        reasoning_effort: 'minimal',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) return empty;
    const body = await res.json();
    return parseMatchResponse(JSON.parse(body.choices?.[0]?.message?.content || '{}'), rowsById);
  } catch (err) {
    console.warn('matchFilm nie powiodło się:', err.message);
    return empty;
  }
}

// ── Tekst na kartę ("Skąd nas zna") ─────────────────────────────────────────
// Np.: Instagram (obserwuje nas) — „ten o ledach na schodach" → obiekt_grafika (70%)
function buildSkadNasZna(det, match) {
  if (!det?.zrodlo_poznania) return null;
  let out = ZRODLO_LABELS[det.zrodlo_poznania] || det.zrodlo_poznania;
  if (det.zrodlo_obserwuje) out += ' (obserwuje nas)';
  if (det.film_opis) out += ` — „${det.film_opis}”`;
  const top = match?.kandydaci?.[0];
  if (top) out += ` → ${top.format || 'rolka'} (${Math.round(top.pewnosc * 100)}%)`;
  else if (det.film_opis && match?.temat) out += ` [temat: ${match.temat}]`;
  return out;
}

// ── Pełny zapis detekcji ────────────────────────────────────────────────────
// det = znormalizowane pola zrodlo_* (z analyzeCall albo extractZrodlo).
// Zapisuje zdarzenie do lead_zrodla_poznania, dopasowuje film (gdy opisany)
// i denormalizuje "Skąd nas zna" na Leady B2C / kontakty_organic.
// onlyFillEmpty: backfill nie nadpisuje kolumny ustawionej przez żywą ścieżkę.
// Nigdy nie rzuca — zwraca {saved, match} albo {saved:false}.
async function zapiszZrodloPoznania(supabase, { telefon, det, via, logZmianId, leadPhone, kontaktOrganicId, leadyTable, onlyFillEmpty }) {
  try {
    if (!det?.zrodlo_poznania || !telefon) return { saved: false };
    const match = det.film_opis
      ? await matchFilm(supabase, det.film_opis, { zrodloKod: det.zrodlo_poznania })
      : { kandydaci: [], film_format: null, temat: null };

    const { error: insertErr } = await supabase.from('lead_zrodla_poznania').insert({
      telefon: String(telefon),
      zrodlo_kod: det.zrodlo_poznania,
      obserwuje: det.zrodlo_obserwuje === true,
      cytat: det.zrodlo_cytat || null,
      film_opis: det.film_opis || null,
      film_kandydaci: match.kandydaci.length ? match.kandydaci : null,
      film_format: match.film_format,
      wykryto_via: via || 'zadarma',
      log_zmian_id: logZmianId || null,
    });
    // 23505 = duplikat log_zmian_id (re-run backfillu) — detekcja już jest,
    // nie dublujemy i nie ruszamy kolumny.
    if (insertErr) {
      if (insertErr.code !== '23505') console.warn('lead_zrodla_poznania insert:', insertErr.message);
      return { saved: false };
    }

    const skad = buildSkadNasZna(det, match);
    if (skad && leadPhone != null) {
      let q = supabase.from(leadyTable || 'Leady B2C').update({ 'Skąd nas zna': skad }).eq('Phone number', leadPhone);
      if (onlyFillEmpty) q = q.is('Skąd nas zna', null);
      const { error } = await q;
      if (error) console.warn('Skąd nas zna (lead) update:', error.message);
    } else if (skad && kontaktOrganicId != null) {
      let q = supabase.from('kontakty_organic').update({ skad_nas_zna: skad }).eq('id', kontaktOrganicId);
      if (onlyFillEmpty) q = q.is('skad_nas_zna', null);
      const { error } = await q;
      if (error) console.warn('skad_nas_zna (kontakt) update:', error.message);
    }
    return { saved: true, match, skad };
  } catch (err) {
    console.warn('zapiszZrodloPoznania nie powiodło się:', err.message);
    return { saved: false };
  }
}

module.exports = {
  ZRODLA_KODY,
  ZRODLO_LABELS,
  ZRODLO_PROMPT_RULES,
  ZRODLO_OUTPUT_FIELDS,
  ZRODLO_FALLBACK,
  normalizeZrodlo,
  extractZrodlo,
  matchFilm,
  catalogLine,
  parseMatchResponse,
  buildSkadNasZna,
  zapiszZrodloPoznania,
};
