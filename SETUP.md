# Monorepo pod lumlum.dev — layout i wdrożenie

## 0. Layout repo

Jeden repo, jeden projekt Vercel, wiele narzędzi — każde we własnym
folderze pod `apps/`, dostępne pod `lumlum.dev/<narzędzie>/...` (routing po
ścieżce, nie subdomeny):

```
apps/
  hub/                    — panel główny lumlum.dev/: ekran startowy ("Do
    app.html                 zrobienia dziś" + kafelki paneli wg uprawnień),
    pozwolenia.html          panel Pozwolenia (użytkownicy/dostępy, admin),
    wkrotce.html             szablon stron-atrap (Wyceny/Wiadomości/Statystyki)
    assets/
    server/
      server.js, supabase.js, .env (lokalnie)
  backlog-b2c/            — standup dashboard Lorenzzo (wykuratorowany przez
    app.html                 AI dzienny wycinek leadów, Umowa/Podsumowanie)
    assets/
    server/
      server.js, package.json, scripts/*.js, .env (lokalnie)
  crm/                    — CRM wewnętrzny do LEADÓW (sekcja "Leady B2C";
    app.html                 wyceny wyprowadzone do osobnego panelu /wyceny
    assets/                  2026-07-12). Karta leada dociąga dopasowaną
    server/                  wycenę (/api/leady/:tel/wycena), ale sam arkusz
      server.js, package.json, .env (lokalnie)   wycen tu już nie żyje
  wyceny/                 — panel Wyceny (lumlum.dev/wyceny): lista wycen/
    app.html                 notatek (typ ≠ ZAMÓWIENIE), szybkie dodanie
    assets/                  tekstem (AI), pełny edytor, link do formularza.
      wyceny-tab.js            Karta i endpointy wspólne ze Sprzedażami
      wycena-editor.js         (shared/wycena-card.js + wyceny-endpoints.js)
    server/                  server.js, package.json, .env (lokalnie)
  sprzedaze/              — panel Sprzedaże (lumlum.dev/sprzedaze): zamówienia
    app.html                 (wyceny typ ZAMÓWIENIE + Shopify jako S1,S2…),
    assets/                  3 sekcje Do wysłania/Wysłane/Zamknięte, sort po
    server/                  dacie, statystyki zwinięte (porównanie do tempa
      server.js, .env          zeszłego mies.), karta z fakturą/etykietą/
                             trackingiem, "Zamów kuriera ponownie"
  formularz/              — PUBLICZNE endpointy formularza zamówienia
    liquid/formularz.liquid  (lumlum.dev/formularz/api/dane|zapis — kontrakt
    server/                  1:1 z dawnym webhookiem Make, formularz
      server.js, .env         jednorazowy, token w linku) + webhook inFakt +
                             worker pipeline'u + strona testowa /formularz/test;
                             liquid/ = sekcja do wklejenia na Shopify (cutover)
  shared/                 — kod wspólny WSZYSTKICH appek:
    lead-card.js/.css        wspólna karta leada (CRM + Backlog)
    wycena-card.js/.css      wspólna karta wyceny (panel Wyceny +
                             Sprzedaże) — produkty ze zdjęciami, pipeline
    topbar.js/.css           wspólny górny pasek nawigacji (wszystkie appki)
    migrations/              migracje SQL (run.js + NNN_*.sql)
    server/
      auth.js                logowanie + uprawnienia (konta app_users)
      login.html             wspólna strona logowania (email + hasło)
      leady-endpoints.js     wspólne endpointy karty leada
      wyceny-endpoints.js    wspólne endpointy wycen (Wyceny + Sprzedaże):
                             lista/karta/edycja, szybkie dodanie, linki,
                             reship, realizuj, proxy PDF faktur i etykiet
      wyceny-parser.js       parser GPT szybkiego dodania (+ prompt w
      wyceny-parser-prompt.txt  osobnym pliku — TABELA SKU w prompcie
                             wymaga ręcznej aktualizacji przy zmianie cennika!)
      wyceny-pipeline.js     maszyna stanów realizacji zamówienia (lock,
                             wznawianie, worker: tracking/retry/sync Shopify)
      wyceny-infakt.js       klient inFakt v3 (KWOTY W GROSZACH, async
                             faktury, quick payments, KSeF)
      wyceny-shipx.js        klient InPost ShipX (paczkomat+kurier, JAWNE
                             mapowanie statusów: tylko delivered=doręczona)
      wyceny-mailer.js       maile pipeline'u przez Gmail API (tokeny
                             skrzynki z kom_mailboxes komunikatora)
      wyceny-shopify.js      sync zamówień sklepu Shopify do wycen
api/
  index.js                — wrapper huba (montowany w korzeniu domeny)
  backlog-b2c.js          — cienki wrapper: montuje apps/backlog-b2c/server
                            pod /backlog-b2c (Express app.use)
  crm.js                  — analogiczny wrapper dla apps/crm/server pod /crm
  wyceny.js               — wrapper apps/wyceny/server pod /wyceny
  sprzedaze.js            — wrapper apps/sprzedaze/server pod /sprzedaze
  formularz.js            — wrapper apps/formularz/server pod /formularz
                            (publiczny — bez bramki auth, CORS na lumlum.co)
vercel.json               — jedna funkcja per narzędzie + crony, wszystko
                            prefiksowane ścieżką narzędzia
package.json              — root, TYLKO żeby Vercel miał skąd zainstalować
                            zależności (patrz punkt 6)
```

### Jak dodać kolejne narzędzie

1. Nowy folder `apps/<narzędzie>/` — własny `server.js` (Express app,
   `module.exports = app`), własne `package.json` do lokalnego dev.
2. Jeśli kopiujesz wzorzec z `backlog-b2c/server.js`: appka MUSI być
   mount-prefix-agnostic, czyli używać `req.baseUrl` zamiast sztywnych `/`
   wszędzie, gdzie generuje własne URL-e (redirecty po loginie, cookie
   `Path`, i `window.API_BASE` wstrzykiwane do HTML-a dla `fetch()`ów
   frontendu) — dzięki temu ten sam kod działa identycznie zamontowany pod
   Vercelem (`req.baseUrl === '/<narzędzie>'`) i odpalony samodzielnie
   lokalnie (`req.baseUrl === ''`). Zobacz `apps/backlog-b2c/server/server.js`
   jako referencję (4 miejsca: 2× redirect po loginie, cookie Path, injekcja
   `API_BASE` w handlerze `/`).
3. Nowy `api/<narzędzie>.js`:
   ```js
   const express = require('express');
   const narzedzieApp = require('../apps/<narzędzie>/server/server.js');
   const wrapper = express();
   wrapper.use('/<narzędzie>', narzedzieApp);
   module.exports = wrapper;
   ```
4. `vercel.json`: dodaj wpis w `functions` (z `includeFiles` na statyki tego
   narzędzia), crony z prefiksem `/<narzędzie>/...`, i **redirect** (nie
   rewrite!) z bare `/<narzędzie>` → `/<narzędzie>/` — bez tego relatywne
   linki do assetów (`<img src="assets/...">` bez wiodącego `/`) łamią się,
   bo przeglądarka rozwiązuje je względem paska adresu, a rewrite go nie
   zmienia (tylko redirect owszem).
5. Jeśli narzędzia mają współdzielić dane (Supabase) — patrz sekcja "Cross-
   referencing danych między narzędziami" niżej, zanim zaczniesz kopiować
   tabele/klucze między folderami.

### Cross-referencing danych między narzędziami

**Rozstrzygnięte 2026-07-10** (przy dodaniu `apps/crm/`, pierwszego drugiego
narzędzia): jeden wspólny projekt Supabase dla wszystkich narzędzi, nie
osobne bazy z synchronizacją. Każde narzędzie ma **własny plik**
`apps/<narzędzie>/server/.env`, ale wskazujący na TEN SAM `SUPABASE_URL`/
`SUPABASE_SERVICE_ROLE_KEY` co pozostałe — `.env` NIE staje się wspólny na
poziomie repo (root), zostaje per-`apps/*`, tylko z powtórzonymi tymi samymi
wartościami. Konsekwencja: zapis w jednym narzędziu (np. edycja pola w
`apps/crm`) jest natychmiast widoczny w drugim (np. `apps/backlog-b2c`) bez
żadnej synchronizacji do zbudowania — to jedna baza, nie dwie. Logowanie
JEST współdzielone (patrz sekcja 5): jedno ciasteczko `lumlum_session` z
`Path=/` honorowane przez wszystkie appki — zalogowanie w dowolnej z nich
loguje do całego lumlum.dev, w granicach uprawnień konta.

## 1. Dane dostępowe z Supabase (per narzędzie, na razie tylko backlog-b2c)

1. Wejdź do swojego projektu na https://supabase.com/dashboard
2. **Project Settings → Data API** — skopiuj **Project URL** (wygląda jak `https://xxxxx.supabase.co`).
3. **Project Settings → API Keys** — skopiuj klucz **service_role** (NIE `anon`/`public` — potrzebujemy pełnego dostępu, bo backend ma obsługiwać dowolną tabelę bez ustawiania polityk RLS).

⚠️ `service_role` to sekret dający pełny dostęp do bazy z pominięciem Row Level Security. Nigdy nie umieszczaj go w kodzie frontendu ani nie commituj do repo — trafia wyłącznie do `apps/backlog-b2c/server/.env` (jest w `.gitignore`).

## 2. Konfiguracja backendu (praca lokalna)

```
cd apps/backlog-b2c/server
cp .env.example .env
```

Uzupełnij `.env`:
```
PORT=3001
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=twoj_service_role_key
SITE_PASSWORD=haslo_do_wejscia_na_strone
```

`SITE_PASSWORD` pełni dziś rolę sekretu podpisującego sesje (fallback dla
`SESSION_SECRET`) — samo logowanie odbywa się na indywidualne konta z tabeli
`app_users` (patrz sekcja 5).

**Wklej te wartości bezpośrednio do pliku `.env`** (np. w edytorze), a nie na czacie z asystentem — dzięki temu żaden sekret nie trafi do historii konwersacji.

## 3. Uruchomienie lokalne

```
cd apps/backlog-b2c/server
npm install
npm start
```

Powinieneś zobaczyć `Serwer działa na http://localhost:3001`.

## 4. Frontend

Wejdź na `http://localhost:3001/` w przeglądarce (lokalnie, bez prefiksu — `req.baseUrl` jest puste, patrz sekcja 0) — serwer sam serwuje stronę (`apps/backlog-b2c/app.html`), nie otwiera się go bezpośrednio jako pliku lokalnego. Poprosi o `SITE_PASSWORD`, a po zalogowaniu pokaże dane z tabeli Supabase wskazanej na sztywno w kodzie `app.html` (obecnie: `Standup Log Lorenzo`). Na produkcji to samo narzędzie jest pod `https://lumlum.dev/backlog-b2c/`.

Uwaga: endpointy `POST/PUT/DELETE /api/tables/:table[/:id]` zakładają kolumnę `id` jako klucz główny — nie wszystkie tabele ją mają (np. `Standup Log Lorenzo` używa `Data` jako identyfikatora), więc edycja/usuwanie działa tylko na tabelach z `id`. Samo wyświetlanie (`GET`) działa niezależnie od tego.

## 5. Bezpieczeństwo — konta użytkowników i uprawnienia (od 2026-07-11)

Logowanie na **indywidualne konta** (email + hasło) z tabeli Supabase
`app_users` — wspólny moduł `apps/shared/server/auth.js` używany przez
wszystkie appki. Jak to działa:

- **Sesja**: ciasteczko `lumlum_session` (`HttpOnly`, `Path=/`, 30 dni) w
  formacie `u.<idUsera>.<expiry>.<hmac>`, podpisane `SESSION_SECRET`
  (fallback: `SITE_PASSWORD`) — bezstanowe, działa na serverless. Jedno
  logowanie obowiązuje w całej domenie (hub, Backlog, CRM).
- **Hasła**: scrypt z solą (`hashPassword` w auth.js), nigdy plaintext.
- **Uprawnienia** (kolumna jsonb `permissions`): `panels` — lista paneli,
  do których konto wchodzi; `crm_sheets` — per arkusz CRM `view` (podgląd)
  albo `edit` (podgląd + edycja). `role='admin'` = pełny dostęp do
  wszystkiego + panel Pozwolenia. Egzekwowane SERVER-SIDE: bramka panelu w
  każdej appce (strony → 403, API → 401/403) + `requireSheet` na
  endpointach CRM; UI tylko dodatkowo chowa to, czego nie wolno.
- **Zarządzanie**: panel **Pozwolenia** (`lumlum.dev/pozwolenia`, tylko
  admin) — dodawanie użytkowników, hasła, panele, arkusze CRM,
  dezaktywacja konta (natychmiastowa — cache uprawnień per instancja
  funkcji trzyma się maks. 30 s). Każdy użytkownik może zmienić własne
  hasło w menu na ekranie głównym.
- **Migracja**: `apps/backlog-b2c/server/scripts/create-app-users.js`
  tworzy tabelę i seeduje admina (Antoni). Idempotentny.

Ograniczenia, o których warto wiedzieć:
- Brak limitu prób logowania (brute-force nie jest blokowany) — akceptowalne dla wewnętrznego narzędzia z niepublicznym adresem, ale nie traktuj tego jak pełnego zabezpieczenia przed celowym atakiem.
- `service_role` nadal ma pełny dostęp do bazy z pominięciem RLS — bramka chroni dostęp do *stron/API*, nie zastępuje właściwych uprawnień w Supabase.

## 6. Wdrożenie na Vercel

Repo jest już przygotowane pod Vercel (zero dodatkowej konfiguracji poza zmiennymi środowiskowymi):

1. **vercel.com → Add New → Project → Import Git Repository** → wybierz repo z tym kodem.
2. W **Environment Variables** (przy imporcie albo później w Project Settings) dodaj te same 3 wartości co w `apps/backlog-b2c/server/.env`: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SITE_PASSWORD` (+ `OPENAI_API_KEY`, `CRON_SECRET` — patrz kod). **Nigdy nie wgrywaj pliku `.env`** — Vercel czyta zmienne wyłącznie z panelu.
3. Deploy. `https://lumlum.dev/backlog-b2c/` powinien od razu przekierować na ekran logowania.

**Po każdym przeniesieniu narzędzia pod nowy prefiks (jak to, zrobione 2026-07-09) sprawdź integracje zewnętrzne wołające stare URL-e wprost** — np. webhook Zadarmy jest skonfigurowany w panelu Zadarmy na sztywno wpisany adres (`.../api/webhooks/zadarma`) i **trzeba go tam ręcznie zaktualizować** na nowy, prefiksowany adres — inaczej połączenia przestają się logować bez żadnego widocznego błędu w tym repo.

### Jak to jest zbudowane (żeby nikt tego przez pomyłkę nie cofnął)

- `api/backlog-b2c.js` — cienki wrapper: montuje `apps/backlog-b2c/server/server.js` (Express app) pod `/backlog-b2c` (`express().use('/backlog-b2c', app)`). Cała logika zostaje w `server.js`, więc lokalny `cd apps/backlog-b2c/server && npm start` działa identycznie jak wcześniej (bez prefiksu — patrz sekcja 0/4).
- `vercel.json` — `rewrites` kieruje `/backlog-b2c/:path*` do tej funkcji, `redirects` dopina bare `/backlog-b2c` (bez slasha) → `/backlog-b2c/` (patrz sekcja 0 pkt 4 czemu to musi być redirect, nie rewrite), `includeFiles` dołącza `apps/backlog-b2c/{app.html,assets/**}` i `apps/shared/**` (wspólna karta leada, topbar, strona logowania) do paczki funkcji, żeby `res.sendFile`/wczytanie szablonu miało co wysłać. Hub (api/index.js) dostaje dodatkowo rewrites na `/pozwolenia`, `/wiadomosci`, `/statystyki`, `/logout`, `/shared/:path*` i `/api/:path*` (funkcje `/api/crm` i `/api/backlog-b2c` mają pierwszeństwo przed tym ostatnim, bo istnieją w filesystemie).
- **Strona nazywa się `app.html`, nie `index.html`.** To nieoczywiste, ale kluczowe: Vercel sprawdza filesystem *przed* `rewrites` (ich własna dokumentacja: "precedence is given to the filesystem prior to rewrites being applied"). Plik `index.html` w katalogu głównym repo kolidowałby z domyślnym mapowaniem `/` → `index.html`, więc Vercel serwowałby go bezpośrednio z CDN jako statyk — z pominięciem funkcji, a więc i całej bramki logowania. Tak się właśnie stało przy pierwszym wdrożeniu, zanim plik przemianowano. **Nie twórz `index.html` w katalogu głównym repo.**
- Root-level `package.json`/`package-lock.json` — Vercel instaluje zależności z katalogu głównego repo, a nie z `apps/*/server/`, stąd te pliki mimo że każde narzędzie ma własne (dla lokalnego dev).
- Serwer wymusza `Cache-Control: no-store` na wszystkim poza `/assets/**` (patrz `apps/backlog-b2c/server/server.js`) — bez tego CDN Vercela cache'owałby odpowiedzi (w tym dane z Supabase) i serwował je kolejnym odwiedzającym bez sprawdzania ciasteczka sesji. Nie usuwaj tego middleware'u.
- `req.baseUrl`-owe redirecty/cookie/`window.API_BASE` (patrz sekcja 0 pkt 2) — bez nich narzędzie zamontowane pod `/backlog-b2c` przekierowywałoby po loginie na root domeny (`/`) zamiast `/backlog-b2c/`, i wszystkie `fetch()`y frontendu trafiałyby w root zamiast pod prefiks.
