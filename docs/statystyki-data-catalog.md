# Katalog danych dla wewnętrznego narzędzia AI — co może zapytać, jaki scope, co znajdzie

> Odpowiedź na pytanie: „w którym miejscu narzędzie dostaje dane i o co może zapytać". To nie prompt — to **mapa źródeł**. Narzędzie wewnętrzne (pełny dostęp, token `STATS_API_TOKEN`) pyta NASZE API statystyk; za nim stoją dwa backendy: **Supabase** (sprzedaż, wyceny, telefony, leady) i **Zernio** (`https://zernio.com/api/v1` — organik + paid social, klucz `ZERNIO_API_KEY` już wpięty).

## Architektura (jedno okno dla narzędzia)

```
Narzędzie AI ──GET /statystyki/api/stats/*──►  NASZE API (agreguje)
                                                 ├─ Supabase: wyceny, Leady B2C, Log zmian, kom_*
                                                 └─ Zernio API v1: /analytics (organik), /ads (paid), konwersje
```

Narzędzie NIE pisze SQL i NIE woła Zernio bezpośrednio — pyta nasze API, jednym stylem, z jednym tokenem. Poniżej 7 grup zapytań (A–G).

## Przykładowe pytania → gdzie trafiają

| Narzędzie pyta… | Grupa |
|---|---|
| „Ile sprzedaży w tym tygodniu i za ile?" | A. Sprzedaż |
| „Które wyceny 5k+ wiszą najdłużej?" (lista do dzwonienia) | B. Pipeline |
| „Jaki jest średni czas od leada do pierwszego telefonu?" | C. Outreach |
| „Ile leadów przyszło i z jakich źródeł?" | D. Leady |
| „Która **reklama** dała najwięcej **sprzedaży** (nie leadów) i jaki ma koszt?" | E. Paid |
| „Ile zasięgu/zaangażowania miał ostatni post na IG/TikToku?" | F. Organik |
| „Daj mi jeden obraz firmy na dziś rano." | G. Snapshot |

---

## A. SPRZEDAŻ

- **Endpoint:** `GET /statystyki/api/stats/sprzedaz`
- **Scope/parametry:** `from`, `to`, `owner` (Lorenzo|Antoni|all), `source` (shopify|panel|form|all), `groupBy` (day|week|month)
- **Co znajdzie:** liczba i suma zamówień, **AOV**, **close_rate** (kohortowy), big-ticket mix (% wartości ≥2k / ≥5k), udział **B2B** (po `invoice_company_nip`), % **powracających** (self-join po e-mail/tel)
- **Źródło:** Supabase `wyceny` (`typ='ZAMÓWIENIE'`; kwota = `kwota_sprzedazy_brutto`)
- **Status:** dane SĄ; baza endpointu istnieje (`GET /api/sprzedaze/stats`), do rozszerzenia

## B. PIPELINE / WYCENY OTWARTE

- **Endpoint:** `GET /statystyki/api/stats/pipeline`
- **Scope/parametry:** `status` (Open|Waiting|all), `olderThanDays`, `minKwota`, `owner`, `sort` (wiek|kwota)
- **Co znajdzie:** otwarty pipeline (count, suma zł, śr. wiek dni) **oraz listę konkretnych martwych wycen** (id, kwota, telefon, wiek, owner) — gotową do dzwonienia
- **Źródło:** Supabase `wyceny` (`typ='WYCENA'`, status Open/Waiting for payment)
- **Status:** dane SĄ; endpoint do zbudowania. To jest „paliwo akcji" — narzędzie może zwrócić 3 najgrubsze do telefonu

## C. OUTREACH / TELEFONY

- **Endpoint:** `GET /statystyki/api/stats/outreach`
- **Scope/parametry:** `from`, `to`, `handlowiec` (Lorenzo|all), `kierunek` (in|out|all)
- **Co znajdzie:** telefony (liczba, in/out), **% dodzwonień** (`disposition='no_answer'`), **speed-to-lead** (mediana min: event „Nowy" → 1. tel wychodzący), rozkład kadencji (0 / 1–2 / 3–5 / 6+ prób), **leady nietknięte**, śr. czas rozmowy (`czas_trwania_s`), martwe wyceny tknięte w oknie
- **Źródło:** Supabase `"Log zmian"` (`data_zmiany`, `disposition`, `kierunek`, `handlowiec`) + `"Leady B2C"`
- **Status:** dane SĄ; `handlowiec` zasilany od teraz regułą na numer Lorenza (po deployu). Endpoint do zbudowania

## D. LEADY / LEJEK

- **Endpoint:** `GET /statystyki/api/stats/leady`
- **Scope/parametry:** `from`, `to`, `status` (Deal stage), `source` (organic|paid|fb|all), `owner`
- **Co znajdzie:** liczba leadów w oknie, **rozkład po etapach lejka** (Nowy → … → Sprzedane/Stracony), rozkład po **źródle** (organiczny vs płatny vs FB), konwersja etap→etap w czasie
- **Źródło:** Supabase `"Leady B2C"` (`"Deal stage"`, `marketing_meta.is_organic`, `"Źródło"`) — do szeregów czasowych `Log zmian.data_zmiany`
- **Status:** dane SĄ; endpoint do zbudowania

## E. PAID / REKLAMY PŁATNE (Zernio Ads + nasze leady)

- **Endpoint:** `GET /statystyki/api/stats/reklamy`
- **Scope/parametry:** `from`, `to`, `level` (ad|adset|campaign), `platform` (meta|tiktok|google|all), `sort` (przychod|leady|CAC)
- **Co znajdzie — pełny lejek PER REKLAMA:**
  - z NASZYCH danych (join po `marketing_meta.ad_id`): #leadów → #dodzwonionych → #wycen → #sprzedaży → **Σ przychód**
  - z **Zernio `/ads`** (Meta/TikTok/Google Ads): `spend`, `impressions`, `clicks`, CTR, CPC, lead forms
  - policzone: **CAC** (spend/sprzedaże), **ROAS** (przychód/spend), koszt/lead, koszt/wycena
  - rankowanie po **przychodzie/CAC**, nie po liczbie leadów (tanie leady bywają śmieciem)
- **Sygnał zwrotny do Mety (Twój główny cel):** `POST /statystyki/api/stats/reklamy/konwersje` — wypycha „ten lead → sprzedaż za X zł" (lead_id + ad_id + wartość) z powrotem do Mety przez Zernio Ads / CAPI. Meta optymalizuje pod podobnych kupujących. Koszt zostaje po stronie Mety — nie musimy go importować, żeby to działało
- **Źródło:** Zernio `/ads/*` + Supabase `wyceny`/`Leady B2C`. Bonus: Zernio tag `comment.ad` mówi, że komentarz przyszedł z reklamy
- **Status:** klucz Zernio JEST; endpoint + mapowanie pól Zernio do zbudowania (v2)

## F. ORGANIK / SOCIAL (Zernio Analytics + TikTok)

- **Endpoint:** `GET /statystyki/api/stats/organik`
- **Scope/parametry:** `from`, `to`, `platform` (instagram|facebook|tiktok|youtube|…), `level` (post|account), `sortBy` (engagement|reach), `limit`
- **Co znajdzie:** per post i per konto — **reach, impressions, engagement, likes, comments, shares, saves, followers, video_views, profile_views** (Zernio `/analytics`, „across every connected account", 15+ platform). Który content ciągnie zasięg/zaangażowanie; proxy na leady: leady z `is_organic`
- **Źródło:** Zernio `GET /api/v1/analytics` (organik cross-platform) + istniejąca `kom_tiktok_stats` (dzienne snapshoty TikToka, już w bazie)
- **Status:** TikTok bieżący JEST; reszta organiku przez Zernio — endpoint do zbudowania (v3). Historię TikToka za rok Antoni dogra eksportem

## G. SNAPSHOT (rollup na rytuał dzienny)

- **Endpoint:** `GET /statystyki/api/stats/snapshot` — **PLACEHOLDER JUŻ STOI**
- **Co znajdzie:** najważniejsze liczby z A–F w jednym strzale (close_rate, pipeline, AOV, telefony, speed-to-lead, leady nietknięte) + `alerty[]` (gotowe zdania). Bez parametrów — obraz „tu i teraz"
- **Status:** kontrakt finalny, wartości `null` do wpięcia w buildzie

---

## Wspólny scope (filtry we wszystkich grupach)

| Parametr | Znaczenie | Wartości |
|---|---|---|
| `from` / `to` | okno czasu | ISO data; skróty: `dzis`, `tydzien`, `miesiac`, `30d` |
| `owner` / `handlowiec` | czyje | `Lorenzo`, `Antoni`, `all` (domyślnie: widok właściciela = całość, patrz OWNER=Antoni) |
| `platform` | kanał social/ad | `meta`, `instagram`, `facebook`, `tiktok`, `google`, `youtube`, … |
| `level` | granulacja | `ad`/`adset`/`campaign` (paid), `post`/`account` (organik), `day`/`week`/`month` (agregacja) |
| `source` | pochodzenie | `organic`, `paid`, `shopify`, `panel`, `form` |

## Co jest TERAZ vs co wymaga wpięcia

- **Dane w Supabase (A–D):** są kompletne — endpointy do zbudowania (v1). Zero zależności zewnętrznych.
- **Paid + Organik (E–F):** źródło = **Zernio** (klucz jest), nie Make. Zbudować klienta do `/ads` i `/analytics` + mapowanie pól (dokładne nazwy z OpenAPI 3.1 Zernio przy buildzie). Import kosztu do NASZEJ bazy = opcjonalny; sygnał konwersji do Mety = główny cel.
- **Snapshot (G):** placeholder stoi; wpiąć realne zapytania.

## Uwaga architektoniczna

Marketing (E+F) upraszcza się mocno dzięki Zernio: **jedno API na 15+ platform organicznie i 6 sieci reklamowych** zamiast osobnych integracji per platforma i osobnych webhooków Make. Wcześniejsze `POST /ingest/ad-spend` i `/ingest/organic` (Make) stają się zbędne, o ile Zernio pokrywa potrzebne pola — do potwierdzenia przy buildzie na OpenAPI Zernio.
