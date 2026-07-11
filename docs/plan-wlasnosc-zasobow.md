# Plan: Własność zasobów (owner) + widoki per użytkownik

**Status: część leadowa WDROŻONA (2026-07-11); wymagania wiążące dla panelu
Wyceny, który Antoni tworzy osobno.** Autor wymagań: Antoni (głosowo). Każdy,
kto buduje dodawanie wycen lub widoki Wyceny/Sprzedaże, MUSI wdrożyć poniższe
zasady.

Zrobione dla leadów (szczegóły w §9): kolumna `"Owner"` w "Leady B2C"
(DEFAULT 'Lorenzo' na poziomie Postgresa), migracja 407 leadów → Lorenzo,
kółeczko ownera na karcie (apps/shared/lead-card.js), GET /api/leady/owners,
`Owner` w EDITABLE_LEAD_FIELDS, hub "Do zrobienia dziś" filtrowane po
ownerze + sekcja "Wiadomości do odpisania" dla kont z panelem Wiadomości.

## 1. Cel

Narzędzie ma być gotowe na wielu użytkowników. Dziś jest Antoni i Lorenzo,
ale ma być możliwość dodawania kolejnych użytkowników i przypisywania im
zasobów. Fundament już istnieje: indywidualne konta `app_users` + panel
Pozwolenia + uprawnienia server-side per panel/arkusz
(`apps/shared/server/auth.js`). Ten plan dokłada do tego **własność zasobów**.

## 2. Twardy wymóg: owner na leadzie i wycenie

- **Każdy lead i każda wycena ma swojego ownera.** Dotyczy wszystkiego, co
  jest dodaniem nowej wyceny. NIE dotyczy pojedynczych akcji (notatek,
  statusów itp.) — akcje nie mają ownera.
- **Owner = zalogowany użytkownik, który dodał zasób.** Bierzemy go z sesji
  (`lumlum_session` → `app_users`), NIGDY z body requestu — klient nie może
  wskazać innego ownera niż on sam. Jeśli doda Antoni, owner = Antoni;
  jeśli Lorenzo, owner = Lorenzo.
- Proponowana kolumna: `owner_id` (FK/wartość `app_users.id`; ewentualnie
  dodatkowo denormalizowany email do debugowania). Ta sama zasada w tabeli
  `Leady B2C` i w przyszłej tabeli wycen.

## 3. Migracja istniejących danych (jednorazowo)

- **Istniejące leady → domyślnie owner: Lorenzo.**
- **Istniejące wyceny → domyślnie owner: Antoni.** Antoni dostarczy listę
  wycen, które wysłał Lorenzo — te przepisujemy ręcznie na Lorenzo.
- Po migracji każda NOWA wycena/lead dostaje ownera automatycznie od osoby,
  która ją dodała (pkt 2).

## 4. Widoki: Wyceny i Sprzedaże per użytkownik

- Dwa osobne widoki (POTWIERDZONE 2026-07-11): **jeden widok dla wycen,
  drugi widok dla sprzedaży**. Sprzedaż = wycena, która się sfinalizowała.
  Na razie w CRM jest tylko widok Antoniego.
- **Lorenzo widzi wyłącznie:** swoje wyceny (owner = Lorenzo) oraz sprzedaże,
  które sam zrealizował (sfinalizowane wyceny, których jest ownerem).
- **Antoni (admin) widzi wszystko.**
- Filtrowanie MUSI być **server-side** w endpointach (analogicznie do
  `requireSheet(...)` w CRM), nie tylko ukryciem w UI. Nowe arkusze dopisać
  do rejestru `CRM_SHEETS` w `apps/shared/server/auth.js` (uprawnienia
  podgląd/edycja), a filtr po ownerze nakłada się NA TO dodatkowo.

## 5. Znaczek ownera na karcie (lead i wycena)

- Po otwarciu karty leada/wyceny, **zawsze w prawym górnym rogu**, małe
  kółeczko z inicjałem ownera: **„L"** = Lorenzo, **„A"** = Antoni.
- Kliknięcie pozwala **zmienić ownera** (wybór: Lorenzo albo Antoni; docelowo
  lista z `app_users`) — zmiana zapisuje `owner_id` na leadzie/wycenie.
- Ma to wyglądać i działać **spójnie wszędzie** (karta leada w CRM i
  Backlogu = `apps/shared/lead-card.js`, przyszła karta wyceny) — jedno
  wspólne rozwiązanie w `apps/shared/`, nie osobne per panel.

## 6. „Start" / „Do zrobienia dziś" filtrowane po ownerze

- Antoni w arkuszach leadów widzi wszystkie leady (pkt 4 dotyczy wycen),
  ALE ekran startowy huba **„Do zrobienia dziś"** (`GET /api/dzisiaj`)
  pokazuje tylko pozycje **przypisane do zalogowanego użytkownika**:
  przypisane do Lorenza → widzi Lorenzo, przypisane do Antoniego → Antoni.
- U Antoniego na starcie mają się raczej pojawiać **wiadomości do odpisania**
  (Komunikator), a leady/kontakty/akcje tylko jeśli są przypisane do niego.

## 7. Kontekst istniejącego systemu

- `app_users` (id, email, name, role admin/user, permissions jsonb) — patrz
  memory `project_hub_uzytkownicy` i `apps/shared/server/auth.js`.
- Leady: tabela Supabase `Leady B2C`, endpointy w
  `apps/shared/server/leady-endpoints.js` (używane przez CRM i Backlog —
  zmiany karty/endpointów leada robić TYLKO w `apps/shared/`).
- Sesja: cookie `lumlum_session` `u.<id>.<exp>.<hmac>`, Path=/ — id
  użytkownika jest dostępne przy każdym requeście.

## 8. Decyzje doprecyzowane (2026-07-11)

- **Lorenzo MOŻE edytować swoje wyceny i zmieniać statusy leadów.** Istota
  ograniczenia to WIDOCZNOŚĆ: nie może wyświetlać wycen ani sprzedaży
  Antoniego bez jego pozwolenia (uprawnienia rozszerzą się o to w przyszłości).
- **Przypisanie domyślne:** wiadomości z Komunikatora → Antoni; leady →
  Lorenzo (na razie wszystkie).
- **Domyślny owner nowego leada = jedna konfigurowalna wartość, nie
  hardcode po całym kodzie.** Nowy lead wpada automatycznie do Lorenza, ale
  podmiana na innego pracownika (np. Krzyśka) ma być zmianą w JEDNYM miejscu.
  W przyszłości możliwy tryb „do oznaczenia/do podziału" (nowy lead bez
  ownera czeka na przypisanie) — architektura ma tego nie blokować
  (owner nullable + widok „nieprzypisane" kiedyś).

## 9. Stan wdrożenia części leadowej (2026-07-11)

- Kolumna **`"Owner"` (text = app_users.name)** w "Leady B2C"; skrypt
  idempotentny: `apps/backlog-b2c/server/scripts/add-owner-leady.js`.
  (Dla leadów wybrano text zamiast owner_id z §2 — spójnie z konwencją
  "Najbliższa akcja owner"/DEFAULT_HANDLOWIEC; przyszła tabela wycen może
  użyć `owner_id`, byle zachować zasadę „owner z sesji".)
- **Domyślny owner = DEFAULT kolumny w Postgresie** ('Lorenzo') — obejmuje
  KAŻDĄ ścieżkę insertu (webhook Zadarma, Make piszący wprost do bazy,
  przyszłe panele). Zmiana domyślnego handlowca = jedna komenda:
  `alter table "Leady B2C" alter column "Owner" set default 'Krzysiek';`
- Karta leada: kółeczko `.lk-owner` (inicjał), klik → menu z
  `GET /api/leady/owners` (unia aktywnych app_users + wartości już użytych w
  kolumnie — Lorenzo widnieje, choć nie ma jeszcze konta). Zapis przez
  istniejący PUT /api/leady/:idLeada (`Owner` dodany do EDITABLE_LEAD_FIELDS;
  trigger manual_crm loguje zmianę do Log zmian).
- Hub `GET /api/dzisiaj`: akcje/feedbacki/nowe liczone TYLKO z leadów
  zalogowanego użytkownika (Owner = user.name; lead bez ownera przypada
  adminowi); "Kontakty dziś" celowo zostały globalne (puls zespołu).
  Sekcja "Wiadomości do odpisania" (kom_threads attention+inbox) dla kont
  z panelem Wiadomości.
