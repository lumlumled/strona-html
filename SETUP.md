# Podłączenie do Supabase — instrukcja

## 1. Dane dostępowe z Supabase

1. Wejdź do swojego projektu na https://supabase.com/dashboard
2. **Project Settings → Data API** — skopiuj **Project URL** (wygląda jak `https://xxxxx.supabase.co`).
3. **Project Settings → API Keys** — skopiuj klucz **service_role** (NIE `anon`/`public` — potrzebujemy pełnego dostępu, bo backend ma obsługiwać dowolną tabelę bez ustawiania polityk RLS).

⚠️ `service_role` to sekret dający pełny dostęp do bazy z pominięciem Row Level Security. Nigdy nie umieszczaj go w kodzie frontendu ani nie commituj do repo — trafia wyłącznie do `server/.env` (jest w `.gitignore`).

## 2. Konfiguracja backendu

```
cd server
cp .env.example .env
```

Uzupełnij `server/.env`:
```
PORT=3001
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=twoj_service_role_key
```

**Wklej te wartości bezpośrednio do pliku `.env`** (np. w edytorze), a nie na czacie z asystentem — dzięki temu klucz nie trafi do historii konwersacji.

## 3. Uruchomienie

```
npm install
npm start
```

Powinieneś zobaczyć `Serwer działa na http://localhost:3001`.

Test:
```
curl http://localhost:3001/api/tables/nazwa_twojej_tabeli
```

## 4. Frontend

Otwórz `index.html` w przeglądarce, wpisz nazwę tabeli (dokładnie taką, jak w Supabase Table Editor) i kliknij **Załaduj**. Aplikacja pokaże wiersze, pozwoli je edytować/usuwać oraz dodać nowe.

Uwaga: backend zakłada, że każda tabela ma kolumnę `id` jako klucz główny (standard w Supabase) — jest ona używana do edycji i usuwania konkretnego wiersza.

## 5. Bezpieczeństwo przy wystawieniu na produkcję

Ten backend z kluczem `service_role` ma pełny dostęp do całej bazy i nie ma żadnej autoryzacji użytkownika — jest pomyślany do pracy lokalnej/deweloperskiej. Przed wystawieniem publicznie należałoby dodać uwierzytelnianie (np. token API) i/lub ograniczyć dostępne tabele/operacje.
