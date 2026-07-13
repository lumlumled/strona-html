# Build: Panel Statystyk + AI-doradca — guardrails (WKLEJ DO CZATU, KTÓRY BUDUJE)

> Cel: panel `/statystyki` z fasadą `/api/stats/*` (backend: Supabase + Zernio). **Zakres tego czatu = TYLKO panel + endpointy (warstwa danych).** AI-doradca to **OSOBNY build** (`docs/doradca-ai-build.md`) — nie buduj go tutaj; ten panel ma go tylko *nakarmić* czystymi endpointami. Dokument to twarde zasady, żeby build nie wpadł w miny w danych. Z analizy realnej bazy LumLum (lip 2026).

---

## 0. Architektura (nie negocjowalne)

- **Jedna fasada `/api/stats/*`** — AI-doradca pyta TYLKO to, nigdy bazy/Zernio bezpośrednio. Doradca dostaje **jedno narzędzie** `stats(group, params)`, read-only, z limitem rozmiaru wyniku. Zero surowego SQL na prod z poziomu modelu.
- **Marketing leci z Zernio, nie z Make.** Zernio (`ZERNIO_API_KEY`, wpięty w komunikatorze) pokrywa organik (`/analytics`) i paid (`/ads`) + push konwersji do Mety + tag `comment.ad`. **Webhooki Make ingest/ad-spend/organic są zbędne — nie budować.** (Jeśli gdzieś w specu jest „marketing przez Make" — to nieaktualne.)
- **Szybkość doradcy = snapshot jako kontekst + streaming + szybki model.** Patrz sekcja 4. To jest wymóg produktowy („ma odpowiadać od razu jak Claude w przeglądarce"), nie nice-to-have.

---

## 1. TWARDE definicje metryk (zdefiniuj RAZ, używaj wszędzie)

Bez tego doradca poda wiarygodnie wyglądające, ale niespójne liczby.

- **Close rate = KOHORTOWY, ale TYLKO FORWARD (wyceny z panelu).** „Z wycen wysłanych w okresie X — jaki % stał się zamówieniem". Konwersja = ten sam `id` przeskakuje `WYCENA→ZAMÓWIENIE` (wyceny-endpoints.js:759), więc kohortę śledzi się po `created_at` + `typ`. **MINA (zweryfikowane 2026-07-13):** historia to IMPORT ze starego systemu — 252 ZAMÓWIENIA + 126 WYCEN zaciągnięte jako DWA NIEPOWIĄZANE worki (zamówienia bez zapisanego linku do wyceny). Liczenie close rate po całym imporcie = fałszywe ~66% (252 DELIVERED / 381). **Licz wyłącznie z `source ∉ {import, shopify}`** (wyceny zrobione w panelu; dziś ~4 quick-add, 0 domkniętych → `null`/„buduje się" dopóki próbka < ~15). Rośnie z każdą nową wyceną. NIE „zamknięte_w_tym_miesiącu / wszystkie" — naiwna wersja kłamie. To metryka pytana najczęściej.
- **Przychód (revenue) = `coalesce(kwota_sprzedazy_brutto, kwota_proponowana_brutto)`** dla `typ='ZAMÓWIENIE'`. Dla domkniętych obie kwoty są równe (sprawdzone: ratio 1.000, brak ukrytych rabatów). Wszystko brutto (VAT 23%).
- **AOV** = średni przychód/zamówienie (brutto). Referencyjnie ~1 600 zł brutto.
- **Kontrybucja** (cel właściciela = 100k/mies.) = po towarze i reklamie, PRZED pensjami i podatkiem. Marża brutto blended ~74% (z `sku_cennik.koszty` → `zakup_netto`, `marza_pct`). Netto = brutto/1,23.
- **Pipeline otwarty** = `wyceny WHERE typ='WYCENA' AND status='Open'` → wartość = `kwota_proponowana_brutto`, wiek = `now() - created_at`. (Aktualnie ~119 wycen / ~268k zł, śr. wiek 76 dni.)
- **Speed-to-lead** = czas od powstania leada do pierwszego wychodzącego telefonu. **% dodzwonień** = kontakty / próby.

---

## 2. PUŁAPKI DANYCH (najważniejsza sekcja — tu build się wykłada po cichu)

1. **Dwie tabele wycen — używaj TYLKO `wyceny` (437 wierszy, kanoniczna).** `"Wyceny B2C"` (70 wierszy) to LEGACY z migracji — NIE licz z niej metryk. Panel B/A czyta `wyceny`.
2. **`"Leady B2C"."Ilość telefonów"` jest SKAŻONA** (legacy string-konkatenacja). Liczbę telefonów licz z **`"Log zmian"`** po telefonie, wykluczając źródła nie-telefoniczne (`NIE_TELEFON_ZRODLA`: notatka_handlowca / manual_akcja / manual_crm). Wzorzec jest już w kodzie: `fetchCallCountByPhone` w `apps/backlog-b2c/server/server.js`. Reuse, nie wymyślaj.
3. **`owner` w `wyceny` to ARTEFAKT MIGRACJI** (Antoni = default dla historii). **Doradca NIE może raportować „Lorenzo 2 / Antoni 298" jako wyniku pracy handlowca** — owner jest wiarygodny dopiero OD TERAZ w przód. Dla pytań „jak idzie Lorenzo" filtruj po dacie ≥ startu jego pracy, nie po całej historii.
4. **Daty w `"Leady B2C"` to TEXT** (`Date`, `Data Feedbacku`, `Ostatni kontakt`, `Data wysłania wyceny`) — parsuj przez istniejący `parseLeadDate`, nie rzutuj naiwnie. W `wyceny` daty to prawdziwe `timestamptz` (OK).
5. **Leady ↔ wyceny nie mają FK** — łączą się po telefonie (`telefon_digits` / znormalizowany `Phone number`). `"ID Leada"` (mały int) ≠ numer wyceny (`#1659`). Nie myl.
6. **Dedup leadów po telefonie** — FB Lead Ads wysyła ten sam formularz 2×; bez dedupu ten sam człowiek liczy się podwójnie w lejku.
7. **B2B** = `invoice_company_nip` niepuste (w `wyceny`). **Powroty** = grupowanie zamówień po `telefon_digits`, count > 1.

---

## 3. Grupa E (paid/atrybucja) — najkruchsze miejsce, zrób pedantycznie

- **Klucz złączenia Zernio(ad) ↔ lead ↔ wycena ↔ sprzedaż MUSI być pewny.** Leady mają `ad_name` (tekst) + `marketing_meta` (jsonb); Zernio ma id kampanii/adsetu/reklamy + `comment.ad`. **Ustal jeden stabilny klucz** (najlepiej FB lead id / ad id z `marketing_meta`, nie fuzzy match po `ad_name` — nazwy się zmieniają). Zły klucz = wiarygodnie wyglądający, ale BŁĘDNY ROAS, na którym doradca oprze rekomendację budżetu.
- Lejek per reklama liczy się do KOŃCA: reklama → lead → wycena → **sprzedaż → przychód** (nie zatrzymuj na leadach). Pytanie biznesowe brzmi „która reklama robi KASĘ, nie leady".
- Pola paid (spend/CTR/CAC/ROAS) — dokładne nazwy weź z **OpenAPI 3.1 Zernio** przy buildzie (docs cienkie, spec pełny). Zmapuj raz, trzymaj w jednym module klienta.
- Wykorzystaj **push konwersji Zernio→Meta** („ten lead był świetny → optymalizuj pod podobnych") — to realna dźwignia jakości leadów, nie tylko raport.

---

## 4. Snapshot (Grupa G) — to jest sufit szybkości I trafności doradcy

**Zasada: 80% pytań doradca ma odpowiadać z samego snapshotu G, BEZ round-tripu do A–F.** Jeśli G jest chudy, model dopytuje bazę co pytanie = wolno (dokładnie to, czego nie chcemy). Inwestuj w G.

Snapshot (liczony cronem rano + na żądanie) powinien zawierać co najmniej:
- KPI: przychód MTD + delta vs poprzedni mies., AOV, close rate (kohortowy), liczba zamówień.
- Pipeline: liczba + wartość otwartych wycen, **top 10 martwych do dzwonienia** (id, kwota, tel, wiek, owner).
- Outreach: % dodzwonień, śr. speed-to-lead, leady nietknięte.
- Leady: lejek po etapach + rozkład organic/paid.
- Paid (gdy E gotowe): top 3 reklamy po PRZYCHODZIE i po CAC/ROAS, spend MTD.
- `alerts[]`: martwe wyceny > próg, spadek dodzwonień, reklama z rosnącym CAC itd.

Snapshot wstrzykiwany do promptu doradcy co turę → odpowiedź natychmiast; A–F tylko na doszczegółowienie („pokaż wszystkie wyceny 5k+ z maja").

---

## 5. Styk z AI-doradcą — panel TYLKO wystawia dane (doradca = OSOBNY build)

> **Nie budujesz doradcy w tym czacie.** Jedyny obowiązek panelu = wystawić czysty, stabilny **kontrakt danych**, pod który ktoś inny (build doradcy: `docs/doradca-ai-build.md` + `docs/fable-doradca-lumlum.md`) się podepnie.

**Co panel MUSI wystawić (kontrakt — to jest Twoje zadanie):**
- `GET /api/stats/snapshot` — bogaty rollup z sekcji 4 + `alerts[]`, jeden strzał, szybki. To główne źródło wiedzy doradcy.
- `GET /api/stats/{grupa}` (A–F) z parametrami scope — na doszczegółowienie.
- read-only, limit rozmiaru wyniku, auth huba, **stabilny, udokumentowany JSON** (doradca koduje pod ten kształt — zmiana pola bez zapowiedzi psuje doradcę).

**Czego panel NIE robi:** nie zna promptu, nie streamuje, nie woła modelu, nie trzyma pamięci doradcy. To warstwa danych. Kropka.

Poniższe (prompt/narzędzie/streaming/pamięć/tryb głęboki) należą do **osobnego buildu doradcy** — są tu wyłącznie po to, żebyś projektując kontrakt wiedział, pod co ktoś będzie kodował:

- **Mózg = CAŁA treść `docs/fable-doradca-lumlum.md`, wklejona VERBATIM jako system prompt.** Zawiera charakter, strategię, cele, twarde zasady ORAZ **sekcję 9 „Tryb głęboki — ślepe plamy i niewygodne prawdy"** — wymagane zachowanie doradcy.
- **Gdzie doradca szuka danych:** jedyne źródło to fasada `/api/stats/*`, grupy A–G rozpisane w `docs/statystyki-panel-spec.md` (backend: Supabase + Zernio). Doradca nie zna bazy — zna tylko `stats()`.
- **Narzędzie = jedno**: `stats(group, params)` → `/api/stats/*`, read-only, limit wyniku.
- **WYMÓG GŁĘBI: pozwól na WIELE kolejnych wywołań `stats()` w jednej odpowiedzi.** Doradca ma iść w głąb — łańcuch: zobacz snapshot → zauważ anomalię → dociągnij szczegół grupy → skoreluj z inną grupą → dopiero potem odpowiedz. NIE ograniczaj do jednego tool-shota; sekcja 9 promptu (drugie dno, korelacje, ślepe plamy, niewygodne prawdy) wymaga, żeby mógł kopać, zanim odpowie. Płytki, jedno-strzałowy doradca = porażka tego projektu.
- **Kontekst = snapshot G** wstrzykiwany co turę (sekcja 4) — baza do szybkich odpowiedzi; głębsze grupy na doszczegółowienie/kopanie.
- **Streaming (SSE)** — token po tokenie, daje uczucie „od razu".
- **Szybki model** do czatu (Fable/Haiku/Sonnet); Opus na głęboką analizę na żądanie.
- **Pamięć** (`doradca_memory`: ustalenia, obietnice, rzeczy odkładane — sekcja 9 pkt 6 „Co pomijasz" tego wymaga do accountability) i **proaktywność** (cron „plan na dziś" + tygodniowe „Co pomijasz" → push) = DOKŁADKA po v0, ale zaprojektuj schemat od razu.
- Bezpieczeństwo: read-only, limity, auth huba, żadnego surowego SQL z modelu.

---

## 6. Kolejność buildu (żeby doradca żył szybko na tym, co ważne)

1. **A–D (Supabase, dane kompletne)** — endpointy sprzedaż/pipeline/outreach/leady + snapshot G nad A–D. **Doradca od razu użyteczny na najwyższej dźwigni** (268k pipeline, close rate, dodzwonienia). Zero zależności zewnętrznych.
2. **E–F (Zernio)** — klient `/ads` + `/analytics`, mapowanie pól, atrybucja (sekcja 3). Doradca dostaje wzrok marketingowy.
3. **Dokładki**: pamięć doradcy, proaktywny push, głębsze narzędzia.

Efekt: działający „Big Brother" na sprzedaży/pipeline zanim dołożysz hydraulikę marketingu — właściwa kolejność.

---

## 7. Definition of done dla v1

- `/api/stats/*` grupy A–D zwracają liczby zgodne z definicjami z sekcji 1 (zwłaszcza close rate kohortowy).
- `GET /api/stats/snapshot` (G) zwraca bogaty rollup z sekcji 4 + `alerts[]`.
- Czat doradcy w hubie: streaming, snapshot w kontekście, jedno narzędzie `stats()`, prompt Fable, szybki model.
- Ani jedna liczba nie pochodzi ze skażonych źródeł (Ilość telefonów, Wyceny B2C, owner-jako-wynik).

---

> ✅ **Zweryfikowane na żywej bazie 2026-07-13** (odczytowo, service-role): `wyceny`=**433** (kanoniczna) / `"Wyceny B2C"`=**70** (legacy); owner ZAMÓWIEŃ = **Antoni 298 / Lorenzo 2** (artefakt migracji — Lorenzo ma realnie **44** wyceny od 2026-03-20, więc filtruj po dacie, nie po lifetime-owner); przychód ratio=**1.000, 0 rabatów**; AOV=**1699 zł**; pipeline otwarty (`typ='WYCENA' AND status='Open'`) = **120 / 270 079 zł / 76 dni**; przychód all-time ZAMÓWIEŃ=**504 512 zł**. Wszystkie load-bearing liczby dokumentu potwierdzone.
