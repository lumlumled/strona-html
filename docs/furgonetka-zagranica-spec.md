# Zagranica: Furgonetka + dopłaty do wysyłki — spec

> Domknięcie luki „zamówienie zagraniczne". Dziś (lip 2026) formularz przyjmuje
> kraj ≠ PL, ale pipeline NIE zamawia przesyłki (InPost ShipX = tylko PL) —
> loguje jedynie `pipeline.manual_shipping_needed`. Ten dokument = uzgodnione
> wymagania (rozmowa z Antonim, voice-to-text, wiele wiadomości — spięte tu w
> jedno źródło prawdy).

## Decyzje Antoniego (twarde)

1. **Wysyłka zagraniczna idzie przez Furgonetkę**, PL zostaje na InPost ShipX bez zmian.
2. **W pełni automatycznie:** po opłaceniu system sam bierze **najtańszą** ofertę
   (calculate-price), tworzy paczkę, **zamawia kuriera**, pobiera **etykietę A6**,
   i **pisze do Antoniego pushem o której będzie kurier** (godzina odbioru).
3. **Dane nadawcy/odbioru są skonfigurowane w koncie Furgonetki** — nie wysyłamy
   pełnego nadawcy w payloadzie, korzystamy z domyślnych danych konta.
4. **Dopłata do wysyłki dla klienta (flat):**
   - PL → **darmowa** („Przesyłka darmowa" w formularzu),
   - Europa → **50 zł**,
   - poza Europą → **100 zł**.
   Ta sama reguła **w formularzu** (widzi klient) **i na fakturze** (kwota do zapłaty).
5. **Bez pobrania (COD) dla zagranicy** — już zablokowane w formularzu (JS).
6. **Faktura na firmę zagraniczną = corner case:** pipeline NIE wystawia jej
   automatycznie (polski 23% VAT byłby błędny — powinno być odwrotne obciążenie).
   Zamiast tego: wstrzymaj, ustaw status, **push do Antoniego do rozstrzygnięcia**.
   Antoni wystawia poprawną fakturę ręcznie.
   - Zagraniczny klient **prywatny** (nie-firma) → leci normalnie: faktura 23% VAT
     + dopłata do wysyłki. (Do zmiany, gdyby OSS był potrzebny.)

## Klasyfikacja Europa / poza Europą

`shippingSurchargePLN(country)`:
- puste albo `PL` → `0`
- kraj w zbiorze EUROPA (EU27 + EEA + UK + CH + mikropaństwa + Bałkany + UA/MD/BY) → `50`
- w każdym innym wypadku (US, CA, AU, …) → `100`

Formularz oferuje dziś: AT BE CH CZ DE DK ES FI FR GB IE IT NL NO PL PT SE SK US.
Z tego jedyne „poza Europą" = **US**. Logika serwera i tak obsługuje dowolny kod.

## API Furgonetki (zweryfikowane)

- Auth: OAuth2 **client_credentials** — `POST https://api.furgonetka.pl/oauth/token`,
  nagłówek `Authorization: Basic base64(client_id:client_secret)`,
  body `grant_type=client_credentials&scope=api`. Token 60 min, bez refresh →
  cache w pamięci procesu, re-auth po wygaśnięciu.
- Host prod: `https://api.furgonetka.pl`, sandbox: `https://api-test.furgonetka.pl`
  (przez env `FURGONETKA_API_BASE`).
- Endpointy (z changelogu REST):
  - `POST /packages/calculate-price` — porównanie ofert kurierów (wybór najtańszej),
  - `POST /packages` — utworzenie paczki (kraj odbiorcy + wymiary/waga + wybór usługi),
  - `PUT /packages/order` — **zamówienie do nadania** (to kosztuje/finalizuje),
  - `PUT /packages/pickup` + `GET /packages/pickup` — zamówienie/odczyt odbioru kuriera (godzina),
  - etykieta PDF (A6) — endpoint druku (potwierdzić nazwę na sandboxie),
  - `GET /packages/tracking` — statusy,
  - `GET /configuration/allowed-countries` — lista krajów,
  - webhook statusów: `/account/notifications/webhook` (v2 zamiast pollingu).
### Potwierdzone na żywym API (2026-07-13, konto lumlum.leds@gmail.com)

- **Auth:** grant `client_credentials` daje token aplikacji, ale endpointy konta
  zwracają `401 "Error user authentication"`. Trzeba grantu **`password`**
  (username=`lumlum.leds@gmail.com` + hasło). Token: access 30 dni, **refresh
  ROTUJE się przy każdym użyciu** (single-use) → magazyn tokenów MUSI zapisywać
  nowy refresh po każdym odświeżeniu (env nie wystarczy → tabela w Supabase).
- **calculate-price body (POTWIERDZONE):**
  ```json
  { "package": { "type": "package", "pickup": {…}, "receiver": {…},
                 "parcels": [ { "width":35,"depth":50,"height":18,"weight":3,"value":1200 } ] } }
  ```
  Uwaga: koperta `package`, `type` W ŚRODKU, `parcels` PŁASKA tablica (nie array-of-arrays).
- **receiver:** `name, company, email, phone, street, building_number, flat_number,
  city, postcode, country_code` (dom i mieszkanie OSOBNO).
- **Cena:** `services_prices[].pricing.price_gross` (przy `available:true`); pomijamy
  `furgonetka_gielda` (aukcja). Przykład DE/München 3 kg: swiatprzesylek 41,07 /
  gls 74,67 / dpd 76,98 / fedex 135 / ups 233.
- **Nadawca konta:** Wrocław, Walońska 7/84 (⚠️ ShipX ma Zakopane — do potwierdzenia,
  skąd realnie nadajemy).
- **Poza-EU (US):** calculate-price zwrócił pusto — prawdopodobnie wymaga danych
  celnych; edge do obsłużenia przy pierwszym realnym zamówieniu spoza EU.
- **create/order/pickup/label:** envelope pewny; do potwierdzenia draftem (POST
  /packages) + delete, oznaczone `TODO(live)` w module.

## Decyzje dogrywka (2026-07-13, druga tura)

- **Kurierzy = allow-lista: DPD, DHL, FedEx, UPS** (renomowani). Żadnych brokerów
  (swiatprzesylek, ambroexpress, gls) ani Poczty/**Pocztexu** (twardy zakaz).
  `sortowaneOferty` filtruje po `FURGONETKA_ALLOWED`. ⚠️ DHL na koncie
  NIEDOSTĘPNY (`dhl niedost`) — Antoni musi go aktywować w panelu Furgonetki.
- **Routing przewoźnika** (korekta — nie tylko po kraju):
  - dostawa PL **i** telefon polski (+48) → **InPost (ShipX)**, paczkomat OK,
  - dostawa PL **ale telefon zagraniczny** → **Furgonetka kurier** (InPost wymaga
    PL numeru do SMS/paczkomatu),
  - dostawa zagranica → **Furgonetka kurier**.
  → warunek Furgonetki: `ship_country != PL` **LUB** `telefon nie +48`.
- **Pudło:** 43×33×10 cm (największe realne). Wszystkie realne pudełka LumLum są
  w tym samym progu cenowym — dobór S/M/L nic nie daje. Waga override
  `FURGONETKA_WEIGHT_KG` (v2: z pozycji × `sku_cennik.weight_kg`).
- **receiver.street MUSI zawierać numer** budynku (Furgonetka: "Mierová 950/95");
  DPD waliduje `street→noNumber` gdy brak. `receiver.name` ma min. długość.
- **Formularz — dodatkowo:**
  - obcy prefiks telefonu → **ukryj paczkomat** + komunikat „Chcesz dostawę do
    paczkomatu? Podaj polski numer telefonu.",
  - koszt dostawy: PL darmowa / EU 50 / poza 100 (jak wyżej).
- **`order` (PUT /packages/order) NIEROZGRYZIONY** — model koznyka (create →
  validate → order), draft „waiting" zwraca „Paczka nie istnieje". Nie forsować
  na żywym (płatnym) endpincie — wziąć flow z zalogowanej dokumentacji /
  supportu Furgonetki. **v1 rollout: auto-przygotuj draft + push do Antoniego
  „kliknij Zamów"** (bezpieczne, zero przepisywania); pełny auto-order po
  potwierdzeniu flow.

## Decyzje dogrywka (2026-07-13, trzecia tura)

- **ROLLOUT = FULL AUTO** (moja rekomendacja, order potwierdzony): zagraniczny
  klient prywatny → auto najtańszy dozwolony → order (order-commands) → etykieta
  A6 → push. GUARD: kraje wymagające `duty` (cło: US + UK/CH/NO/UA + reszta
  spoza UE) → **wstrzymaj + push** (bez `duty` order by padł). UE (unia celna)
  → full auto. Auto-cancel: pomijamy na teraz (nie na happy-path; firma zagr.
  wstrzymana PRZED order; rzadkie przypadki = panel web).

- **NOWE: odbiór kuriera InPost (dispatch_order) z Fulfillment** — gdy Antoni
  po raz PIERWSZY danego dnia kliknie „Drukuj etykietę"/„Oznacz" w /fulfillment
  (przed 15:00) → `POST /v1/organizations/{id}/dispatch_orders` (ShipX) na
  dzisiejsze gotowe przesyłki InPost, okno **15:00–17:00**, adres Walońska 7/84.
  RAZ dziennie (idempotencja: flaga daty w bazie); kolejne kliknięcia = nic.
  Po 15:00 = za późno na dziś (następny dzień / info). Dotyczy InPost (PL), nie
  Furgonetki.

- **NOWE: weekend (nice-to-have, moja rekomendacja: wersja LEAN)** —
  a) zamówienie czw 18:00 → pt 15:00 = oznacz jako weekendowe (dostawa sobota),
     flagi `saturday_delivery`/weekend w API — złożone, per-przewoźnik → v2;
  b) zamówienie w sobotę → **push do Antoniego „nadać dziś?"** (proste, wartościowe)
     → jeśli tak, nadaj; jak nie, poniedziałek. → robimy TYLKO (b) teraz, (a) na v2.

- **Kolejność:** (1) pipeline zagranica full-auto + faktura firmy zagr. wstrzymaj,
  (2) formularz (koszt dostawy + paczkomat tylko PL numer), (3) odbiór InPost
  dispatch_order z fulfillment, (4) weekend-lean (b). Auto-cancel + duty + weekend(a) = v2.

## Architektura (lustro ShipX)

- Tabela `wyceny_shipments` już ma `provider` (`shipx | furgonetka`) i `label_url`
  → **bez migracji**.
- Nowy moduł `apps/shared/server/wyceny-furgonetka.js` — bliźniak
  `wyceny-shipx.js`: token-cache + `calculatePrice`, `createPackage`,
  `orderPackage`, `schedulePickup`/`getPickup`, `downloadLabel` (A6), `getTracking`,
  `mapTrackingStatus`.
- Env: `FURGONETKA_CLIENT_ID`, `FURGONETKA_CLIENT_SECRET`, `FURGONETKA_API_BASE`,
  opcj. `FURGONETKA_LABEL_FORMAT` (domyślnie A6).
- Pipeline (`wyceny-pipeline.js`): tam gdzie dziś `krokPrzesylka` (ShipX) dla PL —
  dla `jestZagranica` wołaj `krokPrzesylkaFurgonetka`: najtańsza oferta → paczka →
  order → pickup → label A6 → `wyceny_shipments (provider='furgonetka')` →
  `notifyFulfillment` + push „Kurier zamówiony, odbiór o HH:MM".

## Kolejność buildu

1. **Dopłata na fakturze** (server, samodzielne, testowalne od razu). ✅ najpierw
2. **Formularz**: koszt dostawy (PL darmowa / EU 50 / poza 100) + ukrycie
   paczkomatu i wymuszenie kuriera dla zagranicy. (Antoni wkleja liquid SAM.)
3. **Moduł Furgonetki** (OAuth pewny; payloady dopięte na sandboxie po creds).
4. **Pipeline**: routing zagranica→Furgonetka (auto), pickup-push, A6, B2B-hold.

## Prerekwizyty (Antoni)

- Konto Furgonetka z podpiętymi kurierami **międzynarodowymi**.
- Aplikacja OAuth (`furgonetka.pl/api/aplikacje-oauth`) → `client_id` + `client_secret`
  (najpierw sandbox).
- Dane nadawcy/odbioru (adres, godziny) ustawione w koncie Furgonetki.
