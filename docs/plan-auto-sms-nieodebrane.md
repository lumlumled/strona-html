# Plan: auto-SMS po nieodebranym telefonie

> Status: **ZBUDOWANE + E2E ZWERYFIKOWANE LOKALNIE 2026-07-23 (na prod-bazie), NIEZACOMMITOWANE, kill switch NIE ustawiony na prodzie.** Zastępuje punkt „Auto-SMS po 5-6 nieodebranych" z Phase 2 w `docs/backlog-priorytetyzacja-spec.md` (tamta wersja wysyłała SMS dopiero przy 6. próbie, ta wysyła od pierwszej).
>
> Kod: `apps/shared/server/auto-sms.js` (bramka + słownik ~260 imion + szablony + liczniki, 28 testów `node --test`), wpięcie w webhook Zadarmy (`apps/backlog-b2c/server/server.js`, blok „Auto-SMS po nieodebranym"), kolumna `sms_wyslany` w "Log zmian" (migracja `scripts/add-sms-wyslany-log-zmian.js` — WYKONANA na prodzie), badge ✉ SMS w Połączeniach (`app.html`), guard 30 dni w populacji kampanii (`apps/kampanie/server/populacja.js` + licznik w UI).
>
> E2E na żywej bazie (testowy lead 48000000991, posprzątane): skip `wylaczone_env` przy zgaszonym kill switchu → realna wysyłka przez Zadarmę (status sent, koszt 1,08 zł/6 seg.) ze śladem w kom + `sms_wyslany` + Historii rozmów (linia `[SMS→]` NIE zjada wpisu rozmowy — refetch leada po RPC) → trzeci strzał = skip `sms_dzis_juz_byl` z liczników kom. Prod-env: `LORENZO_ZADARMA_NUMBER` JEST (nadawca = numer, z którego Lorenzo dzwoni).
>
> ZOSTAŁO: (1) test na numerze Antoniego (obie ścieżki, oba scenariusze, odpowiedź przestawia Datę Feedbacku), (2) commit + deploy, (3) `AUTO_SMS_NIEODEBRANE=1` na prodzie, obserwacja pierwszego dnia.

## Po co

Nieodebrany telefon do świeżego leada to dziś ślepy zaułek: case wraca na listę i czeka na kolejną próbę. SMS zamienia go w umówiony termin, bo klient minutę temu zostawił formularz i pamięta, o co chodzi. „Nie odebrał" to ~93 z 407 leadów.

Odpowiedź klienta wraca do systemu automatycznie: webhook `/api/webhooks/zadarma-sms` (server.js:1203) puszcza treść przez `analyzeCall` i zapisuje Datę i Godzinę Feedbacku przez RPC `app_update_leady_notatka`. Klient pisze „jutro o 14" i case sam wraca na jutro na 14:00. To już działa i jest zacommitowane.

## Decyzje zamrożone przez Antoniego (2026-07-23)

1. SMS idzie po **każdej** nieodebranej próbie, nie dopiero po piątej.
2. **Max 1 SMS na dobę** na numer.
3. **Max 3 auto-SMS-y na życie leada, wszystkie w oknie 7 dni** od pierwszego. Potem koniec na zawsze: nawet jeśli Lorenzo dzwoni dalej i nie odbiera, kolejny auto-SMS **nie wychodzi**. Lead wpada co najwyżej do Kampanii.
4. **Godziny 8:00-20:30.** Poza oknem SMS-a nie wysyłamy wcale (nie kolejkujemy - to oszczędza outbox i crona).
5. **Kill switch w env** (`AUTO_SMS_NIEODEBRANE`), żeby wyłączyć bez deployu.
6. Nic do leadów **Sprzedane / Stracony**.
7. Wspólny guard z Kampaniami: kampania nie tyka numeru, który dostał od nas SMS w ostatnich **30 dniach**.
8. **Wchodzi od razu na żywo dla wszystkich**, bez okresu dry-run.
9. **SMS-y nie mogą brzmieć identycznie.** Klient, który dostanie dwa w tym samym scenariuszu, ma dostać dwie różne wiadomości, nie tę samą kopię.

## Wyzwalacz

Webhook Zadarmy w `apps/backlog-b2c/server/server.js`, **po** wyliczeniu `label` i korekcie poczty głosowej, **przed** insertem do Log zmian (~linia 1005). Bez crona i bez kolejki.

Kluczowe: wyzwalaczem jest **finalny `label === 'no_answer'`**, czyli po tym, jak `analyzeCall` rozpozna pocztę głosową (`poczta_glosowa` → `answered = false`). Zadarma raportuje pocztę głosową operatora jako połączenie odebrane z nagraniem - dla nas to nieodebrane i SMS ma iść. Sekundy połączenia nie decydują o niczym.

Konsekwencja czasowa: przy czystym nieodebranym (brak nagrania) SMS wychodzi natychmiast, przy poczcie głosowej - po transkrypcji i analizie, czyli kilkanaście-kilkadziesiąt sekund po rozłączeniu. Oba przypadki akceptowalne.

## Bramka (wszystkie warunki muszą być spełnione)

| Warunek | Wartość |
|---|---|
| `label` po korekcie poczty głosowej | `no_answer` |
| Kierunek | `wychodzące` (my dzwoniliśmy) |
| Status leada | ≠ Sprzedane, ≠ Stracony |
| Numer | obecny, ≥9 cyfr |
| Godzina (Warszawa) | 08:00-20:30 |
| SMS-y na ten numer dzisiaj | 0 |
| Auto-SMS-y w życiu leada | < 3 |
| Wiek pierwszego auto-SMS-a | < 7 dni |
| `AUTO_SMS_NIEODEBRANE` | `1` |

Liczniki czytamy z **kom_messages** (kanał `sms`, kierunek wychodzący, po numerze) - jedno źródło prawdy, to samo, którego używa guard kampanii. `sendSmsAndLog` (`apps/shared/server/kontakt-send.js:134`) już tam pisze.

Cap „1 na dobę" załatwia przy okazji idempotencję: podwójna dostawa tego samego calla z Make nie wyśle drugiego SMS-a.

## Wybór szablonu

Nie „nowy vs stary lead", tylko **czy istnieje realna wycena** - to samo kryterium co Reżim A/B w `apps/backlog-b2c/server/scoring.js` (rekord w tabeli `wyceny`, `items.length > 0 && kwota != null`, status Open):

- **brak wyceny** → scenariusz **FORMULARZ**
- **jest wycena** → scenariusz **WYCENA**

Wariant w obrębie scenariusza wybiera **numer próby** (1., 2., 3. auto-SMS do tego leada). Ten sam człowiek nigdy nie dostaje dwa razy tego samego tekstu.

## Treści

Zasady konstrukcji:

- **Żadnych linków** - Zadarma blokuje URL-e w SMS-ach na PL.
- **Zero em dashów**, tylko `-` (twarda zasada LumLum).
- **Rejestr: profesjonalny, ale nie pretensjonalny.** To dwie osobne pułapki i wpada się w nie z dwóch stron. Pretensjonalne: „wciąż nie mogę się z Panem połączyć" (rozliczamy klienta z nieodebranego telefonu). Nieprofesjonalne: „nie udało mi się Pana złapać", „chyba się mijamy", „kiedy będzie Pan miał chwilę" (potoczne, jak SMS do kolegi).
- **Kanoniczny zwrot: „nie udało się nam połączyć".** Neutralny, obustronny, bez winnego i bez potoczności. Używać go zamiast wszystkich wariantów „nie mogę się dodzwonić / złapać / dobić".
- **Bez języka robota.** „Wystarczy odpisać porę, która pasuje" to formularz, nie wiadomość od handlowca. Piszemy „Proszę o informację, kiedy będzie dla Pana dogodny moment".
- **Pierwszy SMS nie udaje, że była już jakaś sprawa.** Przy pierwszym kontakcie nie ma żadnego „zgłoszenia" ani „tematu": klient po prostu zostawił kontakt w formularzu i tyle o nim wiemy.
- Każdy fragment zależny od danych jest opcjonalny i wypada bez śladu, gdy danych brak. Nigdy nie renderujemy pustego miejsca ani „null".
- **Emotikon w wariancie 3 to dokładnie `:)`** - dwa znaki ASCII, bez spacji w środku, nie unicodowe 😊. Nie „poprawiać" tego przy budowie.

**Treści zatwierdzone przez Antoniego 2026-07-23** (po trzech rundach na rejestrze). Nie przepisywać bez jego zgody.

**Dwa tory grzecznościowe** (patrz „Wołacz i płeć"): tor **Pan/Pani** gdy znamy imię i płeć, tor **Państwo** gdy nie. Poniżej spisany jest tor Pan; tor Państwo to jego lustro (`zostawili Państwo`, `kiedy będzie Państwu wygodnie`), bez żadnej formy rodzajowej.

### Scenariusz FORMULARZ (brak wyceny)

**Wariant 1 (pierwsza próba)**
> Dzień dobry Panie Grzegorzu, z tej strony Lorenzo z LumLum. Zostawił Pan u nas kontakt w formularzu w sprawie oświetlenia LED. Próbowałem się z Panem skontaktować telefonicznie, ale nie udało się nam połączyć. Proszę o informację, jaki dzień i godzina będą dla Pana dogodne - wtedy zadzwonię. Może Pan również oddzwonić na ten numer w dowolnym momencie. Jeśli nie, zadzwonię jutro ponownie.

**Wariant 2 (druga próba)**
> Dzień dobry Panie Grzegorzu, tu ponownie Lorenzo z LumLum. Dzwoniłem w sprawie oświetlenia LED, ale nie udało się nam połączyć. Proszę o informację, kiedy będzie dla Pana dogodny moment na rozmowę - zadzwonię w tym terminie. Można też oddzwonić na ten numer.

**Wariant 3 (ostatnia próba)**
> Dzień dobry Panie Grzegorzu, tu Lorenzo z LumLum. Nie chciałbym zostawić sprawy oświetlenia LED bez odpowiedzi, a nie udaje się nam połączyć. Jeśli temat jest nadal aktualny, proszę o wiadomość lub telefon na ten numer. Jeśli nie, proszę o krótką informację - wtedy nie będę już wracał do tematu :)

### Scenariusz WYCENA (jest wycena)

`{3 lipca}` = `wyceny.created_at`; brak daty → zdanie leci bez niej.
`{Umawialiśmy się, że dziś się odezwę, ale}` → tylko gdy `Data Feedbacku` = dziś; w innym razie zostaje samo „nie udało mi się dodzwonić".

**Wariant 1**
> Dzień dobry Panie Grzegorzu, z tej strony Lorenzo z LumLum.{ 3 lipca} wysłaliśmy Panu wycenę oświetlenia LED.{ Umawialiśmy się, że odezwę się dzisiaj, ale} nie udało się nam połączyć. Proszę o informację, kiedy mogę zadzwonić, lub o telefon na ten numer w dogodnym dla Pana momencie.

**Wariant 2**
> Dzień dobry Panie Grzegorzu, tu Lorenzo z LumLum. Wracam do wyceny oświetlenia LED{ z 3 lipca}. Próbowałem się z Panem skontaktować telefonicznie, ale nie udało się nam połączyć. Proszę o informację, kiedy będzie dla Pana dogodny moment na rozmowę.

**Wariant 3**
> Dzień dobry Panie Grzegorzu, tu Lorenzo z LumLum. Nie chciałbym zostawić przesłanej wyceny bez odpowiedzi, a nie udaje się nam połączyć. Jeśli temat jest nadal aktualny, proszę o wiadomość lub telefon na ten numer. Jeśli nie, proszę o krótką informację - wtedy nie będę już wracał do tematu :)

**Uwaga o mieszaniu scenariuszy:** numer wariantu to numer próby, a scenariusz może się między próbami zmienić (klient dostaje wycenę po pierwszym SMS-ie). Dlatego warianty 2 i 3 otwierają się „tu jeszcze raz / tu Lorenzo", co czyta się poprawnie niezależnie od tego, co poszło wcześniej.

### Uwaga o długości i koszcie (zmierzone po zatwierdzeniu treści)

Polskie znaki diakrytyczne wypychają SMS-a w kodowanie **UCS-2: 70 znaków na segment, 67 przy sklejce**. Realne długości zatwierdzonych treści (pan/pani/państwo): FORMULARZ p1 **6 seg.** (359-393 zn.), p2 4 seg., p3 5 seg.; WYCENA p1 4-5 seg., p2 4 seg., p3 5 seg. Zmierzony koszt Zadarmy w E2E: **1,08 zł za 6 segmentów** (~0,18 zł/segment) - pełna sekwencja 3 SMS-ów ≈ 2,7 zł na leada, przy realnym wolumenie kilku nieodebranych dziennie to złotówki miesięcznie. Diakrytyki zostają (usunięcie wygląda nieprofesjonalnie); testy pilnują twardego limitu ≤6 segmentów na wariant.

## Wołacz i płeć

Trzy warstwy, w tej kolejności:

1. **Słownik ~250 polskich imion** (wołacz + płeć) zaszyty w module - Grzegorz → Grzegorzu / M, Zofia → Zofio / K. Pokryje większość realnych leadów, deterministycznie, bez kosztu.
2. Wejście: kolumna `Name` z Leady B2C, brany pierwszy człon (w bazie bywa „Grzegorz Kowalski", „grzegorz", „G", nazwa firmy, pusto).
3. **Brak pewnego dopasowania → fallback bezosobowy**: samo „Dzień dobry," i treść bez rodzaju. Żadnego zgadywania po końcówce (Kuba, Barnaba) - „Dzień dobry Panie Zofia" kosztuje więcej, niż imię zyskuje.

AI w runtime do odmiany jednego słowa: **nie**. Dokłada opóźnienie i niedeterminizm do ścieżki, która ma być niezawodna. Ewentualne podniesienie pokrycia: jednorazowy przelot bazy offline i zapis wołacza + płci jako kolumn, z rzutem oka Antoniego na wynik.

## Ślad w panelu Połączenia

Cały przebieg jednej próby kontaktu ma być widoczny w jednym rozwijanym wierszu, bez klikania po kartach.

**Baza:** nowa kolumna `sms_wyslany` (text) w tabeli `Log zmian`, wypełniana w tym samym insercie co rozmowa. Świadomie **nie** doklejamy tego do `opis` - `opis` karmi podsumowanie dnia i opisy case'ów, zaśmiecenie go wyciekłoby do planu.

**Front (`apps/backlog-b2c/app.html`, `renderPolaczenia`):**
- w zwiniętej linii badge **✉ SMS** obok istniejącego „✓ zaopiekowane dziś"
- po rozwinięciu, jako kolejne pole przez `appendPolaczenieField`: **SMS wysłany: {treść}**

Rozwinięty wiersz daje wtedy: nieodebrane / Podsumowanie (w tym „Nie odebrał (poczta głosowa)") / Notatki przed i po / Data feedbacku przed → po / Transkrypcja / **SMS wysłany**.

**Błąd wysyłki** zapisujemy jako `sms_wyslany = "BŁĄD: {powód}"`. Cisza jest gorsza niż widoczny błąd.

Odpowiedź klienta dolatuje osobno: `[SMS←]` w Historii rozmów + automatyczna zmiana Daty Feedbacku (istniejący webhook).

## Guard wspólny z Kampaniami

Jedna funkcja `ostatniSmsDoNumeru(digits)` czytająca kom_messages. Kampania nie zaciąga numeru, który dostał od nas SMS w ostatnich 30 dniach.

⚠️ Do sprawdzenia przy budowie: czy worker kampanii też pisze wysyłki do kom_messages. Jeśli nie, musi zacząć - inaczej guard jest ślepy w jedną stronę i kampania nie zobaczy auto-SMS-ów (albo odwrotnie).

## Kolejność wdrożenia

1. Kolumna `sms_wyslany` w Log zmian (skrypt wzorem `scripts/add-temperatura-po-rozmowie.js`).
2. Moduł `apps/shared/server/auto-sms.js`: bramka, liczniki z kom_messages, słownik imion, szablony i warianty. Testy jednostkowe na **wszystkich kombinacjach braków** (bez imienia, bez płci, bez daty wyceny, bez daty feedbacku, śmieciowy `Name`) + kontrola liczby segmentów.
3. Wpięcie w webhook Zadarmy + `sms_wyslany` w insercie do Log zmian.
4. Front: badge ✉ SMS i pole w Połączeniach.
5. Guard 30 dni w Kampaniach.
6. Test na numerze Antoniego: obie ścieżki (czyste nieodebrane i poczta głosowa), oba scenariusze, sprawdzenie nadawcy (+48 459 567 870) i tego, że odpowiedź przestawia Datę Feedbacku.
7. `AUTO_SMS_NIEODEBRANE=1` na prodzie, obserwacja pierwszego dnia w panelu Połączenia.

## Ryzyka

- **Nadawca.** SMS musi wychodzić z tego samego numeru, z którego Lorenzo dzwoni, inaczej klient gubi wątek. Zadarma dopasowuje nadawcę po dokładnym stringu numeru bez plusa (`48459567870`); niedopasowanie = cicha podmiana na „zadarma.com", a API i tak zwraca sukces. Weryfikować na realnym telefonie, nie po odpowiedzi API.
- **Brak `LORENZO_ZADARMA_NUMBER`** w env dla tej ścieżki spycha caller_id na `ZADARMA_OWN_NUMBER`. Sprawdzić przed włączeniem.
- **Podwójna dostawa webhooka** z Make - pokryta capem 1/dobę.
- **Klient odpisuje coś, co nie jest terminem** („nie jestem zainteresowany"). Dziś `analyzeCall` zapisze to w Historii rozmów i nie ustawi daty. Do rozważenia później: automatyczne przestawienie na Stracony przy jednoznacznej odmowie.
