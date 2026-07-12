# Plan: systemowy watchdog "temat ucieka" (wyceny / leady / wiadomości)

Stan: WDROŻONE NA PROD (2026-07-12). Etapy a-e zbudowane i zweryfikowane:
migracje 003+004 (+ kom 009) na bazie, backfill 118 wycen + 3 leady (przyszłe
daty), pg_cron `watchdog_feedback` (*/30 6-18 UTC -> /backlog-b2c/api/cron/
watchdog), push przetestowany na żywo. ZREALIZOWANE 2026-07-12 (commit 8caff6b):
cichy watch AI dla leadów Z TRANSKRYPCJĄ rozmowy bez żadnej daty feedbacku
(armLead w watchdog.js + faza armLeady w sweepLeady; zakres zawężony decyzją
Antoniego do leadów z niepustą "Treść rozmowy" - maile/inne kanały pominięte;
na realnej bazie 5 kandydatów, zero ryzyka fali; push cichych leadów wyłączony
na start - tylko panele hub+Backlog). ŚWIADOMIE ODŁOŻONE: cichy watch AI dla
leadów BEZ transkrypcji (inne kanały - odłożone), eskalacja po N dniach od
alertu (v2), Backlog B2B (backlog_target='b2b' tylko logowany), push cichych
alertów leadów (dołożyć po tygodniu, jak zobaczymy wolumen).
Decyzje z §10 potwierdzone przez Antoniego: feedback_watch + kom_commitments
w unii, push inline notifyUser, kategoria alerty_watchdoga, co 30 min 8-20,
cichy termin 2-21 dni.
Zależności: docs/plan-powiadomienia-push.md (kanał push), docs/plan-komunikator-followupy.md (kom_commitments), docs/plan-wlasnosc-zasobow.md (owner)

## 1. Po co

Żaden temat z klientem nie może uciec - od pierwszego kontaktu leada, przez wycenę,
po zamówienie. Watchdog pilnuje każdego miejsca, gdzie ktoś (my albo klient) miał
się odezwać / coś zrobić, a tego nie robi:

- WYCENA - główny przypadek. Wycena ma własny rytm feedbacku, inny niż lead
  (wysłałem wycenę -> cisza 8 dni -> trzeba zadzwonić), a i tak ma lead_id/kontakt.
- LEAD - ma już widoczną "Data Feedbacku" + "Najbliższa akcja"; watchdog jest
  warstwą NAD tym (alert, gdy termin minął i nic się nie dzieje), nie duplikatem.
- WIADOMOŚĆ - obietnice z komunikatora ("oddzwonię", "prześlę jutro") -
  zasilają kom_commitments (tabela istnieje od 001_init.sql, dotąd bez kodu).

## 2. Zasada działania (uzgodniona z Antonim)

Watchdog siedzi NA OBIEKCIE, nie globalnie. Każdy obiekt ma własny termin feedbacku.

Dwie ścieżki ustawienia terminu:

1. **Jawna przesłanka** z rozmowy (Zadarma) / wiadomości / notatki
   ("odezwę się za tydzień", "decyzja po świętach") -> termin = ta data,
   `visible = true`, pokazywany normalnie w panelu.
2. **Brak przesłanki** -> AI ocenia "temperaturę" tematu (kwota, etap, ile było
   kontaktu, ton) i samo ustawia termin (np. 1 albo 2 tygodnie). `visible = false` -
   cichy watchdog, siedzi tylko w metadanych, NIE pokazuje się jako data feedbacku.

**Wyzwolenie alertu:** termin minął ORAZ zero aktywności na obiekcie od momentu
ustawienia terminu (brak nowej rozmowy / wiadomości / zmiany etapu / edycji)
-> AI generuje jednozdaniowy alert, np.
"Wysłałeś wycenę #123 do Jana K., 8 dni cisza - warto się odezwać."

Jeśli aktywność BYŁA po ustawieniu terminu, ale termin i tak minął -> bez alertu;
watch zamykamy (`resolution='activity'`) i cicho re-ewaluujemy (nowa ocena AI
albo nowa jawna data z tej aktywności).

**Routing alertu** (owner alertu = owner wyceny/leada; wiadomości = dziś Antoni):
- panel główny hub "Do zrobienia dziś" (nowa sekcja "Alerty"),
- push do ownera (istniejący `notifyUser` z apps/shared/server/push.js),
- Backlog - plan dnia (umowa-draft): do Backlogu B2C albo B2B wg źródła
  (`_zrodlo` wyceny / źródło leada). B2B jeszcze nie istnieje - placeholder:
  pole `backlog_target` na alercie, rozgałęzienie w routingu, b2b dziś tylko logowane.

## 3. Co już istnieje i jak się wpinamy (NIE dublujemy)

| Istnieje | Gdzie | Rola w watchdogu |
|---|---|---|
| `Data Feedbacku` + `Godzina Feedbacku` + `Najbliższa akcja` (+ termin/owner) | Leady B2C, pisane przez RPC `app_update_leady_notatka` / `app_update_leady_after_call` (apps/backlog-b2c/server/scripts/add-godzina-feedbacku.js) | źródło prawdy jawnego terminu leada; watchdog NIE kopiuje ręcznie - trigger Postgres mirroruje do feedback_watch |
| `analyzeNotatka` / `analyzeCall` (gpt-5-mini, JSON, daty względne liczone od DZISIAJ w prompt) | apps/shared/server/leady-endpoints.js:116-188, apps/backlog-b2c/server/server.js:464-734 | wzorzec ekstraktora; dla wycen robimy analogiczny `analyzeWycenaFeedback` |
| `warsawParts`/`warsawDateStr` (Europe/Warsaw przez Intl.DateTimeFormat) | apps/shared/server/leady-endpoints.js:69-86 | jedyny wzorzec konwersji dat; względne -> absolutne zawsze od now() Warsaw |
| `Log zmian` (aktywność leada, zrodlo) + `Historia rozmów` | leady-endpoints.js:57, trigger trg_log_zmian_from_leady | reguła "brak aktywności" dla leada |
| `wyceny` + `wyceny_events` (wycena.created/edited, form.*, mail.sent, invoice.paid, ...) | apps/shared/migrations/002_wyceny_init.sql:134, wpisy: wyceny-endpoints.js + wyceny-pipeline.js | reguła "brak aktywności" dla wyceny + hooki ekstraktora |
| `_zrodlo` wyceny (b2c/wiadomosci/b2b/nieprzypisane) - liczone, nie kolumna | wyceny-endpoints.js:90-141 (`categorizeWyceny`) | routing B2C/B2B alertu |
| `kom_commitments` (tabela-widmo: schema jest, zero kodu) + plan follow-upów | apps/komunikator/migrations/001_init.sql:69-83, docs/plan-komunikator-followupy.md Etap 3 | obietnice z wiadomości; watchdog czyta je w unii z feedback_watch (patrz §4) |
| `kom_messages`/`kom_threads.last_message_at` | apps/komunikator | aktywność wątku/klienta |
| Push: `notifyUser`, push_subscriptions, sw.js, topbar - WDROŻONE; `push_outbox` + dispatcher - tylko PLAN | apps/shared/server/push.js | watchdog wysyła push inline przez notifyUser (dispatcher watchdoga to i tak Node); gdy powstanie push_outbox, podmiana producenta w jednym miejscu |
| Backlog plan dnia (umowa-draft 05:00) + podsumowanie dnia (21:00), kategorie `nowe/wyceny_z_feedbackiem/inne_z_feedbackiem/nieodebrane` | apps/backlog-b2c/server/server.js:2149, 2367 | alerty wpadają do planu dnia jako nowa kategoria `alerty_watchdoga` |
| Hub "Do zrobienia dziś" `GET /api/dzisiaj` (akcje + feedbacki per owner) | apps/hub/server/server.js:151 | nowa sekcja "Alerty" z otwartych alertów watchdoga |
| Wzorzec crona poza vercel.json: pg_cron + pg_net -> publiczny route `/api/cron/*` | apps/formularz/server/server.js:235 (worker wycen) | dispatcher watchdoga tak samo (Vercel Hobby: nie dokładamy cronów do vercel.json!) |

## 4. Model danych - decyzja: JEDNA tabela `feedback_watch`

```sql
create table feedback_watch (
  id bigserial primary key,
  object_type text not null check (object_type in ('wycena','lead')),
  object_id text not null,                  -- wyceny.id (int jako text) / "ID Leada"
  owner text,                               -- app_users.name (Antoni/Lorenzo)
  due_at timestamptz not null,              -- termin feedbacku
  reason text,                              -- skąd termin: cytat przesłanki albo uzasadnienie AI
  set_by text not null check (set_by in ('ai','human')),
  visible boolean not null default false,   -- true = jawna data w panelu; false = cichy watchdog
  source text,                              -- 'rozmowa'|'notatka'|'edytor'|'mirror_lead'|'ai_temperatura'
  backlog_target text not null default 'b2c' check (backlog_target in ('b2c','b2b')),
  baseline_at timestamptz not null default now(),  -- moment ustawienia; aktywność PO nim kasuje alert
  alert_text text,                          -- wygenerowany alert (null = jeszcze nie alertowano)
  alerted_at timestamptz,
  resolved_at timestamptz,
  resolution text check (resolution in ('activity','done','cancelled','superseded')),
  created_at timestamptz not null default now()
);
create unique index feedback_watch_open_uq
  on feedback_watch (object_type, object_id) where resolved_at is null;
create index feedback_watch_due on feedback_watch (due_at) where resolved_at is null;
```

**Dlaczego jedna tabela, a nie kolumny per obiekt:**
- `wyceny` nie ma żadnych kolumn feedbacku i nie chcemy poszerzać już bardzo
  szerokiej tabeli (60+ kolumn); watch ma własny cykl życia (open -> alerted ->
  resolved), którego kolumny nie udźwigną bez 5-6 nowych pól na każdej tabeli.
- dispatcher skanuje JEDNO miejsce (`due_at < now() and resolved_at is null`),
  jeden routing, jedno dedupe - zamiast trzech różnych zapytań i trzech semantyk.
- "cichy" wpis AI nie może być kolumną obok jawnej daty - musiałby mieć drugą
  parę kolumn (termin + visible + reason + baseline...) na każdej tabeli.
- lead zachowuje `Data Feedbacku` jako źródło prawdy (nic się nie zmienia dla
  istniejących flow) - trigger tylko mirroruje do watcha.

**Wyjątek - wiadomości:** obietnice z komunikatora NIE idą do feedback_watch,
tylko ożywiają `kom_commitments` (dokładnie wg docs/plan-komunikator-followupy.md
Etap 3 - opis, owner my/klient, due_at, dedupe). Dispatcher watchdoga czyta
UNIĘ: `feedback_watch` (wyceny+leady) + `kom_commitments` (status='open',
due_at < now()). Dzięki temu nie dublujemy planu follow-upów, a komunikator
dostaje swoją funkcjonalność "przy okazji". `object_type='wiadomosc'` nie istnieje
w feedback_watch - celowo, jedna prawda per domena.

### Skąd biorą się wpisy

| Ścieżka | object | set_by / visible | Mechanizm |
|---|---|---|---|
| Jawna data z edytora wyceny (nowa sekcja "Feedback") | wycena | human / true | POST/PUT /api/wyceny zapisuje watch |
| Jawna przesłanka z rozmowy/notatki leada powiązanego z wyceną | wycena | ai / true | hook po analyzeCall/analyzeNotatka, gdy lead ma otwartą wycenę |
| Brak przesłanki po wysłaniu/edycji wyceny | wycena | ai / false | `analyzeWycenaFeedback` (temperatura: kwota, etap, liczba kontaktów, ton komentarza) po eventach wycena.created / form.link_sent / mail.sent |
| `Data Feedbacku` leada (dowolna ścieżka zapisu: webhook, notatka, ręczna edycja) | lead | human|ai / true | trigger Postgres na Leady B2C: zmiana "Data Feedbacku"/"Godzina Feedbacku" -> upsert otwartego watcha (supersede starego) |
| Lead aktywny bez żadnej daty feedbacku | lead | ai / false | etap (e); AI temperatura jak przy wycenie |
| Obietnica z wiadomości | kom_commitments | ai|manual | ekstraktor LLM po wiadomości in/out (plan follow-upów Etap 3) |

## 5. Reguła "brak aktywności" (per typ)

Aktywność liczona ZAWSZE względem `baseline_at` watcha:

- **wycena:** dowolny `wyceny_events` z `created_at > baseline_at`
  LUB `wyceny.updated_at > baseline_at` (edycja) LUB - gdy wycena ma lead_id -
  aktywność leada (patrz niżej). Wysłana wycena, na którą klient odpowiedział
  telefonem, nie może alertować.
- **lead:** wpis w `Log zmian` z `data_zmiany > baseline_at` (dowolne zrodlo -
  notatka i ręczna edycja też są "życiem" tematu).
- **wiadomość (kom_commitments):** `kom_messages.created_at > commitment.created_at`
  w wątku/kliencie; dodatkowo semantyka z planu follow-upów: owner='klient'
  zamyka odpowiedź klienta, owner='my' zamyka moja wysłana wiadomość.

Aktywność wykryta przez dispatcher -> `resolved_at=now(), resolution='activity'`
+ cicha re-ewaluacja (nowy watch AI, jeśli obiekt nadal otwarty).

## 6. Ekstraktor terminu + auto-ocena AI

Jeden moduł `apps/shared/server/watchdog.js`:

- **`extractFeedbackTermin(tekst, dzisiaj)`** - jawna przesłanka. Dla leadów już
  istnieje (analyzeNotatka/analyzeCall zwracają data_feedbacku) - NIE piszemy
  drugiego; hook konsumuje ich wynik. Dla wyceny/komentarza: ten sam wzorzec
  (gpt-5-mini, `response_format: json_object`, `reasoning_effort: 'minimal'`,
  daty względne liczone w prompcie od `DZISIAJ = warsawDateStr()`).
- **`ocenTemperature(obiekt)`** - cichy termin, gdy brak przesłanki. Wejście:
  kwota_proponowana_brutto, status/process_stage, liczba eventów/kontaktów,
  ton opisu/komentarza, wiek wyceny. Wyjście JSON:
  `{ due_days: 3|7|14, reason: "..." }` (twarde widełki 2-21 dni, clamp w JS -
  AI nie może ustawić terminu za rok). Zapis: `set_by='ai', visible=false,
  source='ai_temperatura'`.
- Konwersja due_days -> `due_at` w JS od now() (Europe/Warsaw, godzina 09:00
  dnia docelowego), NIE w AI.

## 7. Dispatcher + alerty

- **Route:** `app.all('/api/cron/watchdog')` w apps/backlog-b2c/server/server.js
  (ma dostęp do leadów, wycen przez shared i klienta Supabase), autoryzacja jak
  istniejące crony (`isCronAuthorized`), publiczny prefix `/api/cron/` już jest.
- **Harmonogram:** Supabase **pg_cron + pg_net** (wzorzec workera wycen),
  co 30 min w godz. 8-20 Europe/Warsaw. NIE dotykamy vercel.json (Hobby:
  częstszy cron = cichy brak deployu z pusha!).
- **Przebieg:** pobierz otwarte watche z `due_at < now()` + otwarte przeterminowane
  kom_commitments -> dla każdego sprawdź aktywność (§5) -> aktywność: resolve +
  re-ewaluacja; cisza: wygeneruj `alert_text` (gpt-5-mini, jedno zdanie po polsku,
  kontekst: obiekt, dni ciszy, kwota, imię) -> `alerted_at=now()` -> push
  `notifyUser(owner_user_id, { title, body: alert_text, url: link do obiektu })`.
- **Dedupe:** `alerted_at is not null` -> nie alertuj drugi raz. Alert żyje do
  resolve (aktywność / ręczne "zrobione"). Eskalacja po N dniach = v2.
- **Odczyt alertów:** `GET /api/watchdog/alerty` (shared, filtr per owner jak
  w hubie) - konsumowane przez hub i Backlog.

## 8. Routing do paneli

- **Hub "Do zrobienia dziś":** rozszerzenie `GET /api/dzisiaj` o sekcję `alerty`
  (otwarte, alerted, owner usera; admin widzi bez ownera). UI: nowa lista nad
  "feedbacki", czerwona kropka.
- **Backlog plan dnia:** w cronie umowa-draft dołóż wejście "ALERTY WATCHDOGA"
  (tylko `backlog_target='b2c'`) i nową kategorię `alerty_watchdoga` w JSON planu
  (cap 8 jak inne, `KATEGORIA_LP_ORDER` + UI app.html + prompt). Podsumowanie dnia
  (21:00) automatycznie raportuje zamknięte/niezamknięte, bo liczy z planu.
- **B2B:** `backlog_target` liczony z `_zrodlo` wyceny (`categorizeWyceny`) /
  źródła leada; `b2b` dziś tylko logOperation (Backlog B2B nie istnieje) -
  rozgałęzienie gotowe na przyszłość.
- **Wyceny/karta leada (UI):** w edytorze wyceny sekcja "Feedback" (data + widok
  cichego terminu AI z powodem, przycisk "wycisz watchdoga" = resolve 'cancelled');
  chip na liście wycen gdy alert otwarty.

## 9. Kolejność budowy (przyrostowo, commit po każdym kawałku)

a) **Model danych + jawny termin wyceny:** migracja `feedback_watch`
   (apps/shared/migrations/003_feedback_watch.sql), sekcja "Feedback" w
   wycena-editor.js, zapis watcha w POST/PUT /api/wyceny, endpoint odczytu.
b) **Ekstraktor + temperatura:** watchdog.js (extract + ocena), hooki po
   eventach wyceny i po analyzeCall/analyzeNotatka (lead z otwartą wyceną).
c) **Dispatcher + Backlog:** /api/cron/watchdog + pg_cron/pg_net, generowanie
   alertów, GET /api/watchdog/alerty, kategoria w planie dnia + UI Backlogu.
d) **Push:** notifyUser w dispatcherze (mapowanie owner -> app_users.id).
e) **Leady i wiadomości:** trigger mirrorujący Data Feedbacku, cichy watch dla
   leadów bez daty, ożywienie kom_commitments (ekstraktor obietnic wg planu
   follow-upów) + unia w dispatcherze + sekcja alertów w hubie.

Walidacja na każdym etapie: `node --check`, boot serwerów lokalnie, zapytania
na realnej bazie przed commitem; prod sprawdzać na lumlum.dev (nie tylko lokalnie).

## 10. Decyzje do potwierdzenia przez Antoniego

1. Jedna tabela `feedback_watch` dla wycen+leadów, wiadomości przez ożywione
   `kom_commitments` (unia w dispatcherze) - OK?
2. Push inline przez istniejący `notifyUser` (bez budowy push_outbox teraz) - OK?
3. Backlog: nowa kategoria `alerty_watchdoga` w planie dnia (a nie dosypywanie
   do `wyceny_z_feedbackiem`) - OK?
4. Cadence dispatchera: co 30 min, 8-20 Warsaw - OK?
5. Widełki cichego terminu AI: 2-21 dni (typowo 3/7/14) - OK?

## 11. Decyzje Antoniego 2026-07-12 (wdrożone w osobnym czacie — NIE cofać)

Kontekst: przypadek Czesława Prostak (wycena 1695 / lead 97) — termin z
komentarza wyceny nie był widoczny na leadzie, a wycena wisiała na karcie
leada tylko po dopasowaniu telefonu (lead_id=null).

1. **Feedback wyceny wchodzi na leada.** Kontaktujemy się z człowiekiem, nie
   z wyceną: `applyFeedbackDue` po `setWatch` woła `propagateFeedbackToLead`
   (wyceny-endpoints.js) — zapis "Data Feedbacku" leada, gdy wycena ma
   lead_id. Reguła: wygrywa najbliższy AKTUALNY termin (pustą, przeterminowaną
   lub późniejszą datę leada nadpisujemy; wcześniejszej dzisiejszej/przyszłej
   nie ruszamy). Nadpisanie czyści "Godzina Feedbacku". Kierunek TYLKO
   wycena->lead — watch leada dalej robi trigger mirrorujący z etapu (e).
   Wyłączenie watcha wyceny NIE czyści daty leada.
2. **Wycena przypięta do leada przejmuje ownera leada** (jeden właściciel
   tematu; jawna zmiana ownera przez admina w tym samym zapisie wygrywa).
   POST/PUT /api/wyceny; przy przypięciu bez nowego feedback_due
   `adoptWatchAfterAssign` przepisuje ownera otwartego watcha i propaguje
   jego termin na leada.
3. **Kanoniczny format `wyceny.lead_id`**: liczba całkowita jako tekst
   ("314", nigdy "314.0" — "ID Leada" to numeric i potrafi tak przyjść).
   Znormalizowane w /api/wyceny/szukaj-leada.
4. **Backfill wykonany** (scripts/backfill-wyceny-lead-id.js): 41 wycen
   spiętych (28 z legacy "Leady B2C"."ID" = '#<id>', 13 po tel/mailu
   jednoznacznie), 20 otwartych WYCEN przejęło ownera leada (zamówienia /
   zamknięte celowo nietknięte — owner sprzedaży zasila statystyki),
   ownery już otwartych watchy wyrównane do ownerów wycen (18 szt.).
   KONFLIKT do ręcznej decyzji Antoniego: wycena 1868 — legacy "ID" i kwota
   wskazują leada 314 (Krzysztof Mróz), telefon wyceny należy do leada 373
   (Grzegorz Kurzacz); nie przypisano.
5. Prostak naprawiony ręcznie: lead_id=97, owner Lorenzo, jawny watch human
   10.07 (superseduje cichy AI 19.07), "Data Feedbacku" leada = 10.07.2026.
