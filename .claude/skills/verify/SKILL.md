# Verify — LumLum monorepo (backlog-b2c + crm)

Jak zweryfikować zmiany end-to-end na lokalnych serwerach.

## Start serwerów
- Backlog: `cd apps/backlog-b2c/server && node server.js` → port 3001
- CRM: `cd apps/crm/server && node server.js` → port 3002
- Oba czytają własne `server/.env`. Zostaw serwery uruchomione po pracy
  (użytkownik tylko odświeża przeglądarkę).

## Auth (bramka hasła)
Sesja = cookie po POST /login:
```bash
PASS=$(grep '^SITE_PASSWORD=' apps/backlog-b2c/server/.env | cut -d= -f2-)
curl -s -c /tmp/ck.txt -X POST http://localhost:3001/login --data-urlencode "password=$PASS"
curl -s -b /tmp/ck.txt http://localhost:3001/api/...
```
Webhook Zadarmy: `?token=$ZADARMA_WEBHOOK_TOKEN` (z .env), bez cookie.

## Webhook Zadarmy bez audio
Payload przyjmuje `transcript` (base64!) — pełna ścieżka GPT bez nagrania:
`record_url` dowolny truthy (answered=true), `transcript` = base64 treści,
`kierunek`/`pracownik`/`numer_klienta` jawnie. Nieodebrane: bez record_url.

## Testy na produkcyjnej bazie (Supabase — UWAGA, to prod!)
Twórz jednorazowego leada z fikcyjnym numerem (np. 48000000001, Name
"TEST-... (do usunięcia)", status inny niż "Nowy" żeby nie wpadł w żywy
widok Nowe), po testach usuń JEGO wiersze z "Leady B2C" i "Log zmian".
Bezpośredni host db.*.supabase.co jest IPv6-only — pg łączy się przez
pooler: `postgres.<ref>:<haslo>@aws-0-eu-west-3.pooler.supabase.com:5432`
(helper pooledUrl w scripts/sync-leady-from-sheet.js).

## UI (screenshoty headless)
Brak zainstalowanego playwrighta, ale binarki są w cache:
```js
const { chromium } = require('playwright-core'); // npm i playwright-core w scratchpadzie
chromium.launch({ executablePath: '~/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-x64/chrome-headless-shell' })
```
Login przez formularz (`input[name="password"]`), potem normalne selektory.
Layout wiersza leada testuj na wszystkich kombinacjach opcjonalnych pól
(patrz feedback_ui_layout_verification).

## Po lokalnym PASS
Lokalny sukces ≠ prod: po deployu sprawdź lumlum.dev/backlog-b2c i
lumlum.dev/crm (env vars na Vercelu bywają rozjechane).
