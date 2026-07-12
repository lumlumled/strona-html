# Test E2E systemu — raport + plan napraw (2026-07-12)

Pełny test na produkcji lumlum.dev: wpadnięcie leada → pierwszy kontakt →
wycena → wysłanie linku → pipeline "na sucho" (bez realnej faktury i kuriera).
Dane testowe (lead #409, wycena #1934, user test-e2e) usunięte po teście — zero śladów.

## Wynik: ścieżka główna DZIAŁA

| Etap | Wynik |
|---|---|
| Webhook Zadarmy → nowy lead (stage Nowy, owner default Lorenzo, Log zmian) | ✅ |
| Widoczność: Backlog `nowe`, CRM karta, plan dnia | ✅ |
| Logowanie app_users, 401 bez sesji, hub "dziś" per owner | ✅ |
| Notatka handlowca → GPT wyciąga akcję + termin + Datę Feedbacku | ✅ |
| Zmiana ownera, odhaczenie akcji (log `[Akcja] Zrobione`) | ✅ |
| Parser GPT wyceny (SKU z cennika + zdjęcie) | ✅ (patrz drobiazgi) |
| POST wyceny: adopcja ownera z leada, form_token, lead_id | ✅ |
| Propagacja feedbacku wycena→lead (najbliższy termin wygrywa) + feedback_watch (stary watch rozwiązany, nowe założone) | ✅ |
| wyslij-link → FORM_SENT + event | ✅ |
| Publiczny `/formularz/api/dane`: dobry token 200, zły 404, strona testowa renderuje | ✅ |
| Klucze inFakt + ShipX (walidacja read-only), Gmail `kontakt@lumlum.co` (token odświeżany), worker (auth 401 bez sekretu), tracking czytany, brak wycen w ERROR | ✅ |

**Nie testowane celowo:** submit formularza → pipeline (tworzy realną proformę
inFakt + mail) i pełne opłacenie (FV/KSeF/kurier). To pokrywa test kontrolny
z `docs/cutover-noc2-checklista.md`.

---

## Znaleziska i plan napraw

### 1. ~~Zamówienie w kolejce Make~~ — WYJAŚNIONE
Scenariusz "Formularz LumLum - post" padł 12.07 14:11 (BundleValidationError),
1 zdarzenie w kolejce huka "Order-post". **Antoni potwierdził: to był pusty
strzał bez payloadu, żaden klient nie przepadł.** Cutover na nowy system robimy
dziś ręcznie wg checklisty — po nim ten scenariusz i tak idzie do dezaktywacji.

### 2. Leady z Facebooka → prosto do naszej bazy (DO ZROBIENIA, nowy czat)
Scenariusz Make "Nowy Lead B2C" (id 4899161) jest nieaktywny, na hooku
"Leady B2C" wisi ~16 zdarzeń. Decyzja: zamiast reanimować zapis do Sheets,
Make będzie strzelał **API callem do naszej bazy** (tabela `Leady B2C`).

**Co trzeba zbudować (endpoint jeszcze NIE istnieje):**
nowy publiczny webhook w Backlogu, wzorowany na webhoooku Zadarmy
(`apps/backlog-b2c/server/server.js`, sekcja `publicPrefixes`):

```
POST https://lumlum.dev/backlog-b2c/api/webhooks/lead?token=<LEAD_WEBHOOK_TOKEN>
Content-Type: application/json
```

**Payload (mapowanie 1:1 z modułu Facebook Lead Ads w Make):**
```json
{
  "zrodlo": "Facebook Lead Ads",
  "imie_nazwisko": "{{name / full_name}}",
  "telefon": "{{phone_number}}",
  "email": "{{email}}",
  "facebook_leads_id": "{{id leada z FB}}",
  "ad_name": "{{ad_name}}",
  "form_name": "{{form_name}}",
  "opis": "{{sklejone pozostałe pola formularza FB, np. pytania}}"
}
```

**Logika serwera (spec dla nowego czatu):**
- token z env `LEAD_WEBHOOK_TOKEN` (nowa zmienna, nie reużywać Zadarmy),
- dedupe: po `facebook_leads_id`, potem po znormalizowanym telefonie
  (jak `findLeadByPhone`) — duplikat = update `Ostatni kontakt`, nie nowy wiersz,
- insert do `Leady B2C`: `Name`, `Phone number` (Number z samych cyfr),
  `Email`, `Facebook Leads ID`, `ad_name`, `Date` (DD.MM.YYYY Warszawa),
  `Deal stage: 'Nowy'`, `Źródło: 'Facebook Lead Ads'`, `ID Leada` = max+1
  (jak w webhooku Zadarmy), Owner zostawić pusty (DB default Lorenzo),
- wpis do `Log zmian` (`zrodlo: 'facebook_webhook'`),
- odpowiedź `{status:'ok', id_leada}` — Make pokaże ją w historii.

**W Make (robi Antoni, 2 moduły):** trigger Facebook Lead Ads (istniejący hook
"Leady B2C") → HTTP "Make a request" (POST, JSON, powyższy payload). Po
aktywacji scenariusza Make **sam przetworzy zaległą kolejkę** (~16 zdarzeń) —
one nie przepadły.

### 3. Retry pipeline'u łapie zamówienia Shopify (DO ZROBIENIA — PRZED dodaniem tokenu!)
Retry w `apps/shared/server/wyceny-pipeline.js` (~linia 535) wyklucza tylko
`source='import'`. Zamówienie Shopify bez fulfillmentu wchodzi jako
`form_status=SUBMITTED` + `process_stage=SUBMITTED` → `startPipeline` → realna
przesyłka ShipX + proforma. Zdarzyło się 12.07 z #1877 (order #111064, 2 próby,
zatrzymała je tylko walidacja adresu).

**Fix krok 1 (jedna linijka, bezpieczny natychmiast):** dodać
`.neq('source','shopify')` do zapytania retry. **Zrobić PRZED dodaniem
`SHOPIFY_ADMIN_TOKEN` na Vercel** — inaczej pierwszy niewysłany order sklepu
znów odpali pipeline.

**Fix krok 2 (decyzja Antoniego — fulfillment Shopify półręcznie):**
zamówienia Shopify pokazują się w panelu Sprzedaże z adresem "jednym blobem";
Antoni chce je nadawać z panelu, ale ShipX wymaga rozbicia (ulica / nr budynku
/ nr lokalu / kod / miasto). Plan:
- w karcie sprzedaży Shopify pokazać surowy adres (`address1 + address2`)
  nad polami wysyłki,
- auto-parse heurystyką (regex: `"(.+?)\s+(\d+\w*)(?:\s*/\s*(\w+))?$"` na
  address1 → ulica/nr/lokal; kod `\d\d-\d\d\d`; reszta z pól Shopify), pola
  zostają EDYTOWALNE — Antoni poprawia i klika "Zamów kuriera" (istniejący
  reship/przesyłka), zamiast automatu w tle,
- e-mail/telefon: jeśli brak w zamówieniu → pole puste + wyraźny znacznik,
  nie blokować nadania,
- Furgonetka (zagranica) ma własny parser adresu przy imporcie — dla PL
  zostajemy przy ShipX + własny parse jak wyżej.

### 4. Czasy rozmów Zadarmy +3h (DO ZROBIENIA, nowy czat)
Zadarma wysyła `callstart` w strefie konta (~UTC+3), kod parsuje jako UTC
i formatuje na Warszawę: rozmowa z 20:29 PL zapisuje się jako "23:28".
Dotyczy `Historia rozmów` i `Ostatni kontakt`.

**Rekomendacja: naprawić w kodzie, nie w panelu Zadarmy** (zmiana strefy konta
Zadarma przestawiłaby też widoki/wykazy, z których korzysta Make i panel):
w webhooku (`apps/backlog-b2c/server/server.js`, obsługa `call.callstart`)
ignorować `callstart` przy stemplu do Historii i brać **czas przyjścia
webhooka** (`new Date()` → `warsawDateTimeStr`) — webhook przychodzi sekundy
po rozmowie, błąd max ~1 min zamiast 3 h. `Ostatni kontakt` zapisywać już
przeliczony na Warszawę, nie surowy string. (Alternatywa: env
`ZADARMA_TZ_OFFSET=+3` i przeliczanie — kruche przy zmianie czasu, odradzam.)

### 5. Martwy hook "nowy lead z nieznanego numeru" (czeka na URL od Antoniego)
O co chodzi: gdy dzwoni ktoś, kogo nie ma w bazie, system tworzy leada
i strzela powiadomieniem na hardcodowany webhook Make
(`NEW_LEAD_WEBHOOK_URL` w `apps/backlog-b2c/server/server.js:123`) — była to
osobista automatyzacja-powiadomienie Antoniego. Ten hook już **nie istnieje**
w Make, więc powiadomienie cicho pada (lead i tak się tworzy).
**Naprawa:** Antoni tworzy w Make nowy scenariusz z triggerem "Custom webhook"
(+ np. Telegram do siebie), wysyła URL → podmiana jednej linijki + deploy.
Docelowo można zastąpić własnym pushem (Web Push już działa), wtedy Make
niepotrzebny.

### 6. Kosmetyka: etykiety na karcie leada (`_ma_wycene`)
Tak — to dokładnie ta etykieta. Flaga `_ma_wycene` (i `GET /:telefon/wycena`)
czyta STARĄ tabelę "Wyceny B2C", więc dla wycen z nowego systemu jest `false`
i karta pokazuje "Proponowana kwota"/"Data przedstawienia oferty" zamiast
"Kwota"/"Data wyceny" (+ nie chowa pól legacy "Produkty złapane z rozmowy",
"Link do formularza"). Sekcja wycen na karcie używa nowego `dla-leada`
i działa dobrze. **Fix:** liczyć `_ma_wycene` z tabeli `wyceny`
(lead_id/telefon), `apps/shared/server/leady-endpoints.js:285`.

### 7. Parser wyceny — jakość na dziwnych wejściach
W teście gpt-5-mini przekręcił sztuczny numer (48999000111 → +484999000111)
i nie wyciągnął imienia z tekstu z prefiksem "[TEST E2E]". Wejście było
nietypowe (prefiks testowy, nieistniejący prefiks 999) — na realnych
dyktowanych tekstach dotąd działał. Uwaga: **modele gpt-5 nie przyjmują
temperatury** — kręci się tym `reasoning effort`, dziś ustawiony `minimal`.
Tani eksperyment bez deployu: env na Vercel `WYCENY_PARSER_EFFORT=low`
(albo `WYCENY_PARSER_MODEL=gpt-5` na pełny model, drożej/wolniej).
Telefon i tak przechodzi przez podgląd przed zapisem — ryzyko małe.

### 8. Bez zmian / świadome
- Watchdog feedbacku: endpoint + dispatcher są, **brak joba pg_cron** — domyka
  drugi czat (nie ruszać jego plików).
- Link formularza bez tokenu przechodzi — celowy okres przejściowy (checklista:
  wymusić token po ~30 dniach).
- `SHOPIFY_ADMIN_TOKEN` — Antoni dodaje na Vercel **PO** fixie z pkt 3.

---

## Lista do nowego czatu (kolejność)

1. **[1 linijka, PILNE przed tokenem Shopify]** `.neq('source','shopify')`
   w retry workera (`apps/shared/server/wyceny-pipeline.js` ~535) + deploy.
   Dopiero potem Antoni dodaje `SHOPIFY_ADMIN_TOKEN` na Vercel.
2. **Webhook leadów z FB**: endpoint `POST /backlog-b2c/api/webhooks/lead`
   wg specu z pkt 2 (token `LEAD_WEBHOOK_TOKEN`, dedupe, Log zmian) + deploy +
   env; potem Antoni składa scenariusz w Make (FB trigger → HTTP POST)
   i aktywuje — kolejka 16 zdarzeń przetworzy się sama.
3. **Czasy Zadarmy**: stempel Historii z czasu przyjścia webhooka zamiast
   `callstart`; `Ostatni kontakt` przeliczony na Warszawę (pkt 4).
4. **Fulfillment Shopify półręcznie**: surowy adres + auto-parse + edytowalne
   pola + "Zamów kuriera" z karty (pkt 3, krok 2).
5. **`_ma_wycene` z nowej tabeli** (pkt 6, `leady-endpoints.js:285`).
6. **Hook nowego leada**: podmienić `NEW_LEAD_WEBHOOK_URL` na nowy URL od
   Antoniego (albo zastąpić Web Pushem) (pkt 5).
7. (Opcjonalnie) env `WYCENY_PARSER_EFFORT=low` i szybki re-test parsera (pkt 7).
