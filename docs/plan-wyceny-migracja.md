# Wyceny 2.0: pełna migracja mechanizmu wycen z Make do lumlum.dev

Data: 2026-07-11. Stan: PLAN (brief do wdrożenia etapami).
Źródło audytu: folder `~/Downloads/Wyceny - mechanizm` (10 blueprintów Make,
formularz.liquid, CSV arkuszy) + LOGIKA_WYCEN.txt + 02_CENNIK_I_LOGIKA_WYCEN.txt.

## Po co

Cały mechanizm wycen (dodanie wyceny -> formularz dla klienta -> zamówienie ->
wysyłka InPost -> faktura inFakt -> sprawdzenie płatności/dostawy -> fulfillment)
działa dziś na 8+ scenariuszach Make z triggerem w Telegramie, Google Sheets jako
bazą i Baselinkerem jako "klejem". Ma działać w naszym panelu na lumlum.dev,
na Supabase, bez Telegrama, bez Baselinkera i bez Make. Priorytet: **stabilność**
- obecny system działa, więc przełączamy etapami (strangler pattern), cutover
formularza w nocy, wszystko przetestowane wcześniej na case'ach testowych.

## Jak to działa dziś (audyt blueprintów)

| Scenariusz Make | Co robi | Czym zastępujemy |
|---|---|---|
| #1 Dodanie casów do CRM (+wariant "B2B") | Telegram (tekst/głosówka -> Whisper) -> GPT parser -> dedupe po message_id -> szukanie case'a po tel/mailu -> nowy wiersz albo GPT-merge w Sheets CRM_CASES + kopia do arkusza Lorenzo | Panel: szybkie dodanie + pełny edytor wyceny |
| #2 Wysłanie linku do formularza | Watch na arkuszu -> Telegram z linkiem `lumlum.co/pages/formularz?id=XXXX` | Przycisk/link na karcie wyceny w panelu |
| Formularz na lumlum - GET | Webhook -> filterRows po ID -> zwraca produkty, kwotę, rabat, rabat24h, prefill | `GET /api/formularz` czytający z Supabase |
| Formularz LumLum - POST | Webhook z formularza -> update wiersza -> Baselinker createOrder (+ujemna pozycja "Rabat") -> routing pobranie/przelew x kurier/paczkomat x firma/prywatna -> ShipX/etykieta -> inFakt faktura (+szybka płatność przy przelewie) -> PDF na Drive -> mail -> Telegram | `POST /api/formularz` + własny pipeline zamówienia (maszyna stanów) |
| #2 Shopify draft order, inpost + infakt | To samo co POST, ale odpalane ręcznie ze statusu ZAMÓWIENIE w arkuszu (sprzedaż bez formularza) | Przycisk "Realizuj zamówienie" na karcie wyceny -> ten sam pipeline |
| #3 Wywołanie auto PAID | Webhook z inFakt (opłacona faktura/proforma) -> wysyłka (kurier/paczkomat), faktura końcowa, delete proformy, KSeF, mail | Webhook inFakt -> nasz endpoint -> ten sam pipeline |
| #4 Sprawdzenie dostawy | Cron: status Send -> tracking ShipX -> po doręczeniu (pobranie) faktura VAT z proformy, KSeF, status Baselinker | Worker (pg_cron -> endpoint) na tabeli shipments |
| #5 Fulfillment + Przesyłka nadana | Statusy w Baselinker + Notion, przenoszenie plików na Drive, wpisy do arkusza wysyłek | Statusy w naszej bazie; Notion/arkusz wysyłek - patrz pytania otwarte |

Kluczowe ustalenia z audytu:

- **Parser GPT** (gpt-5-mini) jest bardzo dopracowany: struktura wyjściowa
  z `type` (WYCENA/ZAMÓWIENIE/NOTATKA), `items[]` (name, SKU, quantity, price,
  VAT, image_url), `items_json`, ceny (catalog/offered/final), `rabat24h_kwota`
  + `rabat24h_wazny_do` (fraza "rabat 24h" + kwota -> ważny 24h), `quote_mode`
  (NEW / REPLACE_EXISTING - steruje merge'em), normalizacja tel/mail, reguła
  stref/pomieszczeń (nigdy nie są produktami), reguła "opcjonalnie".
  **Prompty przenosimy 1:1** z dwiema zmianami: wycinamy wymóg słowa "wycena"
  (decyzja Antoniego: już niepotrzebne) i telegram-izmy (message_id, głosówki
  jako osobna ścieżka - w panelu jest jedno pole tekstowe).
- **Rabat 24h** siedzi w scenariuszu nazwanym "B2B", ale to NIE jest B2B -
  to wariant scenariusza #1 z obsługą rabatu 24h (mechanizm "u Lorenzo").
  Formularz pokazuje baner z odliczaniem i odejmuje kwotę, jeśli rabat aktywny
  (`rabat24h_wazny_do` w przyszłości). Przenosimy w całości.
- **Baselinker robi tylko dwie rzeczy**: (a) trzyma zamówienie, żeby dodać
  ujemną pozycję "Rabat" (addOrderProduct z ceną ujemną) - potrzebne tylko,
  żeby faktura się sumowała; (b) zamawia kuriera InPost (createPackage
  `inpostkurier` + getLabel). Paczkomat i tak idzie bezpośrednio przez ShipX.
  Stąd dzisiejsza niespójność "kurier w web trackerze, paczkomat w Menedżerze
  Paczek". Po migracji OBA przez ShipX API -> wszystko w jednym miejscu.
- **InPost ShipX** (org 122150): paczkomat = `POST /v1/organizations/122150/shipments`
  service `inpost_locker_standard`, `sending_method: dispatch_order`,
  `target_point` z formularza (Geowidget); etykieta
  `GET /v1/shipments/{id}/label?format=pdf`; tracking `GET /v1/tracking/{nr}`.
  Kurier po migracji: to samo API, service `inpost_courier_standard`
  (+ COD i insurance w polach shipmentu przy pobraniu).
- **inFakt API v3**: async invoices (`POST /async/invoices.json` -> polling
  statusu -> uuid), PDF, `quick_payments` (szybki link płatności przy przelewie),
  `send_to_ksef`, DELETE proformy po opłaceniu, webhook "opłacona" (dziś hook
  Make w #3). Konto na fakturze: PKO BP 73 1020 3466 0000 9902 0225 5784.
- **Formularz liquid** (~2600 linii, strona `lumlum.co/pages/formularz?id=`):
  GET po dane (produkty, suma, rabat, rabat24h, prefill mail/tel), Geowidget
  InPost (parcelcollect), pobranie/przelew (pobranie blokowane poza PL),
  faktura firmowa/prywatna, walidacje, thank-you z danymi do przelewu.
  POST wysyła pola formularza + `form_status: SUBMITTED` + `form_submitted_at`.
  **Zostaje wizualnie bez zmian** - podmieniamy tylko dwa URL-e
  (ORDER_GET/ORDER_POST z hook.eu1.make.com na lumlum.dev).
  UWAGA: dziś webhook GET Make zwraca `form_status: "NEW"` NA SZTYWNO,
  a blokada po wysłaniu (`state.locked`) żyje tylko w pamięci przeglądarki -
  po odświeżeniu ten sam link znów jest aktywnym formularzem. Decyzja
  Antoniego (2026-07-11): formularz ma być jednorazowy - patrz niżej.
- **Sheets**: CRM LumLum 2.0 / CRM_CASES (76 kolumn - pełny stan pipeline:
  process_stage, shipment_id, tracking, invoice_*, PAID, lock_token, form_*,
  rabat24h_*) + kopia "Wyceny B2C" u Lorenzo (13 kolumn) + arkusz wysyłek.
  Kolumny CRM_CASES to gotowa specyfikacja naszego schematu.
- **⚠️ Sekrety w blueprintach**: klucz API inFakt i długoważny Bearer InPost
  są zaszyte na twardo w eksportach JSON. Po migracji OBA rotujemy i trzymamy
  w env vars Vercela.

## Co wycinamy, co zostaje

Wycinamy (decyzje Antoniego 2026-07-11): Telegram (trigger i powiadomienia),
Baselinker (zamówienia, kurier, statusy), Make (wszystkie scenariusze),
Google Sheets jako baza (zostaje archiwum read-only), słowo-klucz "wycena",
rozgałęzienie głosówka/tekst, routery-kopie (firma/prywatna x kurier/paczkomat
x płatność = dziś ~20 prawie identycznych gałęzi -> u nas jedna funkcja
z parametrami), **Notion** (służył optymalizacji leadów - wygaszamy),
**kopia wycen do arkusza Lorenzo** (Lorenzo widzi wyceny w panelu per owner).

Zostaje: InPost ShipX (kurier + paczkomat, jedno API - wszystkie przesyłki
widoczne w Menedżerze Paczek, koniec z rozjazdem web tracker / Menedżer),
inFakt (faktury, proformy, szybkie płatności, KSeF, webhook opłacenia),
formularz liquid w niezmienionej formie wizualnej, rabat 24h, Geowidget,
logika parsera GPT, maile do klienta (przez Gmail API - wysyłkę z panelu
już mamy w komunikatorze, skrzynka kontakt@lumlum.co), **Google Drive
na PDF-y faktur** (jak dziś - Antoni potwierdził, że chce kopię u siebie).

### Wysyłka zagraniczna = Furgonetka (nowe, decyzja 2026-07-11)

Furgonetki nie ma w blueprintach, bo służy do wysyłek zagranicznych
(obsługiwane dotąd poza tym mechanizmem). Wchodzi do pipeline jako drugi
provider:

- **Routing**: InPost wymaga polskiego numeru telefonu odbiorcy
  (powiadomienia SMS), więc reguła jest podwójna: kraj dostawy != PL
  **LUB brak polskiego numeru** -> **API Furgonetki**; w pozostałych
  przypadkach (PL + polski numer) -> InPost ShipX. Formularz przy braku
  polskiego numeru nie pokazuje opcji paczkomatu.
- **Flat fee za wysyłkę zagraniczną**: kwota konfigurowalna, na start
  50 zł, doliczana do sumy. Musi być WIDOCZNA w podsumowaniu formularza
  od razu po zmianie kraju na != PL (mała zmiana w liquid - wiersz
  "Wysyłka zagraniczna" w podsumowaniu; inaczej klient widzi inną kwotę
  niż zapłaci) i jako pozycja na fakturze.
- Formularz już dziś wspiera zagranicę częściowo: select kraju, pobranie
  automatycznie blokowane poza PL, paczkomat tylko PL. W Make gałąź
  "Wysyłka nie do Polski" kończyła się fakturą bez zamówienia przesyłki
  (ręczna wysyłka) - u nas domyka ją Furgonetka.
- Do przygotowania: konto API Furgonetki (OAuth2), wybór usług kurierskich
  per kraj, mapowanie etykiety/trackingu do wyceny_shipments (provider:
  'shipx' | 'furgonetka').

### Formularz jednorazowy (nowe, decyzja 2026-07-11)

Formularz wizualnie zostaje jaki jest ("podoba mi się jak wygląda"),
ale link ma być jednorazowy:

- nasz GET zwraca PRAWDZIWY `form_status` z bazy (Make hardkoduje "NEW"),
- liquid dostaje jeden dodatkowy stan: jeśli `form_status != NEW` ->
  zamiast formularza ekran "Zamówienie zostało już złożone" (bez danych
  osobowych, bez możliwości ponownej wysyłki),
- POST po stronie serwera też odrzuca zapis, gdy wycena ma już SUBMITTED
  (ochrona przed double-submit i race'em dwóch kart),
- odblokowanie linku (np. klient pomylił adres) = akcja na karcie wyceny
  w panelu ("Otwórz formularz ponownie" -> status wraca do NEW, historia
  poprzedniego submitu zostaje w wyceny_events).

## Architektura docelowa

- **Nowa apka `apps/wyceny/`** w monorepo (wzór: apps/crm) + wpis w hubie.
  Trzy widoki:
  1. **Wyceny** - lista/arkusz wycen (to co dziś w CRM Lorenzo "Wyceny B2C"),
     filtrowanie po statusie, ownerze, karta wyceny z pełnym pipeline
     (status formularza, wysyłka, faktura, płatność, tracking).
  2. **Dodaj / edytuj wycenę** - pełny edytor: pozycje z cennika SKU
     (podpowiadanie z tabeli sku), ilości, ceny, rabat kwotowy, rabat 24h,
     dane kontaktowe, link do formularza. Edycja działa też PO wysłaniu
     linku - formularz zawsze czyta aktualny stan z bazy.
  3. **Szybkie dodanie** - jedno pole tekstowe (odpowiednik wiadomości
     w Telegramie): wpisuję "tel/mail + produkty + cena", GPT parsuje
     (przeniesiony prompt), pokazuję **podgląd sparsowanej wyceny do
     zatwierdzenia** (przewaga nad Telegramem - widzę co zrozumiał zanim
     zapisze), Zapisz -> wycena + link do formularza gotowy do wysłania.
     Minimum: telefon LUB e-mail + produkty + cena. Z poziomu karty leada
     (CRM/Backlog): przycisk "Dodaj wycenę" - kontakt bierze się z leada,
     wystarczą produkty + cena, wycena podpięta pod leada.
- **Właściciel**: zgodnie z planem własności zasobów - owner z sesji,
  przy migracji WSZYSTKIE istniejące wyceny -> Antoni (decyzja 2026-07-11).
- **Supabase** (nowe tabele, migracje w apps/shared/migrations):
  - `wyceny` - odpowiednik CRM_CASES: id (zachowujemy format 15XXXX
    i kontynuujemy numerację!), typ (WYCENA/ZAMÓWIENIE/NOTATKA), status,
    owner, lead_id (nullable - spięcie z Leady B2C), kontakt (imię, tel
    e164/digits, email), items_json (jsonb), kwota_proponowana_brutto,
    kwota_sprzedazy_brutto, rabat_kwota, rabat24h_kwota, rabat24h_wazny_do,
    partner, prowizja_status, dane_do_faktury, form_* (status, submitted_at,
    token), pola adresowe z formularza, payment_method, history_log (jsonb).
  - `wyceny_shipments` - provider ('shipx' | 'furgonetka'), shipment_id,
    service, tracking_number, delivery_status, label_url, cod_amount,
    checked_at, nadana_at (ręcznie albo z trackingu - panel Fulfillment).
  - `wyceny_invoices` - infakt_uuid, kind (proforma/vat), status, paid_at,
    ksef_at, pdf_url, quick_payment_url.
  - `wyceny_events` - log zdarzeń pipeline (audyt zamiast history_log
    w jednej kolumnie; history_log zostaje dla kompatybilności importu).
  - `sku_cennik` - import z zakładki SKU CRM 2.0 (jedyne źródło prawdy cen,
    zgodnie z 02_CENNIK: ceny brutto, VAT 23%).
- **Publiczne endpointy formularza** (osobna funkcja `api/formularz.js`,
  CORS tylko lumlum.co):
  - `GET /formularz/api/dane?id=1509&t=<token>` - kontrakt odpowiedzi
    IDENTYCZNY jak dzisiejszy webhook GET (id, form_status, produkty,
    kwota_proponowana_brutto, discount_amount, rabat24h_kwota,
    rabat24h_wazny_do, prefill{...}) - formularz nie wymaga zmian logiki.
  - `POST /formularz/api/zapis` - przyjmuje dzisiejszy payload POST.
  - **Token w linku**: dzisiejsze ID są sekwencyjne (15XXXX) i GET oddaje
    dane osobowe - każdy może enumerować. Nowe linki:
    `lumlum.co/pages/formularz?id=1509&t=<losowy token>`. W okresie
    przejściowym GET bez tokenu działa (stare linki u klientów), po ~30
    dniach token obowiązkowy.
- **Pipeline zamówienia = maszyna stanów** w kolumnie `process_stage`
  zamiast rozlanych routerów Make:
  `NEW -> FORM_SENT -> SUBMITTED -> (pobranie) SHIPPED -> DELIVERED -> INVOICED
  / (przelew) PROFORMA_SENT -> PAID -> SHIPPED -> DELIVERED
  / (przelew opłacony z góry / FREE) SHIPPED -> ...`
  Każde przejście to jedna funkcja (zamówDostawę, wystawFakturę,
  wyślijMaila...), wywoływana z jednego workera - dzisiejsze ~20 gałęzi
  Make to kombinacje tych samych 5 kroków z innymi parametrami.
  Idempotencja przez lock_token + zapis stage PRZED wywołaniem API
  (koncept lock_token/worker_last_error już istnieje w arkuszu - przenosimy).
- **Worker**: pg_cron w Supabase (⚠️ Vercel Hobby - crony częstsze niż
  1/dzień muszą iść przez pg_cron + pg_net do naszego endpointu, jak
  w komunikatorze) - co 15-30 min: sprawdzanie trackingu przesyłek "Send",
  ponowienie nieudanych kroków pipeline, polling statusu async faktur.
- **Tracking bez fałszywych "doręczono"**: znany bug obecnego systemu -
  świeżo nadana paczka bywała od razu oznaczana jako dostarczona.
  Prawdopodobna przyczyna: scenariusz Make traktował samą odpowiedź
  trackingu (albo niewłaściwe pole) jako doręczenie. U nas: czytamy
  JAWNĄ listę statusów z `GET /v1/tracking/{nr}` i mapujemy kody wprost
  (np. dispatched_by_sender / adopted_at_source_branch = w drodze,
  TYLKO `delivered` = doręczona); każdy odczyt zapisujemy w
  wyceny_events, więc w panelu widać surową historię statusów i łatwo
  zdiagnozować rozjazd. Scraping strony InPost niepotrzebny - to jest
  to samo API, które zasila stronę śledzenia.
- **Webhook inFakt "opłacona"** -> `POST /formularz/api/infakt-webhook`
  (przepięcie huka z Make na nasz URL) -> ustawia PAID -> worker/handler
  odpala wysyłkę + fakturę końcową (delete proformy, KSeF) jak dziś w #3.
- **Rabat bez Baselinkera**: na fakturze inFakt pozycja "Rabat" z ceną
  ujemną (tak jak dziś Baselinker addOrderProduct z ujemną kwotą, VAT 23%).
  Do zweryfikowania w teście na inFakt (etap 4); fallback: proporcjonalne
  rozbicie rabatu na pozycje (kwoty się zgadzają, gorzej wygląda).
- **Pliki (etykiety, faktury)**: linki źródłowe (inFakt PDF, ShipX label)
  zapisujemy w bazie i pokazujemy w panelu; kopia na Google Drive jak dziś
  tylko jeśli potrzebna księgowo - pytanie otwarte.
- **Powiadomienia**: zamiast Telegrama - statusy na karcie wyceny + hub
  "Do zrobienia dziś" + (po wdrożeniu planu push) powiadomienia:
  "formularz wypełniony", "opłacone", "doręczono", "błąd pipeline".

## Płatności - uszczelnienie (realia)

- **PKO BP przez API**: bezpośredniego API dla firmy praktycznie nie ma -
  dostęp do rachunku (PSD2/AIS) mają tylko licencjonowani dostawcy (TPP),
  a iPKO Biznes API to oferta korporacyjna. Nie planujemy tego w MVP.
- Co robimy zamiast tego:
  1. **Przelew**: zostaje inFakt jako źródło prawdy - szybka płatność
     (link) oznacza fakturę jako opłaconą automatycznie, przelew ręczny
     oznaczamy w inFakt (webhook -> nasz endpoint, jak dziś). Do zbadania:
     integracja bankowa inFakt (automatyczne dopasowanie przelewów z PKO
     w inFakt) - jeśli działa, mamy "API do PKO" pośrednio, bez licencji.
  2. **Pobranie (COD)**: dziś "doręczono = zapłacono". ShipX nie daje
     wprost statusu wypłaty pobrania; InPost udostępnia raporty rozliczeń
     COD - do zbadania w etapie 6 (raport/e-mail rozliczeniowy ->
     odhaczenie cod_status w bazie). Do tego czasu zostaje logika obecna
     + widok "pobrania bez potwierdzonej wpłaty" w panelu.
  3. Ręczny przycisk "Potwierdź wpłatę" na karcie wyceny (fallback zawsze
     dostępny, zapisuje kto i kiedy).

## Etapy wdrożenia

Zasada nadrzędna: Make działa równolegle aż do cutoveru; do tego czasu
panel dopisuje NOWE wyceny także do Sheetsa (jeden addRow przez API),
żeby istniejący pipeline Make widział wszystko. Wyłączamy Make dopiero,
gdy nasz pipeline przejdzie testy end-to-end.

### Etap 0 - Fundament danych

- Migracje: tabele wyceny, wyceny_shipments, wyceny_invoices, wyceny_events,
  sku_cennik.
- Import z Sheets (wzór: scripts/sync-leady-from-sheet.js): CRM_CASES ->
  wyceny (+ rozbicie do shipments/invoices z kolumn), SKU -> sku_cennik.
  Wszystkie wyceny owner=Antoni. Sekwencja ID kontynuuje numerację arkusza.
- Skrypt syncu re-runnable (upsert po id) - do odpalenia ponownie tuż
  przed cutoverem.

### Etap 1 - Wyceny w CRM + osobny panel Sprzedaże (NOC 1, 2026-07-11)

Doprecyzowanie Antoniego (2026-07-11): wyceny NIE są osobną apką - to
zakładka/arkusz w istniejącym CRM (lumlum.dev/crm), na razie widoczna
TYLKO dla Antoniego (uprawnienia per user już są w hubie). Sprzedaże
natomiast to OSOBNY panel (nowa apka, np. lumlum.dev/sprzedaze):

- **CRM / zakładka Wyceny**: arkusz wycen jak pozostałe arkusze CRM,
  karta wyceny (produkty, kwoty, rabaty, kontakt, status formularza).
- **Panel Sprzedaże**: ładny widok zamówień (porównywalny z kartą CRM):
  imię i nazwisko, adres dostawy / punkt odbioru, produkty, kwoty,
  płatność, link do faktury (inFakt PDF), link do etykiety, tracking.
  Na górze proste statystyki jako placeholder (liczba sprzedaży, suma,
  ten miesiąc vs poprzedni - do rozbudowy później).
- **"Zamów kuriera ponownie"** na karcie sprzedaży: tworzy NOWĄ przesyłkę
  ShipX na dokładnie te same dane (adres/paczkomat/odbiorca), BEZ faktury
  i bez zmiany statusów zamówienia - na dosyłkę/reklamację. Zapis jako
  kolejny wiersz wyceny_shipments (kind: 'reship') + etykieta do pobrania.
- Owner: wszystko Antoni; Antoni wskaże później, które wyceny/sprzedaże
  przepisać na Lorenzo.
- Bez fulfillmentu (następny krok, etap 6).

### Etap 2 - Dodawanie i edycja (panel pisze)

- Szybkie dodanie: pole tekstowe -> GPT parser (prompt 1:1 z wariantu
  "B2B" czyli z rabatem 24h, minus telegram-izmy, minus wymóg słowa
  "wycena") -> podgląd -> Zapisz. Walidacja minimum: (tel LUB mail)
  + produkty + cena; z karty leada bez kontaktu.
- Pełny edytor: pozycje z sku_cennik, ilości, ceny, rabaty, kontakt.
  Edycja istniejącej wyceny = quote_mode REPLACE_EXISTING z merge'em
  jak w promptcie MERGE (FULL_REPLACE / KEEP_OLD) przy dodaniu tekstem,
  albo zwykły zapis przy edycji w formularzu strukturalnym.
- **Dual-write**: zapis do Supabase + addRow/updateRow w CRM_CASES,
  żeby scenariusze Make (#2 link, formularz GET/POST, pipeline) działały
  dla wycen dodanych w panelu. Od tego momentu można przestać używać
  Telegrama do NOWYCH wycen.
- Przycisk "Wyślij link" (kopiuj link + oznacz FORM_SENT) na karcie.

### Etap 3 - Formularz czyta z nas (cutover GET, nocą)

- `GET /formularz/api/dane` na lumlum.dev, kontrakt 1:1 z webhookiem Make.
- Kopia strony na Shopify: `lumlum.co/pages/formularz-test` z liquidem
  wskazującym nowe endpointy; testy: wycena z rabatem/bez, rabat24h
  aktywny/wygasły, prefill, form już SUBMITTED.
- POST na razie **proxy**: nasz endpoint zapisuje submit do Supabase
  (form_status, adresy) I przekazuje payload do dzisiejszego huka POST
  Make - sprawdzony pipeline realizacji nadal robi swoje.
- Cutover w nocy: podmiana dwóch URL-i w produkcyjnym liquid. Rollback =
  przywrócenie starych URL-i (jedna edycja w Shopify).

### Etap 4 - Własny pipeline realizacji

- Implementacja kroków: ShipX paczkomat (locker_standard, jak dziś) +
  ShipX kurier (courier_standard - przejęcie z Baselinkera, COD/insurance
  w polach shipmentu), etykiety; **Furgonetka dla kraju != PL** (+ flat
  fee 50 zł w formularzu i na fakturze); inFakt faktura/proforma + szybka
  płatność + KSeF + delete proformy; mail do klienta przez Gmail API
  (kontakt@lumlum.co, szablony przeniesione z Make); maszyna stanów +
  worker pg_cron (tracking, retry); webhook inFakt na nasz endpoint.
- Rabat NA PEWNO jako ujemna pozycja kwotowa na fakturze (decyzja
  Antoniego 2026-07-11: procenty odpadają - rozjazdy o grosze, "14,23%"
  bez sensu; zawsze kwota).
- Formularz jednorazowy: prawdziwy form_status w GET + ekran "zamówienie
  już złożone" + odrzucanie POST przy SUBMITTED + "Otwórz ponownie"
  w panelu.
- **Testy na sobie**: zamówienie testowe (paczkomat i kurier) na własny
  adres, przelew i pobranie, firma i prywatna - pełne przejście pipeline
  na środowisku produkcyjnym z prawdziwą przesyłką co najmniej raz.
  Furgonetka: przynajmniej jedna testowa przesyłka zagraniczna.
- Nowe env vars: INFAKT_API_KEY (zrotowany), INPOST_SHIPX_TOKEN
  (zrotowany), INPOST_ORG_ID, FURGONETKA_CLIENT_ID/SECRET.

### Etap 5 - Cutover POST i wygaszenie Make

- Nocą: POST przestaje proxować do Make - realizuje własnym pipeline.
- Obserwacja 1-2 tygodnie (panel pokazuje błędy pipeline z wyceny_events;
  Make scenariusze wyłączone, ale nie skasowane - łatwy rollback).
- Po stabilizacji: wyłączenie dual-write do Sheets, arkusze read-only
  (archiwum), skasowanie scenariuszy Make, rotacja sekretów (stare były
  w blueprintach na dysku), usunięcie Baselinkera.

### Etap 6 - Panel Fulfillment (osobny tool)

Decyzja Antoniego (2026-07-11): fulfillment to OSOBNE narzędzie w hubie
(analogicznie planowany osobno magazyn), nie zakładka wycen. Zastępuje
scenariusze "#5 Fulfillment" i "Przesyłka nadana" oraz arkusz wysyłek:

- Widok "**Przesyłki do nadania dziś**": zamówienia w stanie SHIPPED-
  -zlecone (etykieta wygenerowana, paczka fizycznie do nadania).
- Przesyłka znika z listy, gdy:
  1. ręcznie klikam "Nadana", ALBO
  2. automat (pg_cron, codziennie ok. 17:00-18:00) sprawdza tracking
     (ShipX / Furgonetka) - jeśli przesyłka ma status nadania u
     przewoźnika, sama przechodzi w "Wysłane".
- Dalej ten sam tracking prowadzi do "Doręczone" (i przy pobraniu odpala
  fakturę końcową - to już worker z etapu 4; panel tylko to pokazuje).
- Później dołączy tu magazyn (stany komponentów pod zamówienia).

### Etap 7 - Uszczelnienie i wygoda (po stabilizacji)

- Rozliczenia COD z InPost (raporty) + widok "pobrania bez wpłaty".
- Integracja bankowa inFakt (auto-dopasowanie przelewów PKO) - zbadać.
- Push: formularz wypełniony / opłacone / doręczono / błąd pipeline.
- Wycena z poziomu komunikatora (rozmowa -> szybkie dodanie z prefill).

## Rozstrzygnięte pytania (decyzje Antoniego 2026-07-11)

1. **Furgonetka** - do wysyłek zagranicznych: kraj != PL -> API Furgonetki,
   flat fee 50 zł (Europa) doliczane i widoczne w formularzu. Wysyłki
   krajowe w całości ShipX (wszystko w Menedżerze Paczek).
2. **Notion** - wygaszamy (służył optymalizacji leadów, niepotrzebny).
3. **Google Drive** - zostaje, PDF-y faktur nadal lądują na Drive.
4. **Arkusz wysyłek / fulfillment** - zastępuje go osobny panel
   Fulfillment (etap 6).
5. **Kopia wycen dla Lorenzo** - niepotrzebna, Lorenzo widzi wyceny
   w panelu per owner.
6. **Formularz** - zostaje wizualnie, staje się jednorazowy (zamyka się
   po złożeniu zamówienia, odblokowanie tylko z panelu).
