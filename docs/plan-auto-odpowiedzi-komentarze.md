# Auto-odpowiedzi na komentarze / DM (baza pytanie-odpowiedź + styl)

Status: DRAFT roboczy (2026-08-05). Treści potwierdzane z Antonim, transkrypcje z dyktowania - miejsca `⚠️` do potwierdzenia.

## Cel
Proste, otwierające zapytania z social (komentarze, DM) obsługiwane z automatu w stylu Antoniego,
tak żeby wyciągnąć klienta na telefon / do lejka, a nie odpisywać ręcznie.

## Decyzje (ustalone)
1. **Bezpieczny kubełek = pełny automat od razu** (bez akceptacji ręcznej). Kill-switch + limity jak w `auto-sms.js`.
2. **Mechanika komentarza:** pełna odpowiedź idzie jako **DM (private reply)**; w komentarzu tylko krótki stub - **losowa wariacja** (żeby nie brzmiało identycznie pod każdym komentarzem):
   - Napisaliśmy do Ciebie w wiadomości prywatnej 😊
   - Napisaliśmy wiadomość 😊
   - Odpisaliśmy w wiadomości prywatnej 😊
   - Sprawdź proszę wiadomości prywatne 😊
   - Odezwaliśmy się w wiadomości prywatnej 😊
   - Napisaliśmy do Ciebie prywatnie 😊
3. **Reguła lustra powitania:** klient „Cześć/hej" → my „Cześć!" i na „Ty". Klient „Dzień dobry" → my „Dzień dobry" i forma grzecznościowa (płeć znana → „Pan" albo „Pani"; **płeć nieznana → bezosobowo, NIGDY „Pan/Pani" ze slashem**). Dotyczy wszystkiego.
4. **CTA:** zawsze pełny numer **604 650 590**, nigdy skrótu. Prowadzimy głównie na telefon; „zostaw numer, to zadzwonię" jako druga opcja.
5. **Numer zostawiony w komentarzu** → NIE odpisujemy; numer ląduje jako **lead w Organic** + natychmiastowy push „nowy lead organic" (zależne od włączonego Web Push; fallback SMS/mail do Antoniego).
6. **Polemik / obiekcji NIE automatyzujemy** (np. AliExpress). Automat tylko na proste, wciągające intencje; polemikę zostawiamy do ręki.
7. **PRÓG PEWNOŚCI (zasada nadrzędna):** automat odpowiada TYLKO gdy jest pewny, że to (a) realna wiadomość warta odpowiedzi i (b) pasuje do znanej intencji z katalogu. Niepewny → NIE odpowiada, zostawia człowiekowi (tryb podpowiedzi). „Jeśli pewny - odpowiadaj; nie pewny - nie rób."
8. **Zakres kanałów:** działa na (a) KOMENTARZE (odpowiedź jako DM/private reply + stub w komentarzu) oraz (b) WhatsApp DM (odpowiedź bezpośrednio w wątku, BEZ stubu - to już kanał prywatny). Messenger/IG DM analogicznie do WhatsApp. WhatsApp podłączony do Zernio - wiadomości będą widoczne.
9. **Nie dublujemy:** automat pomija (a) WŁASNE komentarze (sent_by = my / „LumLum"), (b) komentarze JUŻ odpowiedziane (jest nasza odpowiedź / wysłany private reply), (c) osoby, z którymi JUŻ był kontakt (nie zaczepiamy drugi raz).
10. **Generowanie wariacji (NIE szablon):** każda odpowiedź i każdy stub są GENEROWANE nieco innymi słowami - ta sama stylistyka, merytoryka i forma, ale nie kopiuj-wklej. Katalog A-T = przewodnik stylu i faktów, nie sztywny tekst.
11. **Backfill zaległych:** komentarz z ostatnich 7 (do 14) dni, na który NIC nie odpisaliśmy (ani komentarzem, ani priv) i od osoby bez wcześniejszego kontaktu → można nadrobić. ⚠️ private reply działa tylko ≤7 dni (okno FB); 8-14 dni → ewentualnie tylko publiczny komentarz. DO WERYFIKACJI: czy autora komentarza da się stabilnie skojarzyć z historią DM (FB: ID autora komentarza ≠ PSID Messengera).
12. **Vague „co zrobić / co dalej?" pod postem** → soft engage (nie cisza): zapytać, co chce osiągnąć. Wzór: „Dzień dobry! Co ma dać to oświetlenie i jaki efekt chcemy uzyskać? Podpowiemy, jak to przygotować, żeby ładnie wyszło."

13. **Język odpowiedzi:** klient po polsku → po polsku; **po czesku lub słowacku → odpowiadamy w całości po polsku**; **każdy inny język (DE/ES/FR/EN…) → w całości po angielsku**. Numer dla zagranicy z kierunkowym: **+48 604 650 590**. (Reguła egzekwowana przy generacji - system prompt wykrywa język wiadomości i wybiera PL/EN.)
14. **Pierwsza wiadomość vs kolejna (follow-up):**
    - PIERWSZA wiadomość / komentarz (nowy kontakt) → autoresponder wg katalogu A-T (to co budujemy).
    - KOLEJNA wiadomość w rozmowie → automat odpowiada TYLKO gdy pewność ~105% i odpowiedź oczywista (kanały: WhatsApp / Messenger / IG DM). Inaczej → PROPOZYCJA do ręcznej akceptacji.
    - ZAŁĄCZNIK od klienta (zdjęcie/wideo) LUB jakakolwiek niepewność → zawsze PROPOZYCJA, nigdy auto.
    - Ścieżka „propozycja, którą poprawiam" = obecne `suggest.js` (już działa); auto-send to nadbudowa tylko dla pewnych przypadków. Follow-up nie wchodzi automatowi w drogę, gdy wątek prowadzi człowiek.

## Styl - twarde zasady (dopięte 2026-08-05, na bazie realnych rozmów + korekt Antoniego)
- Ton: **ciepło, ale po ludzku i klarownie - NIE za luźno.** Bez slangu i bez skrótów myślowych.
- Emoji: **😊** (TYLKO ta minka). NIE używać 👍 (kciuk w górę) ani 🙂.
- **Zakazane zwroty:** „łap mnie / od razu łap mnie na 604", „od razu na 604", skróty typu „przygotuję konkret" (→ pełne „przygotuję **konkretną wycenę**").
- **Numer telefonu:** zawsze pełny. Preferowane brzmienie: **„albo zadzwoń po prostu na 604 650 590"** (albo „zostaw numer, to zadzwonię").
- Powitanie = lustro (Cześć/Ty ↔ Dzień dobry/forma grzecznościowa), imię gdy znane. **NIGDY „Pan/Pani" ze slashem** - płeć znana → „Pan" albo „Pani", płeć nieznana → **bezosobowo** (np. „Proszę napisać, co ma być podświetlone", „Można zadzwonić po prostu na 604 650 590").
- Myślnik zawsze „-", nigdy „—".
- Wzorce z realnych rozmów Antoniego (screeny 2026-08-05): „Dzień dobry, jak mogę pomóc z oświetleniem?", „Cześć, oczywiście. Opowiedz coś o swoim projekcie", „Prosiłbym, żeby opisać w kilku słowach swój projekt", „pod numerem 604 650 590 😊".

## Filtr „czy to nasz klient" (kluczowe)
**NIE odpowiadamy** (wąska lista - sygnał, że to hobbysta-elektronik albo nie-lead):
- żargon chipowy/hobbystyczny: `WS2812`, `WS2811`, numery chipów, „sam sobie zaprogramuję" (buduje sam, nie kupi u nas)
- **czyste** „ile za metr taśmy?" bez projektu (price-fishing). UWAGA: konkretna specyfikacja + ilość („5 m COB 24V IP65") to JUŻ realny klient → odpowiadamy z ceną.
- troll / spam / obcy język
- pochwała BEZ pytania („Super", „Wow", „♥️"). Pochwała + pytanie („fajne, jak to działa?") → odpowiadamy.
- obiekcja/polemika (AliExpress/taniej) → nie automatyzujemy (gotowiec do ręki, intencja J)

**Odpowiadamy** (realna potrzeba - prawie wszystko poza listą wyżej):
- cena dla miejsca („nad szafkami", „w salonie", „w korytarzu")
- konkretna cena komponentu/zestawu (sterownik, „5 m COB 24V IP65", 3 m pod szafki)
- gdzie kupić / zamówić; prośba o link do produktu
- jak się montuje / czy montujecie / czy trudne samemu
- „da się zrobić…" / efekt świetlny / „jak to działa"
- integracja smart home / WiFi
- wysyłka (także zagranica / Europa)
- rabaty / większe zamówienie / B2B
- opis projektu / „nie znam się, pomóżcie"

## Próg pewności - trzy wyjścia automatu
Każda wiadomość trafia w jedno z trzech:
1. **Odpowiedź merytoryczna** (intencje A-T) - gdy automat PEWNY + znana intencja + „nasz klient".
2. **Redirect na telefon** - realna sprawa, ale NIE do auto-rozwiązania (wsparcie, istniejący klient, reklamacja/eskalacja). Jedno zdanie:
   > Proszę o telefon na 604 650 590.
3. **NIC / do człowieka** - niepewne albo nie dla automatu (zostaje w panelu do ręki).

Rozstrzygnięcia z 3. dziesiątki (kalibracja progu):
- **Problemy posprzedażowe / wsparcie -> DO CZŁOWIEKA (NIC z automatu).** UWAGA (weryfikacja na realnych danych 2026-08-05): wściekłych „oszukaliście mnie / czekam 2 tygodnie" NIE MA w danych w ogóle - to był mój wymyślony test. Jedyna realna sprawa posprzedażowa to grzeczne „zapomniano spakować piloty 😔". Takie rzadkie i konkretne sprawy zostawiamy Antoniemu, nie automatowi. (Redirect na telefon zostaje w arsenale jako opcja, ale w praktyce te przypadki są nikłe.)
- „?" -> NIC · „👍" (samo emoji) -> NIC
- „RGBW 5090 IP68 48V" (egzotyk, nie mamy) -> NIC („nie mamy takich, nie odpowiadamy")
- „przyjmujecie do pracy/współpracy?" (off-topic) -> NIC
- „rozmawialiśmy wczoraj, co dalej?" (kontynuacja) -> NIC / do człowieka (niepewne)
- „a taniej się da?" (negocjacja) -> NIC
- „info" (jedno słowo) -> NIC

## Katalog intencji -> odpowiedź (wariant „Cześć/Ty"; formalny przez lustro)

### A. Cena / koszt dla miejsca
Wyzwalacze: „ile kosztuje LED nad szafkami", „ile kosztuje w korytarzu"
> Dzień dobry, to wszystko zależy od łącznej długości taśmy LED, której użyjemy. Proszę w kilku słowach napisać, ile łącznie metrów będzie potrzebne i jak ma być sterowane to oświetlenie.

(wariant Ty: „Cześć! To zależy od łącznej długości taśmy, którą użyjemy. Napisz w kilku słowach, ile łącznie metrów będzie potrzebne i jak chciałbyś tym sterować.")

### B. Gdzie kupić / zamówić
Wyzwalacze: „gdzie można zamówić?", „jak zamówić?"
> Cześć, najłatwiej jeśli zadzwonisz na 604 650 590 i tam doradzę Ci, co potrzebujesz do Twojego konkretnego projektu.

### C. „Poproszę" / zainteresowany
Wyzwalacze: „Poproszę", „Chętnie się dowiem"
> Cześć! Dzięki za zainteresowanie 😊 Opowiedz coś o swoim projekcie, co chcesz podświetlić, a ja dobiorę wszystkie rozwiązania i przygotuję dokładną wycenę. Możesz też zostawić numer, to zadzwonię, lub zadzwonić na 604 650 590.

### D. Proszę o kontakt (bez numeru)
> Cześć! Jasne, chętnie pomogę 😊 Zostaw proszę numer, to zadzwonię, albo napisz w kilku słowach, czego potrzebujesz. Możesz też od razu zadzwonić na 604 650 590 i ustalimy wszystkie szczegóły.

### E. Montaż do sufitu (jak się montuje)
> Wszystkie taśmy montujemy w profilach aluminiowych, więc tutaj jest pytanie: jaki jest sufit? Jeśli sufit podwieszany, to najlepiej zrobić to profilem do płyty GK (wpuszczanym pod tynk). Jeśli chciałbyś zamontować bez wpuszczania (bez kucia bruzd), to wtedy niskim i płaskim profilem nawierzchniowym. Wtedy ważne, żeby użyć taśmy COB, żeby nie było ciemnych punktów. Zadzwoń na 604 650 590 i porozmawiajmy, jak to zrobić.

### F. Czy montujecie / przyjeżdżacie
> Zajmujemy się tylko doradztwem i sprzedażą. Natomiast każdy elektryk poradzi sobie z montażem, ponieważ do każdego zestawu dołączamy instrukcje po polsku wraz z wideoinstrukcją krok po kroku, jak to wykonać. Proszę o telefon na 604 650 590 i porozmawiamy o szczegółach.

### G. „Da się zrobić…" / efekt (np. płynące światło nad schodami)
> Dzień dobry, tak, oczywiście da się to zrobić - wszystko to kwestia okablowania. Musimy połączyć końcówki odcinków trzyżyłowym przewodem z początkami następnych. Proszę o telefon na 604 650 590 i porozmawiamy o tym.

### H. Opis projektu z długością (np. „12 m w salonie, co polecacie")
> Cześć! Wszystko zależy od Ciebie - czy chcesz osiągnąć efekt cyfrowy, czyli płynące światło, czy nie. Jeśli tak, to zestaw cyfrowej taśmy, sterownik, zasilacz i np. pilot będzie w pełni wystarczający - koszt ok. 1400 zł (komplet na ~12 m). Taśma jest COB, więc nie będzie ciemnych punktów. No i wszystko rozbija się jeszcze o sposób montażu i okablowanie, więc zadzwoń na 604 650 590 i porozmawiamy o szczegółach.

### I. Opis projektu / „nie znam się, pomóżcie" (np. pergola)
> Dzień dobry! Proszę o telefon na 604 650 590, porozmawiamy o tym, jak to zrobić.

### J. Obiekcja: „wszystko jest na AliExpress / taniej"  — NIE Z AUTOMATU (polemik nie automatyzujemy; gotowiec do ręcznej odpowiedzi)
> Pewnie, tylko AliExpress to najtańsze opcje - najtańsze sterowniki i taśma. Później mamy telefony od klientów, że chcą to wymienić, bo posypało im się po trzech miesiącach. Oczywiście wszystko można tam znaleźć - u nas dostępny jest tylko sprawdzony standard.

### K. Cena pojedynczego komponentu (sterownik)
> Sterownik cyfrowy to koszt 350 zł.

### L. Konkretna taśma + ilość („5 m COB 24V IP65, ile?")
> Tak, mamy taką taśmę - w wersji cyfrowej (wtedy IP65) i analogowej (wtedy IP67). Za 5 metrów: analogowa 250 zł, a cyfrowa 400 zł.

### M. Integracja smart home / WiFi
> Można podłączyć dowolny system Smart Home przez przekaźnik bezpotencjałowy (na suchy styk) do naszego portu na sterowniku.

### N. „Mam już taśmę, potrzebuję zasilacz/sterownik"
> Jaka to taśma - mono czy cyfrowa? I na ile volt? Na tej podstawie dobiorę zasilacz i sterownik.

### O. Mały konkretny projekt („3 m pod szafki, macie zestaw?")
> Dzień dobry! Czy potrzebna będzie taśma cyfrowa z efektem płynięcia, czy analogowa? I jak ma być sterowane to oświetlenie?

### P. Rabaty / większe zamówienie / B2B
> Oczywiście. Przy większym zamówieniu wyceniamy troszkę indywidualnie. Proszę opowiedzieć o swoim projekcie, a przygotujemy konkretną wycenę oraz rabat.

### Q. Wysyłka za granicę
> Tak, oczywiście. Wszystkie przesyłki możemy wysłać na terenie Europy.

### R. Trudność montażu samemu
> Montaż jest dość prosty, opisany krok po kroku - zarówno w instrukcji po polsku, jak i w wideoprzewodniku po polsku, który pokazuje krok po kroku, jak to zamontować.

### S. Prośba o link do produktu
> Jasne! Tutaj linki do naszych zestawów i produktów: zestawy https://lumlum.co/pages/zestawy , wszystkie produkty https://lumlum.co/products , konfigurator https://lumlum.co/pages/konfigurator

### T. Pochwała + „jak to działa?" ⚠️ (transkrypcja do potwierdzenia)
> Dziękujemy za miłe słowa 😊 Taśma ma przy każdej linii cięcia chip, który steruje indywidualnie każdą sekcją - dzięki temu można tworzyć animacje/płynące efekty. Sterownik ma zaprogramowane kilka trybów, więc konfiguracja jest dość prosta. Zadzwoń na 604 650 590 i wyjaśnimy dokładnie, jak zrobić to w Twoim projekcie.

## Fakty do /wiedza (wychwycone z odpowiedzi Antoniego)
- Sprzedaż + doradztwo, **bez montażu**; do zestawu instrukcja PL + wideoinstrukcja krok po kroku.
- Montaż zawsze w **profilach aluminiowych**; sufit podwieszany -> profil do GK; natynkowo -> niski płaski profil nawierzchniowy; przy natynku używać **COB** (brak ciemnych punktów).
- Efekt „płynący/cyfrowy" = taśma cyfrowa + odcinki łączone **trzyżyłowym** przewodem (koniec -> początek następnego).
- Przykładowy zestaw cyfrowy na ~12 m (taśma COB + sterownik + zasilacz + pilot) ~ **1400 zł**.
- Metr cyfrowej taśmy COB = **75 zł/m** (wiedza wewnętrzna; NIE podajemy w odpowiedzi na „ile za metr").
- **Sterownik cyfrowy = 350 zł.**
- **Taśma COB 24V**: cyfrowa = IP65, analogowa = IP67. Za 5 m: analogowa **250 zł**, cyfrowa **400 zł**.
- Sterownik ma port „suchy styk" (przekaźnik bezpotencjałowy) → integracja z dowolnym systemem Smart Home / WiFi.
- **Wysyłka na terenie całej Europy** (nie tylko Polska).
- Większe zamówienie / B2B → wycena indywidualna + rabat.
- Taśma cyfrowa: przy każdej linii cięcia chip sterujący sekcją indywidualnie → animacje / płynące efekty; sterownik ma zaprogramowane tryby.

## Linki (do udostępniania w odpowiedziach)
- Wszystkie produkty: https://lumlum.co/products
- Wszystkie zestawy: https://lumlum.co/pages/zestawy
- Konfigurator: https://lumlum.co/pages/konfigurator

## Status budowy (2026-08-05)
- **Krok A (seed)**: ZROBIONY (kom_examples 25 wzorców + kb_facts 14, zweryfikowane).
- **Krok C (autoresponder) - BACKEND ZBUDOWANY, niewdrożony, WŁĄCZNIK OFF**:
  - migracja `013_autoreply.sql` (tabela `kom_autoreply`) - zaaplikowana na prod DB.
  - `server/settings.js` (włącznik `auto_send_enabled` w kom_settings, domyślnie false).
  - `server/autoreply.js`: `consider()` (regułowa decyzja w webhooku, tani, tylko pierwszy kontakt, bez załącznika, nie własne, dedup) + `sweep()` (worker: generuje przez suggest.js, wysyła gdy ON / oznacza 'held' gdy OFF).
  - `server.js`: endpointy `/api/automat/status|toggle|feed|:id/cancel` (toggle tylko admin) + cron `/api/cron/outbox` + fold do runWorker.
  - `ingest/zernio.js`: hak `autoreply.consider` po triage'u (DM + komentarz), nierzucający.
  - `suggest.js`: prompt zgrany z zasadami (lustro, NIGDY Pan/Pani, język PL/CZ/SK->PL inne->EN, tylko 😊, wariacje) - dotyczy też zwykłych podpowiedzi.
- **ZOSTAŁO**: (1) panel „Automat" w app.html (zakładka + włącznik + feed decyzji); (2) harmonogram pg_cron dla `/api/cron/outbox` (co 1-2 min) PO deployu; (3) opcjonalny publiczny stub pod komentarzem (potrzebny endpoint Zernio comment-reply); (4) commit + deploy. Nic nie wysyła: włącznik OFF + brak crona.

## Do zrobienia (po zatwierdzeniu treści)
1. Zapisać pary (kontekst -> odpowiedź) jako seed do `kom_examples` (styl) - przez `scripts/kb-import-examples.js`.
2. Fakty -> `/wiedza` (kb_facts).
3. Wpiąć auto-send za bramką PRÓGU PEWNOŚCI: klasyfikator intencji + pewność -> `kom_outbox` (opóźnienie **losowo 2-15 min**, anti-bot) -> cron -> wysyłka per kanał:
   - komentarz: `sendPrivateReply` (DM) + stub w komentarzu,
   - WhatsApp/Messenger/IG DM: zwykła odpowiedź w wątku (bez stubu).
   Kill-switch + limity + fail-closed wzorem `auto-sms.js`.

## Parking (osobno, wrócimy)
- **Panel Wiadomości (komunikator) do uporządkowania** - Antoni: „zbyt chaotyczny". To osobny temat UX, nie blokuje auto-odpowiedzi, ale ułatwi nadzór nad tym, co automat wysyła.
