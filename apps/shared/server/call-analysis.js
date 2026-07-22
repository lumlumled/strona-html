// ── Analiza rozmowy telefonicznej (GPT) + lejek statusów ────────────────────
// Jedno źródło prawdy dla analizy transkrypcji rozmowy z klientem — używane
// przez webhook Zadarmy (apps/backlog-b2c/server/server.js) ORAZ ręczne
// dodawanie rozmowy (POST /api/rozmowy/reczna, docs/plan-kontakt-karta-
// leada.md). Kod przeniesiony 1:1 z backlogu, żeby prompt/model/lejek nigdy
// się nie rozjechały między automatyczną a ręczną ścieżką.
//
// Port promptu, który wcześniej żył w Make (scenariusz GPT-5 mini analizujący
// transkrypcję) — Antoni podał go 1:1. Jedna świadoma zmiana względem
// oryginału: reguła statusu "Wycena wysłana" wymagała wcześniej TYLKO
// zapowiedzi wysłania ("wysłał LUB obiecał wysłać") — w praktyce łapało to
// też przypadki typu "wyślę ofertę na maila", gdzie nic jeszcze nie zostało
// wysłane. Teraz wymaga potwierdzonego faktu wysłania.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const UMOWA_MODEL = process.env.OPENAI_UMOWA_MODEL || 'gpt-5-mini';

function buildCallAnalysisPrompt(dzisiaj, kierunek, poprzedniOpis, poprzedniaAkcja) {
  const kierunekOpis = kierunek === 'wychodzące'
    ? 'To handlowiec dzwoni do klienta (połączenie wychodzące).'
    : kierunek === 'przychodzące'
      ? 'To klient dzwoni do handlowca (połączenie przychodzące).'
      : 'Kierunek połączenia nieznany — nie zakładaj kto do kogo dzwonił, opieraj się wyłącznie na treści rozmowy.';
  return `Jesteś asystentem CRM firmy LumLum (oświetlenie LED premium).
Analizujesz transkrypcję rozmowy telefonicznej handlowca z klientem.
Zwróć WYŁĄCZNIE jeden obiekt JSON. Bez komentarzy, bez markdownu, bez tekstu przed ani po.

${kierunekOpis}

DZISIAJ: ${dzisiaj}

===== STATUSY =====
Wybierz dokładnie jeden:
- "Po pierwszym tel"
- "Lekko zainteresowany"
- "Przyszłościowy"
- "Zadzwonić jeszcze raz"
- "Wycena wysłana"
- "Sprzedane"
- "Stracony"

===== ZASADY STATUSU =====
Prosi o kontakt w terminie → "Zadzwonić jeszcze raz" + data_feedbacku.
Handlowiec FAKTYCZNIE wysłał wycenę (padł link do wyceny, potwierdzenie że PDF/oferta już poszła na maila, klient potwierdza że dostał) → "Wycena wysłana".
SAMA zapowiedź/obietnica wysłania wyceny w przyszłości ("wyślę panu ofertę", "przygotuję wycenę i prześlę", "dostanie pan wycenę") to NIE jest "Wycena wysłana" — zostaje "Po pierwszym tel" albo "Zadzwonić jeszcze raz" (jeśli padła data kolejnego kontaktu).
Klient zamówił → "Sprzedane".
Niepewny → "Po pierwszym tel".
Jeśli pasuje kilka statusów → wybierz najdalej zaawansowany wg powyższej logiki.

===== ZASADY data_feedbacku =====
Data feedbacku to WYŁĄCZNIE termin kolejnego kontaktu telefonicznego lub umówionej rozmowy.
NIE jest to data żadnego innego zdarzenia jak koniec budowy, odbiór mieszkania, start remontu.

Wypełnij TYLKO gdy w rozmowie pada JEDNOCZEŚNIE:
1. Wyraźny sygnał ponownego kontaktu, np.:
   - "zadzwonię do pana za X"
   - "proszę zadzwonić za X"
   - "możemy się umówić na X"
   - "oddzwonię w X"
   - "kiedy mogę zadzwonić"
   - "umawiamy się na ponowną rozmowę"
   - "wróćmy do tematu za X"
2. ORAZ konkretny termin (data, dzień tygodnia, "za X dni/tygodni/miesięcy")

Samo padnięcie daty lub okresu czasu w innym kontekście NIE wypełnia tego pola.
Przykłady które NIE są data_feedbacku:
- "za miesiąc skończy się etap budowy"
- "remont zaczyna się za dwa tygodnie"
- "odbiór mieszkania jest w przyszłym miesiącu"
- "elektryka będzie za trzy tygodnie"

Przelicz względem DZISIAJ i zwróć w formacie DD.MM.YYYY.
"25-tego" bez miesiąca → najbliższy przyszły taki dzień.
"w piątek" → najbliższy przyszły piątek.
"za tydzień" → +7 dni od dzisiaj.
Brak wyraźnego umówienia kontaktu → null.

===== ZASADY godzina_feedbacku =====
Wypełnij TYLKO gdy przy umówionym kolejnym kontakcie (data_feedbacku) padła
KONKRETNA godzina: "zadzwonię o 15" → "15:00", "umówmy się na 14:30" → "14:30",
"po siedemnastej" → "17:00". Format HH:MM (24h).
Sam dzień bez godziny → null (dzień wystarczy, NIE wymyślaj godziny).
Pory dnia bez konkretu ("rano", "po południu", "wieczorem") → null.
Gdy data_feedbacku = null → godzina_feedbacku też ZAWSZE null.

===== ZASADY opis =====
Zwięzłe podsumowanie najważniejszych informacji z TEJ rozmowy.
Styl: konkretna notatka handlowca, bez lania wody.
Zawiera: czego klient szuka, gdzie montaż, jaki etap projektu, co ustalono, co jest następnym krokiem.
Długość dopasuj do treści, nie pomijaj ważnych rzeczy, nie dodawaj zbędnych.

===== ZASADY skrocony_opis =====
To "żywa pigułka" wiedzy o kliencie — skrócony opis CAŁEGO kontaktu, nie tylko tej rozmowy. Po każdej rozmowie regenerowany od nowa.
DOTYCHCZASOWY SKRÓCONY OPIS (może być pusty — wtedy piszesz pierwszy):
"""
${poprzedniOpis || ''}
"""
Przepisz go na nowo uwzględniając tę rozmowę: zachowaj fakty wciąż aktualne, usuń nieaktualne, dodaj nowe ustalenia.
Maksymalnie 3-4 zdania: czego klient szuka, na jakim etapie jest sprawa, kluczowe konkrety (produkty, metraż, kwoty, terminy), jaki jest następny krok.
BEZ chronologii poszczególnych rozmów i ich dat (od tego jest osobna historia rozmów), bez ogólników.

===== ZASADY KOREKT =====
Jeśli pada korekta (np. "3000K... nie, jednak 4000K") → bierz OSTATNIĄ wartość.
Dotyczy: temperatury, ilości metrów, typu produktu, liczby sztuk.

===== ZASADY najblizsza_akcja =====
To krótka etykieta na zwiniętym case'ie w backlogu — handlowiec ma jednym
rzutem oka widzieć, co KONKRETNIE ma z tym leadem zrobić jako następny krok.
Maksymalnie 5-6 słów, tryb rozkazujący, po polsku, z terminem jeśli padł:
"Zadzwonić jutro 15:00" → jeśli jutro = 12.07, napisz "Zadzwonić 12.07 15:00"
"Zadzwonić w czwartek" → "Zadzwonić czw 16.07"
"Wysłać wycenę SMS-em"
"Doliczyć zasilacz i przesłać wycenę"
Daty względne ("jutro", "za tydzień", "w piątek") ZAWSZE przelicz względem
DZISIAJ na konkretną datę — etykieta będzie czytana także w kolejnych dniach,
"jutro" straciłoby sens.

DOTYCHCZASOWA NAJBLIŻSZA AKCJA (może być pusta):
"""
${poprzedniaAkcja || ''}
"""
Ta rozmowa ją REEWALUUJE:
- w rozmowie umówiono/ustalono nowy następny krok → wpisz nowy
- dotychczasowa akcja została w tej rozmowie WYKONANA lub zdezaktualizowana,
  a nic nowego nie umówiono → null (akcja znika z case'a)
- dotychczasowa akcja NIE dotyczyła tej rozmowy albo nadal jest do zrobienia
  (np. "Wysłać wycenę SMS-em", a wycena wciąż nie wysłana) → przepisz ją dalej
- status "Sprzedane" lub "Stracony" → zawsze null
- brak dotychczasowej akcji i brak konkretnego następnego kroku → null;
  NIE wymyślaj akcji z ogólników ("klient się zastanawia" to nie akcja)

najblizsza_akcja_termin: konkretny moment wykonania akcji, jeśli padł.
Format "DD.MM.YYYY HH:mm" (gdy padła godzina) albo "DD.MM.YYYY" (gdy sam
dzień). Brak konkretnego terminu → null. Gdy akcja to kolejny telefon w
umówionym terminie, termin = data_feedbacku (spójnie).

===== ZASADY zamkniete_dzis =====
To NIE jest "zamknięty case" (sprzedany/stracony na zawsze) — to informacja czy
z tym tematem trzeba jeszcze coś zrobić DZISIAJ, czy nie. Liczy się WYŁĄCZNIE
konkretność ustalenia, NIE odległość w czasie do kolejnego kontaktu — "proszę
zadzwonić jutro" to TAK, jest zaopiekowany na dziś (bo dzisiejsze zadanie z tym
tematem jest zrobione, kolejny krok jest zaplanowany na inny, konkretny dzień).

true gdy:
- status = "Sprzedane"
- status = "Stracony"
- klient jednoznacznie odmówił ("nie jestem zainteresowany", "rezygnuję")
- padła data_feedbacku — KONKRETNY termin kolejnego kontaktu, niezależnie jak
  blisko (nawet "jutro") — bo skoro termin jest ustalony na inny dzień, na dziś
  nic więcej nie trzeba robić
- handlowiec faktycznie wysłał wycenę i klient powiedział że odezwie się sam

false gdy:
- klient prosi o kontakt "później"/"jeszcze dziś" BEZ konkretnej daty czy pory —
  niejednoznaczne, może oznaczać że jeszcze dziś coś z tym tematem się zdarzy
- klient "zastanawia się" bez konkretnej daty
- rozmowa urwana, niejasna, bez konkluzji

===== TYP KLIENTA B2B / B2C =====
Oceń czy klient jest B2B czy B2C na podstawie faktów z rozmowy.

B2B - klient jest profesjonalistą działającym w imieniu swojej firmy lub klientów:
Sygnały B2B (wystarczy jeden wyraźny):
- mówi że jest projektantem wnętrz, architektem, interior designerem
- mówi że jest elektrykiem, instalatorem, wykonawcą, monterem
- mówi że robi dla swojego klienta, dla inwestora, dla projektu
- mówi że ma firmę budowlaną, remontową, wykończeniową
- mówi że szuka rozwiązania do stałej współpracy lub hurtowego zakupu
- pyta o program partnerski, prowizję, rabat dla firm
- mówi że ma wiele realizacji, projektów, budów

B2C - klient kupuje dla siebie:
- robi remont własnego domu, mieszkania
- nie wspomina o firmie ani działaniu w imieniu kogoś innego
- brak sygnałów B2B

Jeśli brak jakichkolwiek sygnałów → domyślnie "B2C".

===== NAZWY I MAPOWANIE PRODUKTÓW =====
Mapuj to co pada w rozmowie na oficjalne nazwy.
Wyciągaj produkty TYLKO jeśli klient lub handlowiec mówi o konkretnych produktach lub ilościach.
NIE wymyślaj produktów jeśli rozmowa jest ogólna.

TAŚMY:
- "cyfrowa / cyfra / digital / COB cyfrowa" → "Cyfrowa taśma COB [temp]K [IP]"
- "analogowa / analog / mono / jednokolorowa" → "Analogowa taśma COB [temp]K [IP]"

TEMPERATURA:
- "ciepła / ciepłe / 3000" → 3000K
- "neutralna / neutralne / 4000" → 4000K
- "zimna / zimne / 6000" → 6000K
- brak info → nie wpisuj temperatury (np. "Cyfrowa taśma COB IP20")

IP - ZAWSZE wpisuj IP w nazwie, nigdy nie pomijaj:
- cyfrowe: brak info → IP20, pada wodoodporna/wodoszczelna/ip65/ip67/łazienka/kuchnia/zewnętrze/elewacja → IP65
- analogowe: brak info → IP20, pada wodoodporna/wodoszczelna/ip65/ip67/łazienka/kuchnia/zewnętrze/elewacja → IP67

STEROWNIKI:
- "sterownik cyfrowy / LumControl / lum control" → "Sterownik LumControl"
- "sterownik mono / V1 / sterownik analogowy / sterownik jednokolor" → "Sterownik analogowy MONO"
- "sterownik kaskadowy / schodowy / na schody" → "Sterownik schodowy PIR" (chyba że pada "laser" → "Sterownik schodowy LASER")
- "sterownik RGB / WT5 / sterownik kolorowy" → "Sterownik analogowy RGB+CCT"
- Jeśli pada sam "sterownik" bez doprecyzowania a wcześniej mówiono o taśmie cyfrowej → "Sterownik LumControl"
- Jeśli pada sam "sterownik" bez doprecyzowania a wcześniej mówiono o taśmie analogowej → "Sterownik analogowy MONO"

ZASILACZE:
- "zasilacz 150W" bez MeanWell → "Zasilacz 150W 24V"
- "zasilacz 75W" → "Zasilacz MeanWell 75W 24V"
- "zasilacz 200W" → "Zasilacz MeanWell 200W 24V"
- "zasilacz 600W" → "Zasilacz MeanWell 600W 24V"
- "zasilacz" bez mocy → "Zasilacz 150W 24V"

PILOTY:
- "pilot / pilot mono / pilot jednostrefowy" → "Pilot MONO 1 strefa"
- "pilot czterostrefowy / pilot 4 strefy / pilot 4-strefowy" → "Pilot MONO 4 strefy"
- "pilot CCT" → "Pilot CCT 1 strefa"
- "pilot RGB / pilot kolorowy" → "Pilot RGB+CCT 1 strefa"

CZUJNIKI:
- "czujniki / czujniki ruchu / PIR / zestaw czujników" → "Zestaw czujników ruchu"
- "czujniki laserowe / laser / zestaw laserowy" → "Zestaw laserowych czujników ruchu"

===== JAKOŚĆ LEADA =====
Oceń jakość leada na podstawie faktów z rozmowy. Nie zgaduj, opieraj się wyłącznie na tym co padło.

GORĄCY, spełnia minimum 2 z poniższych:
- pyta o konkretne ilości (metry, sztuki) potrzebne do jego projektu
- ma potwierdzoną datę montażu w ciągu najbliższych 4 tygodni, lub prace budowlane/wykończeniowe faktycznie trwają w tym momencie (nie "elektryk przyjdzie po wylewkach" bez daty)
- pyta o cenę konkretnego zestawu lub składa zamówienie
- ma wykonawcę wybranego konkretnie do montażu oświetlenia LED (nie ogólnie "mam swojego elektryka")
- wraca po wcześniejszym kontakcie z konkretnymi pytaniami dotyczącymi wyceny lub specyfikacji

ZIMNY, spełnia minimum 2 z poniższych:
- brak projektu lub remont odłożony w czasie (ponad 6 miesięcy lub bez określonej daty)
- nie wie czego chce, pyta bardzo ogólnie o produkt
- porównuje ceny bez zaangażowania w konkretny projekt
- krótka rozmowa bez żadnych konkretów
- niechętny do rozmowy, odpowiada monosylabami

ŚREDNI, wszystko pomiędzy, w tym przypadki gdzie klient ma realny, ale wczesny projekt (np. przygotowana instalacja, ale bez daty montażu i bez znajomości zakresu produktu).

Ważne zasady: posiadanie przygotowanej elektryki/kabli/czujnika samo w sobie nie jest sygnałem gorącym, jeśli klient nie zna terminu ani zakresu zamówienia. Ilość zadanych pytań technicznych nie jest sygnałem temperatury, liczy się treść odpowiedzi (czy padła data, ilość, cena). Kryteria muszą być spełnione dosłownie, nie interpretacyjnie.

uzasadnienie_jakosci: jedno konkretne zdanie, tylko fakty z rozmowy, bez domysłów.

===== ZASADY cena_zaproponowana =====
Wypełnij TYLKO jeśli handlowiec wprost podał kwotę klientowi podczas rozmowy.
Przykłady: "to będzie około 1500 zł", "wycena wychodzi 2200", "cena to 3400 złotych".
Format: "2300 zł"
Brak → null.

===== POCZTA GŁOSOWA =====
"poczta_glosowa": true, gdy nagranie NIE jest rozmową dwóch osób, tylko automatem.
Sygnały (wystarczy jeden):
- komunikat operatora / poczty głosowej: "abonent jest czasowo niedostępny", "nie może teraz odebrać", "zostaw wiadomość po sygnale", "witamy w poczcie głosowej", "połączenie z pocztą głosową", zapowiedź IVR
- sam sygnał, szum albo cisza bez wypowiedzi klienta
- monolog handlowca zostawiającego wiadomość, na który klient ani razu nie odpowiada
Gdy true: NIE wymyślaj ustaleń — status "Po pierwszym tel", opis "Poczta głosowa",
wszystkie pozostałe pola null/puste/false, jakosc_leada bez zmian wobec braku danych → "zimny".
Prawdziwa, choćby krótka wymiana zdań z klientem → false.

===== FORMAT WYJŚCIOWY =====
{
  "status": "",
  "data_feedbacku": "DD.MM.YYYY lub null",
  "godzina_feedbacku": "HH:MM lub null",
  "opis": "",
  "skrocony_opis": "",
  "wycena": "tak lub nie",
  "typ_klienta": "B2B lub B2C",
  "produkty": "",
  "cena_zaproponowana": "XXXX zł lub null",
  "jakosc_leada": "gorący lub średni lub zimny",
  "uzasadnienie_jakosci": "",
  "zamkniete_dzis": true lub false,
  "najblizsza_akcja": "max 5-6 słów lub null",
  "najblizsza_akcja_termin": "DD.MM.YYYY HH:mm lub DD.MM.YYYY lub null",
  "poczta_glosowa": true lub false
}

ZASADY POLA produkty:
- To pole to TWARDY DOWÓD pod wycenę — na jego podstawie handlowiec ma móc
  od razu zrobić klientowi wycenę. Wypełnij je TYLKO gdy handlowiec z
  klientem faktycznie USTALILI w rozmowie konkretne produkty w konkretnych,
  znanych ilościach (liczba metrów, liczba sztuk). Luźne dywagacje,
  orientacyjne pytania o cenę, "około", "jeszcze zmierzy", "musi policzyć"
  → to NIE jest ustalenie, pole zostaje puste.
- Jeśli ilość jest niejasna, ogólnikowa albo w ogóle nie padła — NIE dodawaj
  tego produktu do listy. Żadnych placeholderów typu "? m"/"? szt" —
  niepewny produkt to nie jest produkt z wyceny, to szum. Lepiej nie zapisać
  nic, niż zapisać coś niepewnego.
- NIGDY nie wpisuj tu numeru telefonu ani ceny ("Cena za całość" itp.) —
  telefon i cena mają własne kolumny (cena → pole cena_zaproponowana).
- Format każdej linii: "[ilość][jednostka] [nazwa produktu]" — jednostka
  WYŁĄCZNIE dla taśm (zawsze "m", sklejone z liczbą, np. "10m"). Dla
  wszystkiego innego (sterowniki, zasilacze, piloty, czujniki) sama liczba
  bez jednostki, np. "2 Sterownik LumControl", "1 Pilot MONO 4 strefy".
- Bez myślnika między ilością a nazwą.
- Każdy produkt w osobnej linii (znak \\n między liniami)
- Puste "" jeśli żaden produkt nie ma konkretnej, znanej ilości

Pole wycena: "tak" jeśli handlowiec omawiał konkretne produkty z ilościami lub faktycznie wysłał wycenę. Inaczej "nie".
Pole jakosc_leada: zawsze wypełnione.
Pole typ_klienta: jeśli brak sygnałów B2B → zawsze "B2C".`;
}

// Zastępuje dawne summarizeCall — zamiast samego streszczenia, pełna analiza
// rozmowy (status/data_feedbacku/produkty/kwota/jakość leada/zamknięcie na
// dziś), przeniesiona z promptu, który wcześniej żył w scenariuszu Make.
async function analyzeCall(transcript, { kierunek, dzisiaj, poprzedniOpis, poprzedniaAkcja }) {
  const fallback = { status: null, data_feedbacku: null, godzina_feedbacku: null, opis: transcript ? transcript.slice(0, 200) : null, skrocony_opis: null, produkty: '', cena_zaproponowana: null, jakosc_leada: null, uzasadnienie_jakosci: '', zamkniete_dzis: false, najblizsza_akcja: null, najblizsza_akcja_termin: null, poczta_glosowa: false };
  if (!OPENAI_API_KEY || !transcript) return fallback;
  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: UMOWA_MODEL,
        response_format: { type: 'json_object' },
        reasoning_effort: 'minimal',
        messages: [
          { role: 'system', content: buildCallAnalysisPrompt(dzisiaj, kierunek, poprzedniOpis, poprzedniaAkcja) },
          { role: 'user', content: transcript },
        ],
      }),
    });
    if (!aiRes.ok) return fallback;
    const body = await aiRes.json();
    const content = body.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(content);
    return { ...fallback, ...parsed };
  } catch (err) {
    console.warn('Analiza rozmowy (GPT) nie powiodła się:', err.message);
    return fallback;
  }
}

// Hierarchia statusów leada — status ustawiany automatycznie z analizy
// rozmowy nigdy nie cofa się w dół tego lejka (np. lead z "Wycena wysłana"
// nie wraca na "Po pierwszym tel" tylko dlatego, że ktoś znów zadzwonił i
// GPT błędnie to tak zinterpretował). Oba warianty nazwy "Po pierwszym
// tel(efonie)" widziane w prawdziwych danych — patrz STATUS_COLORS w app.html.
const STATUS_RANK = {
  'Nowy': 0,
  'Lekko zainteresowany': 1,
  'Po pierwszym tel': 1,
  'Po pierwszym telefonie': 1,
  'Nie odebrał': 1,
  'Przyszłościowy': 2,
  'Zadzwonić jeszcze raz': 2,
  'Wycena wysłana': 3,
  'Sprzedane': 4,
  'Stracony': 4,
};

function statusRank(status) {
  return STATUS_RANK[status] ?? 0;
}

// "Nie odebrał" nie idzie przez rangę (patrz statusRank) — to osobny, wąski
// wyjątek: wolno w niego wejść tylko z tych trzech wczesnych statusów (albo
// gdy lead jeszcze nie ma żadnego statusu). Z każdego innego miejsca
// (Zadzwonić jeszcze raz, Wycena wysłana...) nieodebrany telefon zostawia
// status bez zmian.
const NO_ANSWER_ALLOWED_FROM = new Set(['Nowy', 'Po pierwszym tel', 'Po pierwszym telefonie', 'Przyszłościowy']);

// "2300 zł" / "2300" / "~2300 zł" → 2300. Brak liczby → null (nie nadpisuj
// istniejącej Kwoty wyceny przypadkowym zerem).
function parseKwotaZlotych(str) {
  if (!str) return null;
  const digits = String(str).replace(/[^0-9]/g, '');
  return digits ? Number(digits) : null;
}

// ── Data feedbacku: reguły "nie myl handlowca starą datą" ───────────────────
// (docs/plan-watchdog-feedback.md; decyzja Antoniego 2026-07-22). "Data
// Feedbacku" w Leady B2C to "DD.MM.YYYY" w kalendarzu Europe/Warsaw (patrz
// warsawDateStr). Poniższe helpery liczą WYŁĄCZNIE na dacie kalendarzowej —
// północ UTC jako nośnik, bez wpływu DST — i są używane przez webhook Zadarmy
// oraz ręczny panel /rozmowa do:
//   • wyczyszczenia PRZETERMINOWANEGO terminu po ODEBRANEJ rozmowie bez nowego
//     ustalenia (rozmowa "zużyła" termin; pustą datą zaopiekuje się miękki
//     watchdog / feedback_watch, proponując re-kontakt w metadanych);
//   • przesunięcia terminu NIEODEBRANEJ rozmowy na jutro (nigdy w tył).
function parsePlDate(value) {
  const m = String(value || '').trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  // Odrzuć śmieciowe daty ("32.13.2026") — Date przewinęłoby je na inny dzień.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

function formatPlDate(dt) {
  const d = String(dt.getUTCDate()).padStart(2, '0');
  const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
  return `${d}.${mo}.${dt.getUTCFullYear()}`;
}

// Termin "wymagalny" = niepusty i wypadający najpóźniej w dniu rozmowy
// (todayStr też "DD.MM.YYYY"). Przyszły, umówiony termin → false (zostaje).
// Pusta/niepoprawna data → false (nie ma czego czyścić ani przesuwać).
function isPlDateDue(value, todayStr) {
  const dt = parsePlDate(value);
  const today = parsePlDate(todayStr);
  if (!dt || !today) return false;
  return dt.getTime() <= today.getTime();
}

// "DD.MM.YYYY" + n dni → "DD.MM.YYYY" (null przy niepoprawnej dacie wejściowej).
function addPlDays(value, n) {
  const dt = parsePlDate(value);
  if (!dt) return null;
  dt.setUTCDate(dt.getUTCDate() + n);
  return formatPlDate(dt);
}

module.exports = {
  buildCallAnalysisPrompt,
  analyzeCall,
  STATUS_RANK,
  statusRank,
  NO_ANSWER_ALLOWED_FROM,
  parseKwotaZlotych,
  parsePlDate,
  isPlDateDue,
  addPlDays,
};
