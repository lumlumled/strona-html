# Statystyki — poprawki runda 2 (feedback Antoniego 13.07.2026)

> **STATUS 13.07 wieczór: WYKONANE** (commit „Statystyki v2"). §1 selektor tygodni (4/8/12/26)
> + tydzień pon–nd Europe/Warsaw ✅ · §2 korelacja zasięg↔sprzedaż bez leada (lead_id NULL,
> bez shopify/import) + kontrast z lejka + wnioski ✅ · §4 lej leadów wywalony z Outreach ✅.
> KOREKTA do §4/„czego brakuje": **średni czas rozmowy JEST policzalny już teraz** —
> `Log zmian.czas_trwania_s` pisze webhook Zadarmy (62 rozmowy, mediana 1:08) — kafel działa.
> Ponadto (rozmowa 13.07): cena zaniedbania, prognoza, trzy liczby wejściowe, dowód telefonu,
> krzywa umierania, ściana cenowa, radar B2B, kampanie/hooki po przychodzie, marża realna,
> faktury, TikTok żywy, okna czasu we wszystkich zakładkach.
> ⚠️ MINA danych: wiersze `zadarma_poll` w Log zmian mają `data_zmiany` = czas INSERTU
> (nocny backfill), bez `kierunek`/`handlowiec` — metryki godzinowe/per-autor liczyć
> TYLKO z wierszy z `kierunek` (webhook). Tak robi queries.js.

Panel `lumlum.dev/statystyki` w wersji z 13.07 nie trafia. Ten dokument = parsowany
feedback z wiadomości głosowej + UCZCIWA ocena „co się da teraz vs. czego brakuje
(źródła danych)". Do wykonania w nowym czacie.

Pliki: `apps/statystyki/server/queries.js` (definicje metryk), `apps/statystyki/app.html`
(front, 4 zakładki: Przegląd/Marketing/Outreach/Sprzedaż), `apps/statystyki/server/server.js` (routy).

---

## 1. PRZEGLĄD — wybór zakresu + poprawna definicja tygodnia

**Problem:** pokazuje perspektywę roku; „momentum" liczy ostatnie 7 dni kroczące,
nie tydzień kalendarzowy. Stąd „7 zamówień w tym tygodniu" nie zgadza się z intuicją.

**Do zrobienia:**
- **Selektor zakresu** w Przeglądzie — użytkownik wybiera który tydzień / ile tygodni
  wstecz ogląda (np. „ostatni tydzień", „ostatnie 4 / 12 tyg."). Nie ma być zaszyte na sztywno.
- **Tydzień = poniedziałek–niedziela** (kalendarzowy/ISO), nie 7 dni kroczących.
  „Bieżący tydzień" = od tego poniedziałku do teraz. Poprawić bucketowanie w `przeglad()`
  (funkcja `dm()`/tygodnie w queries.js) na granice Mon–Sun w strefie Europe/Warsaw.
- Momentum „ten tydzień vs poprzedni" liczyć na tych samych granicach Mon–Sun.

## 2. KORELACJA — POPRAWA MODELU (najważniejsze)

**Błąd koncepcyjny obecnej wersji:** korelujemy zasięg organiczny ↔ LEADY.
Antoni: „z organików NIE mamy leadów. Z organików mamy sprzedaże NIEPRZYPISANE do leadów."

Model faktyczny: organiczny content nie tworzy śledzonych leadów w CRM. Tworzy
**sprzedaże bezpośrednie** — ludzie widzą materiał, dzwonią na numer / piszą, kupują,
nigdy nie wchodzą w lejek leadowy. To są `wyceny` typ=ZAMÓWIENIE z **lead_id IS NULL**.

**Do zrobienia:**
- Korelacja główna = **zasięg organiczny (tydzień) ↔ sprzedaże nieprzypisane do leada (tydzień)**.
  Definicja „nieprzypisana sprzedaż": `typ='ZAMÓWIENIE' AND lead_id IS NULL AND source NOT IN ('shopify','import')`
  (Shopify = e-commerce nie-telefoniczne; import = dane historyczne — oba wykluczyć,
  żeby zostały realne telefony/DM „z organika").
- Zostawić też serię sprzedaży przypisanej do leadów jako kontrast (opcjonalnie),
  ale bohaterem korelacji jest sprzedaż nieprzypisana.
- Wnioski (auto) przepisać pod ten model: „gdy X materiał miał duży zasięg → w tym /
  następnym tygodniu wpadło Y sprzedaży bez leada".

## 3. MARKETING — „dalej z dupy"

Ma pokazywać **w perspektywie tygodnia**: CTR, CPC, watch time, a przy materiałach —
watch time, gdzie widz spada, miniaturka.

**Stan danych (sprawdzone w bazie 13.07):**
- Tabela `marketing_organic_posts` MA: `views, reach, likes, comments, shares, saves,
  follows, duration_s (długość filmu), url, title, published_at`.
- **NIE MA: watch time / retencji / punktu spadku, ani CTR/CPC, ani miniaturki.**

**Co się da TERAZ (z tego co wgrane):**
- Per tydzień: zasięg, wyświetlenia, polubienia, zaangażowanie, przyrost obserwujących.
- Ranking materiałów tygodnia po zasięgu/wyświetleniach + link (url).

**Czego brakuje → potrzebne źródło:**
- **CTR / CPC** = metryki PŁATNE. Nie ma ich w organiku. Źródło: Zernio API `/ads`
  (klucz już wpięty) albo Meta Ads, albo Antoni wrzuca eksport płatnych. → sekcja „Płatny".
- **Watch time / retencja / gdzie spada** = per-wideo retention. Standardowy eksport
  CSV tego nie zawiera (wgraliśmy tylko `duration_s`). Opcje: (a) RE-INGEST CSV jeśli
  eksporty TikTok/IG mają kolumnę „average watch time / full video rate" — dołożyć kolumny
  do `marketing_organic_posts`; (b) krzywa spadku sekunda-po-sekundzie = tylko natywne
  analytics platformy → prawdopodobnie Zernio albo ręcznie. Najpierw sprawdzić surowe CSV.
- **Miniaturki** = mamy `url` (permalink), nie obraz. Źródło: oEmbed / Graph API / Zernio.

## 4. OUTREACH — „co to ma być, leję leadów, niepotrzebne"

Ma pokazywać dokładnie 3 rzeczy (to mówił na starcie):
1. **Ile telefonów wykonano** (dziś / w tygodniu).
2. **Średni czas rozmowy.**
3. **Średni czas od pojawienia się leada do pierwszego telefonu** (speed-to-lead).

**Stan danych:**
- Telefony w „Log zmian" pochodzą z webhooka Zadarmy (~od 07.2026) — wpisy „telefon",
  ale **bez czasu trwania rozmowy** w tym co mamy.
- „Ile telefonów" i „czas do pierwszego telefonu" = policzalne z Log zmian (rzadkie/świeże,
  bo webhook młody — komunikować n i okres, nie udawać pełni).
- **Średni czas rozmowy = wymaga logów Zadarmy z `duration`** — nie mamy tego pola
  podpiętego. To jest brakujące źródło do wpięcia (Zadarma call-log API/webhook z duration).

**Do zrobienia:** wywalić obecny „lej leadów" z Outreach. Zostawić 3 kafle:
telefony (n, okres) · średni czas rozmowy (gdy będzie Zadarma; teraz „brak źródła") ·
speed-to-lead (mediana + n). Uczciwe „buduje się / brak danych" zamiast wymyślonych liczb.

---

## Podsumowanie „co się da teraz" (bez nowych integracji)

| Ask | Teraz? | Blokada |
|---|---|---|
| Przegląd: selektor zakresu + tydzień Mon–Sun | ✅ tak | — |
| Korelacja zasięg ↔ sprzedaż nieprzypisana | ✅ tak | — (wyceny.lead_id istnieje) |
| Marketing organiczny per tydzień (zasięg/wyśw./eng.) | ✅ tak | — |
| Marketing: CTR / CPC | ❌ nie | płatne — Zernio `/ads` lub upload |
| Marketing: watch time / gdzie spada | ❌ nie | nie w CSV — re-ingest lub Zernio |
| Marketing: miniaturki | ⚠️ pół | mamy url; obraz → oEmbed/Zernio |
| Outreach: liczba telefonów + speed-to-lead | ✅ tak* | *rzadkie — webhook Zadarmy świeży |
| Outreach: średni czas rozmowy | ❌ nie | logi Zadarmy z `duration` niepodpięte |

**Kolejność w nowym czacie:** 1) Przegląd (zakres + Mon–Sun + korelacja-poprawka) —
w całości z obecnych danych, największa wartość. 2) Outreach 3 kafle uczciwe.
3) Marketing: rozdzielić „mam / potrzebuję źródła", dołożyć watch time po sprawdzeniu
surowych CSV, CTR/CPC dopiero z Zernio/uploadu.
