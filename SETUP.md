# Podłączenie do Supabase i wdrożenie — instrukcja

## 1. Dane dostępowe z Supabase

1. Wejdź do swojego projektu na https://supabase.com/dashboard
2. **Project Settings → Data API** — skopiuj **Project URL** (wygląda jak `https://xxxxx.supabase.co`).
3. **Project Settings → API Keys** — skopiuj klucz **service_role** (NIE `anon`/`public` — potrzebujemy pełnego dostępu, bo backend ma obsługiwać dowolną tabelę bez ustawiania polityk RLS).

⚠️ `service_role` to sekret dający pełny dostęp do bazy z pominięciem Row Level Security. Nigdy nie umieszczaj go w kodzie frontendu ani nie commituj do repo — trafia wyłącznie do `server/.env` (jest w `.gitignore`).

## 2. Konfiguracja backendu (praca lokalna)

```
cd server
cp .env.example .env
```

Uzupełnij `server/.env`:
```
PORT=3001
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=twoj_service_role_key
SITE_PASSWORD=haslo_do_wejscia_na_strone
```

`SITE_PASSWORD` to jedno wspólne hasło chroniące dostęp do całej strony (bez kont użytkowników — patrz sekcja 5).

**Wklej te wartości bezpośrednio do pliku `.env`** (np. w edytorze), a nie na czacie z asystentem — dzięki temu żaden sekret nie trafi do historii konwersacji.

## 3. Uruchomienie lokalne

```
cd server
npm install
npm start
```

Powinieneś zobaczyć `Serwer działa na http://localhost:3001`.

## 4. Frontend

Wejdź na `http://localhost:3001/` w przeglądarce — serwer sam serwuje stronę (plik `app.html` w katalogu głównym repo), nie otwiera się go bezpośrednio jako pliku lokalnego. Poprosi o `SITE_PASSWORD`, a po zalogowaniu pokaże dane z tabeli Supabase wskazanej na sztywno w kodzie `app.html` (obecnie: `Standup Log Lorenzo`).

Uwaga: endpointy `POST/PUT/DELETE /api/tables/:table[/:id]` zakładają kolumnę `id` jako klucz główny — nie wszystkie tabele ją mają (np. `Standup Log Lorenzo` używa `Data` jako identyfikatora), więc edycja/usuwanie działa tylko na tabelach z `id`. Samo wyświetlanie (`GET`) działa niezależnie od tego.

## 5. Bezpieczeństwo

Strona ma bramkę logowania: jedno wspólne hasło (`SITE_PASSWORD`, bez kont użytkowników), sesja w ciasteczku `HttpOnly` ważnym 30 dni, podpisana HMAC-em (nie wymaga pamięci serwera — działa też na serverless). Ograniczenia, o których warto wiedzieć:
- Jedno hasło dla wszystkich — jeśli ma je więcej osób i chcesz komuś zabrać dostęp, trzeba zmienić `SITE_PASSWORD` dla wszystkich naraz.
- Brak limitu prób logowania (brute-force nie jest blokowany) — akceptowalne dla wewnętrznego narzędzia z niepublicznym adresem, ale nie traktuj tego jak pełnego zabezpieczenia przed celowym atakiem.
- `service_role` nadal ma pełny dostęp do bazy z pominięciem RLS — bramka hasła chroni dostęp do *strony*, nie zastępuje właściwych uprawnień w Supabase.

## 6. Wdrożenie na Vercel

Repo jest już przygotowane pod Vercel (zero dodatkowej konfiguracji poza zmiennymi środowiskowymi):

1. **vercel.com → Add New → Project → Import Git Repository** → wybierz repo z tym kodem.
2. W **Environment Variables** (przy imporcie albo później w Project Settings) dodaj te same 3 wartości co w `server/.env`: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SITE_PASSWORD`. **Nigdy nie wgrywaj pliku `.env`** — Vercel czyta zmienne wyłącznie z panelu.
3. Deploy. Adres `*.vercel.app` (albo podłączona domena) powinien od razu przekierować na ekran logowania.

### Jak to jest zbudowane (żeby nikt tego przez pomyłkę nie cofnął)

- `api/index.js` — cienki wrapper (`module.exports = require('../server/server.js')`), dzięki któremu Vercel widzi tu Vercel Function. Cała logika zostaje w `server/server.js`, więc lokalny `cd server && npm start` działa identycznie jak wcześniej.
- `vercel.json` — przekierowuje (`rewrites`) wszystkie ścieżki do tej funkcji i dołącza (`includeFiles`) `app.html`, `assets/**` i `server/login.html` do paczki funkcji, żeby `res.sendFile` miał co wysłać.
- **Strona nazywa się `app.html`, nie `index.html`.** To nieoczywiste, ale kluczowe: Vercel sprawdza filesystem *przed* `rewrites` (ich własna dokumentacja: "precedence is given to the filesystem prior to rewrites being applied"). Plik `index.html` w katalogu głównym repo kolidowałby z domyślnym mapowaniem `/` → `index.html`, więc Vercel serwowałby go bezpośrednio z CDN jako statyk — z pominięciem funkcji, a więc i całej bramki logowania. Tak się właśnie stało przy pierwszym wdrożeniu, zanim plik przemianowano. **Nie przywracaj nazwy `index.html` w katalogu głównym.**
- Root-level `package.json`/`package-lock.json` — Vercel instaluje zależności z katalogu głównego repo, a nie z `server/`, stąd te pliki mimo że `server/` ma własne (dla lokalnego dev).
- Serwer wymusza `Cache-Control: no-store` na wszystkim poza `/assets/**` (patrz `server/server.js`) — bez tego CDN Vercela cache'owałby odpowiedzi (w tym dane z Supabase) i serwował je kolejnym odwiedzającym bez sprawdzania ciasteczka sesji. Nie usuwaj tego middleware'u.
