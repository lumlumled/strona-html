# Plan na jutro (2026-07-14): wpięcie Furgonetki w pipeline

> To-do na jutro. Szczegóły i uzgodnienia: [furgonetka-zagranica-spec.md](furgonetka-zagranica-spec.md).
> Ten plik = lista kroków „do zrobienia", nie dyskusja.

## Stan na dziś (2026-07-13) — GOTOWE i zakomitowane

- ✅ Moduł `apps/shared/server/wyceny-furgonetka.js` — OAuth (password + rotujący
  refresh w Supabase), `calculatePrice` (envelope), `createPackage` (flat),
  `orderPackage` (PUT `/order-commands/{uuid}`), `downloadLabel` A6, `getTracking`,
  allow-lista DPD/DHL/FedEx/UPS. **Order POTWIERDZONY na żywym API.**
- ✅ Migracja `006_furgonetka_oauth.sql` — zastosowana, token id=1 zasiany, rotacja działa.
- ✅ Dopłata do wysyłki na fakturze: `wyceny-infakt.js` `shippingSurchargePLN`
  (PL 0 / EU 50 / poza 100) + pozycja „Wysyłka zagraniczna" 23% VAT; wpięte w pipeline.
- ✅ Poprawka 6000K w parserze szybkiej wyceny.
- ✅ ShipX nadawca → Wrocław, Walońska 7/84.
- ✅ Env Vercel: `FURGONETKA_CLIENT_ID`, `FURGONETKA_CLIENT_SECRET` (prod+preview).
- ✅ Spec zagranica (decyzje: full-auto + duty-guard, weekend-lean, odbiór InPost).
- ✅ Testowa paczka 265495569 — **anulowana przez Antoniego**.

## Decyzje wykonawcze (zatwierdzone)

- **Rollout = FULL AUTO.** Zagraniczny klient prywatny: auto najtańszy dozwolony
  kurier → order → etykieta A6 → push do Antoniego z godziną odbioru.
- **Duty-guard:** kraje z cłem (US + UK/CH/NO/UA + całe spoza UE) → **wstrzymaj +
  push**, nie zamawiaj (bez danych celnych order padnie). UE → full auto.
- **Faktura firmy zagranicznej → wstrzymaj + push** (odwrotne obciążenie, ręcznie).
- **Weekend = LEAN:** tylko sobotni push „nadać dziś?" (pełna logika czw→pt = v2).
- **Auto-cancel Furgonetki = v2** (nie na happy-path).

## Do zrobienia jutro — kolejność

### 1. Pipeline zagranica full-auto (RDZEŃ) — `wyceny-pipeline.js`
Bez tego moduł Furgonetki nie działa w prod. To keystone.

- [x] Routing przewoźnika w kroku przesyłki:
  - dostawa PL **i** telefon +48 → InPost (ShipX), bez zmian, paczkomat OK;
  - dostawa PL **ale** telefon nie-+48 → Furgonetka kurier;
  - dostawa ≠ PL → Furgonetka kurier.
  - Warunek Furgonetki: `ship_country != 'PL'` **OR** `!telefon.startsWith('+48'/'48')`.
- [x] `krokPrzesylkaFurgonetka`: `calculatePrice` → najtańsza z allow-listy →
  `createPackage` → `orderPackage` → `getTracking`/pickup → `downloadLabel` A6 →
  zapis `wyceny_shipments (provider='furgonetka', label_url, tracking)`.
- [x] **Duty-guard**: jeśli kraj poza UE (US/UK/CH/NO/UA/…) → NIE zamawiaj,
  ustaw status wstrzymania + `notifyUser` push do Antoniego „zagraniczne cło —
  dokończ ręcznie". (UE = leci automatem.)
- [x] **Faktura firmy zagranicznej**: jeśli zagranica **i** NIP/firma → NIE
  wystawiaj faktury automatycznie, wstrzymaj + push „firma zagr., wystaw ręcznie
  (odwrotne obciążenie)". Klient prywatny zagr. → faktura 23% + dopłata (jest).
- [x] Push sukcesu: „Kurier <przewoźnik> zamówiony, odbiór o HH:MM, etykieta A6" +
  `notifyFulfillment`.
- **Gotowe gdy:** zagraniczne opłacone zamówienie prywatne (UE) samo tworzy paczkę,
  zamawia kuriera, etykieta A6 w `wyceny_shipments`, push z godziną. Poza-UE i firma
  zagr. → wstrzymane + push, zero błędnej faktury/orderu.
- ⚠️ Nie da się przetestować w pełni bez realnego zagranicznego opłaconego
  zamówienia. Testować d0: mock wyceny UE (np. DE) na sandbox/creds, potem 1
  kontrolowany real z natychmiastowym anulowaniem w panelu.

### 2. Formularz — koszt dostawy + paczkomat tylko PL numer
(Antoni wkleja liquid do Shopify SAM — ja przygotowuję kod/snippet.)

- [x] Koszt dostawy w formularzu: PL „Przesyłka darmowa" / EU „50 zł" / poza „100 zł"
  (ta sama reguła co faktura).
- [x] Obcy prefiks telefonu → **ukryj opcję paczkomatu** + komunikat „Chcesz
  dostawę do paczkomatu? Podaj polski numer telefonu."
- [x] Zagranica → wymuś kuriera (COD już zablokowany).
- **Gotowe gdy:** zmiana kraju/prefiksu na żywo aktualizuje koszt i widoczność paczkomatu.

### 3. Odbiór kuriera InPost (dispatch_order) z /fulfillment
- [x] Przy pierwszym „Drukuj etykietę"/„Oznacz" danego dnia (przed 15:00) →
  `POST /v1/organizations/{id}/dispatch_orders` (ShipX) na dzisiejsze gotowe
  przesyłki InPost, okno **15:00–17:00**, adres Walońska 7/84.
- [x] Idempotencja: flaga daty w bazie — RAZ dziennie; kolejne kliknięcia = nic.
- [x] Po 15:00 → za późno na dziś (info/następny dzień).
- **Gotowe gdy:** 3 kliknięcia tego samego dnia = 1 podjazd; potwierdzenie w panelu.
- Uwaga: potwierdzić dokładny kształt `dispatch_orders` w ShipX (organization_id,
  numbering, okno godzinowe) — sonda jak przy Furgonetce.

### 4. Weekend-lean (b)
- [x] Zamówienie przyjęte w sobotę → push do Antoniego „nadać dziś?" (tak → nadaj,
  nie → poniedziałek).
- **Gotowe gdy:** sobotnie opłacone zamówienie generuje push z akcją.

## Akcje po stronie Antoniego (prerekwizyty)

- [x] ~~Aktywować DHL~~ — NIE DOTYCZY (zbadane na żywym API 2026-07-14): DHL
  JEST aktywny na koncie (PL→PL available, 27,16 zł), ale na umowie brokera
  Furgonetki nie obsługuje tras zagranicznych („Nieobsługiwany kraj" dla DE) —
  to ograniczenie usługi, nie ustawienie konta. Międzynarodowo allow-lista
  efektywnie = DPD/FedEx/UPS (działa); DHL wymagałby własnej umowy DHL Express
  podpiętej w Furgonetce (proces biznesowy, niewart zachodu).
- [ ] **Zrotować `client_secret`** Furgonetki (był wklejony do czatu) — po rotacji
  zaktualizować env Vercel.
- [ ] (Jeśli masz) wkleić z zalogowanej dokumentacji Furgonetki endpoint
  anulowania paczki po `order` oraz format danych celnych (`duty`) — odblokuje v2
  (auto-cancel + poza-UE full auto).

## Odłożone na v2

- Auto-cancel zamówionej paczki Furgonetki (dziś: panel web).
- Poza-UE full auto (wymaga danych celnych `duty`).
- Weekend (a): czw 18:00 → pt 15:00 = paczka weekendowa (`saturday_delivery`, per-przewoźnik).
- Waga z pozycji (`sku_cennik.weight_kg`) zamiast flat `FURGONETKA_WEIGHT_KG`.
