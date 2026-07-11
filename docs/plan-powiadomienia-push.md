# Plan: Powiadomienia push (Web Push + PWA)

**Status: PLAN (2026-07-11) — do akceptacji Antoniego.** Wymagania podane
głosowo. Zależy od planu `plan-wlasnosc-zasobow.md` (owner na wycenach —
bez niego nie da się rutować powiadomień o sprzedaży).

## 1. Cel i wymagania (od Antoniego)

Prawdziwe powiadomienia push na telefonie: aplikacja dodana do ekranu
początkowego jako skrót (ikona), powiadomienie wychodzi na ikonie
(plakietka/badge) i jako baner systemowy. Nie „byle co", tylko sensowny
system reguł:

| Zdarzenie | Kto dostaje |
|---|---|
| Nowy lead | Owner leada (dziś domyślnie Lorenzo) |
| Nowa sprzedaż | Owner sprzedaży + Antoni (admin dostaje WSZYSTKIE sprzedaże; gdy sprzedał sam — jedno powiadomienie, bez dubla) |
| Feedback | Owner: „dziś masz feedback do wykonania" (rano) + przypomnienie DOKŁADNIE w momencie feedbacku, gdy lead ma „Godzinę Feedbacku" |
| Nowa wiadomość (Komunikator) | Antoni (docelowo: user przypisany do skrzynki `kom_mailboxes`; FB/IG/TikTok → Antoni), żeby nic nie umknęło |

## 2. Technologia: Web Push (VAPID) + PWA na ROOT scope

- **Jedna PWA „LumLum"** na `lumlum.dev/` (hub) — manifest + service worker
  serwowane z `api/index.js` na scope `/`, więc obejmuje wszystkie panele
  (są path-routed). Cookie sesji już jest Path=/.
- **iPhone:** push działa od iOS 16.4+ TYLKO po dodaniu do ekranu
  początkowego (Udostępnij → „Do ekranu początkowego") i włączeniu
  powiadomień z poziomu zainstalowanej aplikacji. Android/desktop Chrome —
  działa od razu z przeglądarki.
- **Badge na ikonie:** `navigator.setAppBadge()` w service workerze przy
  odbiorze pusha, czyszczenie przy otwarciu aplikacji.
- Serwer: pakiet npm `web-push`; klucze VAPID (`VAPID_PUBLIC_KEY`,
  `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT=mailto:kontakt@lumlum.co`) w env
  Vercel + `.env` lokalnie.

## 3. Model danych (Supabase)

- `push_subscriptions`: `id`, `user_id → app_users`, `endpoint` (unique),
  `p256dh`, `auth`, `user_agent`, `created_at`, `last_used_at`.
  Jeden user = wiele urządzeń. Endpoint zwracający 404/410 przy wysyłce
  → wiersz kasujemy.
- `push_outbox` (kolejka): `id`, `user_id` (adresat), `title`, `body`,
  `url` (dokąd klik prowadzi), `tag` (collapse, np. `watek-123`),
  `created_at`, `sent_at`, `error`.

**Dlaczego outbox, a nie wysyłka inline:** nowe leady wpadają z różnych
źródeł (Make, sync z arkusza, webhook Zadarma), nie tylko z naszych
endpointów. Trigger Postgresa na tabeli łapie WSZYSTKIE źródła w jednym
miejscu i nie spowalnia requestów.

## 4. Producenci zdarzeń

1. **Nowy lead:** trigger `AFTER INSERT` na `"Leady B2C"` → wstawia do
   `push_outbox` wiersz dla ownera leada (kolumna Owner; domyślny owner z
   jednego konfigurowalnego miejsca — pkt 8 planu własności).
2. **Sprzedaż:** trigger `AFTER UPDATE` na tabeli wycen, gdy status
   przechodzi na „sfinalizowana" → outbox dla ownera + wszystkich adminów
   (`app_users.role='admin'`), z deduplikacją gdy owner jest adminem.
   ⚠️ Czeka na tabelę wycen z ownerem (plan własności zasobów).
3. **Feedback (czasowe):** pg_cron w Supabase (Vercel Hobby = max 1
   cron/dzień, więc jak zwykle pg_cron → endpoint z `CRON_SECRET`):
   - rano w dni robocze (np. 8:00): digest per user — leady z „Data
     Feedbacku" = dziś oraz akcje z terminem dziś;
   - co 5 min w godzinach pracy: leady, których „Data Feedbacku" = dziś i
     „Godzina Feedbacku" <= teraz → push **dokładnie w momencie feedbacku**
     (decyzja Antoniego 2026-07-11: przypomnienie w momencie, nie przed;
     znacznik „wysłano" per lead+termin, żeby nie dublować). Lead bez
     godziny = tylko poranny digest (dzień wystarczy). Kolumna „Godzina
     Feedbacku" ("HH:mm") jest już WDROŻONA — łapie ją analiza rozmów
     Zadarmy i notatki, plus ręczne pole na karcie leada
     (scripts/add-godzina-feedbacku.js, 2026-07-11). Analogicznie akcje
     z „Najbliższa akcja termin" z godziną.
4. **Nowa wiadomość:** hook w kodzie (nie trigger — werdykt triage'u
   zapada w JS): po `classifyInWebhook` w `ingest/zernio.js`, `gmail.js`,
   `tiktok.js` — TYLKO gdy werdykt = inbox (mute/pominięte nie pushują).
   Adresat: user przypisany do skrzynki (`kom_mailboxes.user_id`) dla
   maila; FB/IG/TikTok → Antoni. `tag` per wątek, żeby seria wiadomości
   nie spamowała.

## 5. Dispatcher (wysyłka)

- `POST /api/push/dispatch` (public prefix + `CRON_SECRET`, wzorzec jak
  `/api/cron/gmail`): bierze z `push_outbox` wiersze `sent_at IS NULL`,
  wysyła `web-push` do wszystkich subskrypcji adresata, oznacza `sent_at`
  / zapisuje `error`, kasuje martwe subskrypcje.
- pg_cron co 1 min w godzinach pracy (jak Gmail) — opóźnienie max ~1 min.
- Zdarzenia z własnych endpointów (np. ręczne dodanie wyceny w panelu)
  mogą dodatkowo strzelić dispatch od razu po insercie do outboxa.

## 6. UI włączania (apps/shared/)

- Przełącznik w topbarze (`apps/shared/topbar.js`): „🔔 Powiadomienia na
  tym urządzeniu" → rejestracja service workera, `pushManager.subscribe`
  (klucz publiczny VAPID), `POST /api/push/subscribe` (user z sesji,
  NIGDY z body — jak owner).
- Na iPhonie, gdy aplikacja NIE jest zainstalowana: zamiast przełącznika
  krótka instrukcja „Dodaj do ekranu początkowego, potem włącz tutaj".
- Wyłączenie = unsubscribe + DELETE subskrypcji.

## 7. Kolejność wdrożenia

1. **Etap 1 — fundament:** manifest + ikony + service worker + tabele +
   subskrypcja z topbaru + dispatcher + pg_cron; test „wyślij testowe
   powiadomienie" z panelu.
2. **Etap 2 — leady i wiadomości:** trigger na `Leady B2C` + hooki w
   ingest Komunikatora (te nie mają zależności, dane już są).
3. **Etap 3 — feedback:** crony poranny digest + przypomnienie o godzinie.
4. **Etap 4 — sprzedaże:** po wdrożeniu panelu Wyceny z ownerem
   (plan-wlasnosc-zasobow) trigger na finalizację wyceny.

## 8. Ograniczenia / uwagi

- ⚠️ NIE dopisywać częstych cronów do `vercel.json` (Hobby: cichy brak
  deployu z pusha) — wszystko częstsze niż 1/dzień przez pg_cron.
- Push bez otwartej strony działa; ale iOS potrafi wyciszyć PWA po
  długiej nieaktywności — badge + baner wracają przy kolejnym otwarciu.
- Treść powiadomienia zwięzła i konkretna: „Nowy lead: Jan Kowalski
  (Warszawa)", „Sprzedaż Lorenzo: 12 400 zł — Anna Nowak", „Feedback
  dziś 14:00: Piotr Wiśniewski", „Nowa wiadomość (IG): @klientka…".
  Klik otwiera właściwą kartę/wątek (`url` w outboxie).
