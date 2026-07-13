# Build: Panel Statystyk — guardrails (WKLEJ DO CZATU, KTÓRY BUDUJE)

> Cel: panel `/statystyki` z fasadą `/api/stats/*` (backend: Supabase + Zernio) — **czysty panel statystyk, nic więcej.** AI-doradca to osobna rzecz (`docs/doradca-ai-build.md`), NIE budowana tu i NIE kształtująca tego panelu. Dokument = twarde zasady, żeby build nie wpadł w miny w danych. Z analizy realnej bazy LumLum (lip 2026).

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

## 4. Snapshot (Grupa G) — obraz firmy na jeden rzut oka

`GET /api/stats/snapshot` = jeden bogaty rollup na rano (ekran startowy panelu): KPI + stan pipeline'u + alerty, bez klikania po grupach. Przydatny sam w sobie i najczęściej otwierany — zrób go bogaty.

Snapshot (liczony cronem rano + na żądanie) powinien zawierać co najmniej:
- KPI: przychód MTD + delta vs poprzedni mies., AOV, close rate (kohortowy), liczba zamówień.
- Pipeline: liczba + wartość otwartych wycen, **top 10 martwych do dzwonienia** (id, kwota, tel, wiek, owner).
- Outreach: % dodzwonień, śr. speed-to-lead, leady nietknięte.
- Leady: lejek po etapach + rozkład organic/paid.
- Paid (gdy E gotowe): top 3 reklamy po PRZYCHODZIE i po CAC/ROAS, spend MTD.
- `alerts[]`: martwe wyceny > próg, spadek dodzwonień, reklama z rosnącym CAC itd.

Grupy A–F służą do doszczegółowienia z panelu („pokaż wszystkie wyceny 5k+ z maja").

---

## 5. AI-doradca — POZA ZAKRESEM tego panelu

Doradca AI to osobna rzecz, budowana osobno (`docs/doradca-ai-build.md`). **Nie buduj go tutaj i nie kształtuj pod niego panelu.** Panel ma być dobrym panelem statystyk — koniec. Jeśli kiedyś doradca powstanie, podepnie się pod te same publiczne endpointy `/api/stats/*` jak każdy inny konsument; nic specjalnego w panelu robić nie trzeba.

---

## 6. Kolejność buildu

1. **A–D (Supabase, dane kompletne)** — endpointy sprzedaż/pipeline/outreach/leady + snapshot G. Najważniejsze liczby (268k pipeline, close rate, dodzwonienia) dostępne od razu. Zero zależności zewnętrznych.
2. **E–F (Zernio)** — klient `/ads` + `/analytics`, mapowanie pól, atrybucja (sekcja 3) → wzrok marketingowy.
3. **Dokładki**: głębsze widoki, eksporty.

Efekt: panel użyteczny na sprzedaży/pipeline zanim dołożysz hydraulikę marketingu.

---

## 7. Definition of done dla v1

- `/api/stats/*` grupy A–D zwracają liczby zgodne z definicjami z sekcji 1 (zwłaszcza close rate kohortowy).
- `GET /api/stats/snapshot` (G) zwraca bogaty rollup z sekcji 4 + `alerts[]`.
- Panel `/statystyki` w hubie (za auth) pokazuje snapshot + grupy.
- Ani jedna liczba nie pochodzi ze skażonych źródeł (Ilość telefonów, Wyceny B2C, owner-jako-wynik).

---

> ✅ **Zweryfikowane na żywej bazie 2026-07-13** (odczytowo, service-role): `wyceny`=**433** (kanoniczna) / `"Wyceny B2C"`=**70** (legacy); owner ZAMÓWIEŃ = **Antoni 298 / Lorenzo 2** (artefakt migracji — Lorenzo ma realnie **44** wyceny od 2026-03-20, więc filtruj po dacie, nie po lifetime-owner); przychód ratio=**1.000, 0 rabatów**; AOV=**1699 zł**; pipeline otwarty (`typ='WYCENA' AND status='Open'`) = **120 / 270 079 zł / 76 dni**; przychód all-time ZAMÓWIEŃ=**504 512 zł**. Wszystkie load-bearing liczby dokumentu potwierdzone.
