# Plan: Komunikator — zunifikowana komunikacja i pamięć klienta

Panel: **Wiadomości** (`apps/komunikator/`, live na `lumlum.dev/wiadomosci`).

## ⚡ AKTUALIZACJA 2026-07-11 wieczór — PIVOT: ManyChat OUT, Zernio IN

**Decyzja Antoniego:** ManyChat wylatuje W CAŁOŚCI (nie był jeszcze aktywny produkcyjnie,
zero kosztów utopionych). Kanały social (FB/IG/WhatsApp) wchodzą przez **Zernio**
(zernio.com, pełna dokumentacja: `docs.zernio.com/llms-full.txt` — przeanalizowana,
lokalna kopia była w scratchpadzie). Wszystkie sekcje o ManyChat poniżej = NIEAKTUALNE,
zostawione dla kontekstu decyzji.

**Dlaczego Zernio wygrywa (zweryfikowane w ich dokumentacji):**
- `comment.received` niesie PEŁNĄ TREŚĆ komentarza + autora (ManyChat w ogóle nie udostępnia treści)
- tag `HUMAN_AGENT` na IG i FB = okno odpowiedzi **7 dni** zamiast 24 h
- private reply na komentarz przez API (7 dni, 1/komentarz)
- API-first: webhooki rejestrowane kodem (`POST /v1/webhooks/settings`), HMAC-SHA256
  (`X-Zernio-Signature`, hex hmac surowego body), retry 7 prób/~51 h, dedup po `payload.id`
- payload: `message.text`, `message.sender` (z `instagramProfile`: followerCount, isFollower),
  `comment.text`+`comment.author`; eventy: `message.received/sent/edited/deleted/read`,
  `comment.received`, `conversation.started`
- wysyłka: `POST /v1/inbox/conversations/{id}/messages` (+ `/read`, `/typing`);
  `messageTag:"HUMAN_AGENT"` + `messagingType:"MESSAGE_TAG"` poza oknem 24 h
- WhatsApp pełny (szablony poza oknem, zakup numerów, sandbox)
- cennik: $6/$3/$1 za konto-miesiąc progresywnie, $12 kredytu/mies → FB+IG ≈ $0
- BONUS do zbadania: Zernio ma telefonię (numery, `call.received`, `call.ended` z nagraniem)
  — potencjalnie zamiast Zadarmy; **Antoni sam sprawdza temat numeru telefonu**

**Stan wdrożenia (commity 4beaa4c…9d40c10, wszystko live na prod):** tabele `kom_*`
(+pgvector), identity.js z 12 testami, panel wątki+rozmowa+notatki+scalanie, sugestie AI
(llm.js: Anthropic/OpenAI env varem, lazy, korekty→kom_examples — pętla uczenia
zweryfikowana), okno 24 h, obsługa komentarzy (placeholder). Klucze ANTHROPIC/OPENAI
w env (lokalnie + Vercel prod).

**Plan dla nowego czatu (migracja na Zernio):**
1. Antoni wkleja **klucz API Zernio** (Instagram jest już podłączony w ich dashboardzie;
   stronę FB podłączyć tak samo, gdy przyjdzie kolej).
2. `ingest/zernio.js` zamiast `ingest/manychat.js`: endpoint `/api/webhooks/zernio`
   (verifikacja X-Zernio-Signature), eventy message.received (→wątek jak dziś),
   message.sent (→direction out, łapie odpowiedzi wysłane poza panelem), comment.received
   (→wiadomość meta.kind=comment Z TREŚCIĄ, wątek waiting), conversation.started.
   Rejestracja webhooka przez API przy setupie. Tożsamość: sender id per platforma
   (typy fb/ig/wa bez zmian), `external_thread_id` = zernio conversationId.
3. Wysyłka przez Zernio Inbox API; po 24 h automatycznie z tagiem HUMAN_AGENT (do 7 dni);
   private reply na komentarze.
4. WYPIERDOLIĆ ManyChat: ingest/manychat.js, MANYCHAT_* env vary (lokalnie+Vercel),
   przycisk live_chat_url zastąpić linkiem Zernio (dashboard/inbox), odwołania w app.html.
5. Test end-to-end na koncie IG Antoniego, potem sugestie działają bez zmian
   (reszta stacku nietknięta — ingest był projektowany jako wymienny moduł).

---

Poniżej oryginalny plan (2026-07-11 rano) — architektura, model danych i fazy pozostają
aktualne; sekcje ManyChat czytać jako "kanał social", implementacyjnie zastąpione Zernio.

---

## 0. Jak to siedzi w istniejącym monorepo

Czwarta appka według dokładnie tego samego wzorca co CRM i Backlog:

```
apps/komunikator/
  app.html            ← panel (bubbles)
  assets/
  server/
    server.js         ← Express, montowany przez api/komunikator.js
    login.html
    supabase.js       ← kopia wzorca z apps/crm/server/supabase.js
    identity.js       ← moduł tożsamości klienta (osobny, testowalny)
    llm.js            ← abstrakcja nad OpenAI/Anthropic
    ingest/
      manychat.js     ← webhook Messenger/IG/WA
      zadarma.js      ← rozmowy telefoniczne
      notes.js        ← notatki głosowe (Wispr Flow)
    suggest.js        ← generowanie sugestii + korpus korekt
    commitments.js    ← ekstrakcja i pilnowanie obietnic
    push.js           ← Web Push
api/komunikator.js    ← wrapper Vercel (jak api/crm.js)
```

- **Auth**: to samo ciasteczko `lumlum_session` (HMAC z `SITE_PASSWORD`, `Path=/`) — jedno logowanie działa od razu, zero nowej pracy. **Wyjątek**: endpointy `/komunikator/api/webhooks/*` muszą być PRZED bramką logowania, zabezpieczone sekretnym tokenem w query stringu (dokładnie tak, jak dziś webhook Zadarmy w Backlogu).
- **vercel.json**: nowa funkcja `api/komunikator.js` z `includeFiles`, rewrites `/komunikator/:path*`, redirect `/komunikator` → `/komunikator/`, plus nowe crony (niżej).
- **Hub** (`apps/hub/app.html`): nowy kafelek.
- **Baza**: ta sama instancja Supabase, ale osobne tabele z prefiksem `kom_` (snake_case, po angielsku — celowo odróżnialne od tabel CRM typu `Leady B2C`). Luźne powiązanie z CRM = na razie żadnych FK między światami; jedyny pomost w przyszłości to opcjonalna kolumna `kom_customers.crm_lead_id`.

---

## 1. Schemat bazy (Supabase / Postgres + pgvector)

```sql
create extension if not exists vector;

-- ── Klient ────────────────────────────────────────────────────────────────
create sequence kom_customer_seq start 10001;

create table kom_customers (
  id           uuid primary key default gen_random_uuid(),
  public_id    text unique not null default ('LL-' || nextval('kom_customer_seq')),
  display_name text,            -- "Krzysiek (schody)" — ustawiane ręcznie lub przez AI
  crm_lead_id  text,            -- opcjonalny, przyszły pomost do CRM; NULL na start
  notes        text,
  created_at   timestamptz not null default now()
);

-- Tożsamości jako osobna tabela (nie kolumny na kliencie):
-- klient może mieć 2 telefony, unique(type,value) fizycznie uniemożliwia
-- ciche podpięcie tego samego numeru pod dwóch klientów.
create table kom_customer_identities (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references kom_customers(id),
  type        text not null check (type in ('fb','ig','wa','phone','email')),
  value       text not null,    -- znormalizowane: telefon = same cyfry, email = lowercase
  source      text not null,    -- 'webhook' | 'ai_extracted' | 'manual'
  confirmed   boolean not null default true,  -- false, gdy wyciągnięte przez AI z treści
  created_at  timestamptz not null default now(),
  unique (type, value)
);

-- ── Wątki i wiadomości ────────────────────────────────────────────────────
create table kom_threads (
  id                 uuid primary key default gen_random_uuid(),
  customer_id        uuid not null references kom_customers(id),
  channel            text not null check (channel in ('messenger','instagram','whatsapp','phone','email','note')),
  external_thread_id text,      -- ManyChat subscriber_id / numer telefonu
  status             text not null default 'attention'
                     check (status in ('attention','waiting','snoozed','closed')),
  snooze_until       timestamptz,
  last_message_at    timestamptz,
  created_at         timestamptz not null default now(),
  unique (channel, external_thread_id)
);

create table kom_messages (
  id                  uuid primary key default gen_random_uuid(),
  thread_id           uuid not null references kom_threads(id),
  direction           text not null check (direction in ('in','out','internal')),
  -- 'internal' = notatka głosowa Antoniego / podsumowanie rozmowy tel.
  body                text not null,
  sent_by             text check (sent_by in ('customer','antoni','ai_auto')),
  suggestion_id       uuid,     -- FK do kom_suggestions, gdy out powstał z sugestii
  external_message_id text,     -- dedup webhooków (ManyChat potrafi retry'ować)
  meta                jsonb,    -- np. {recording_url, call_duration, transcript_raw}
  created_at          timestamptz not null default now(),
  unique (thread_id, external_message_id)
);

-- ── Obietnice / follow-upy ────────────────────────────────────────────────
create table kom_commitments (
  id                uuid primary key default gen_random_uuid(),
  customer_id       uuid not null references kom_customers(id),
  thread_id         uuid references kom_threads(id),
  source_message_id uuid references kom_messages(id),
  description       text not null,          -- "obiecana wycena schodów"
  owner             text not null check (owner in ('my','klient')),
  -- 'my' = my coś obiecaliśmy; 'klient' = klient miał się odezwać
  due_at            timestamptz not null,
  status            text not null default 'open'
                    check (status in ('open','done','cancelled')),
  created_by        text not null check (created_by in ('ai','manual')),
  resolved_at       timestamptz,
  created_at        timestamptz not null default now()
);

-- ── Sugestie AI + korpus korekt ───────────────────────────────────────────
create table kom_suggestions (
  id             uuid primary key default gen_random_uuid(),
  thread_id      uuid not null references kom_threads(id),
  provider       text not null,             -- 'openai' | 'anthropic'
  model          text not null,
  prompt_version text not null,             -- np. 'suggest-v3' — do ewaluacji jakości
  suggested_text text not null,
  status         text not null default 'pending'
                 check (status in ('pending','sent_as_is','edited','ignored','auto_sent')),
  final_text     text,                      -- to, co realnie poszło (status edited/sent)
  decided_at     timestamptz,
  created_at     timestamptz not null default now()
);

-- Korpus przykładów: korekty na żywo ORAZ jednorazowy import historycznych
-- czatów z wycenami. Jedna tabela, bo selekcja do promptu działa identycznie.
create table kom_examples (
  id           uuid primary key default gen_random_uuid(),
  source       text not null check (source in ('correction','import')),
  context      text not null,   -- skrót sytuacji: ostatnie wiadomości / pytanie klienta
  suggested    text,            -- oryginalna sugestia AI (NULL dla importu)
  final        text not null,   -- wersja Antoniego = wzorzec
  tags         text[],          -- np. {'wycena','schody'} — ręczne lub AI
  embedding    vector(1536),    -- embedding kolumny context
  suggestion_id uuid references kom_suggestions(id),
  created_at   timestamptz not null default now()
);
create index on kom_examples using hnsw (embedding vector_cosine_ops);

-- ── Pamięć wektorowa ──────────────────────────────────────────────────────
-- Jedna przestrzeń dla wiadomości i podsumowań; filtr po customer_id
-- zawęża do historii jednego klienta.
create table kom_memory (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references kom_customers(id),
  message_id  uuid references kom_messages(id),
  kind        text not null check (kind in ('message','call_summary','note')),
  content     text not null,
  embedding   vector(1536) not null,
  created_at  timestamptz not null default now()
);
create index on kom_memory using hnsw (embedding vector_cosine_ops);
create index on kom_memory (customer_id);

-- ── Bezpiecznik scalania ──────────────────────────────────────────────────
create table kom_merge_proposals (
  id           uuid primary key default gen_random_uuid(),
  thread_id    uuid not null references kom_threads(id),  -- nowy/osierocony wątek
  candidate_id uuid not null references kom_customers(id),-- proponowany istniejący klient
  reason       text not null,   -- 'identity_conflict' | 'ai_probable_match'
  evidence     jsonb not null,  -- {claim: "pisałem o schodach na FB", matched_on: ...}
  confidence   real,
  status       text not null default 'pending'
               check (status in ('pending','confirmed','rejected')),
  decided_at   timestamptz,
  created_at   timestamptz not null default now()
);

-- ── Kolejka wysyłki (opóźnienie anty-botowe + okno "cofnij") ─────────────
create table kom_outbox (
  id            uuid primary key default gen_random_uuid(),
  thread_id     uuid not null references kom_threads(id),
  body          text not null,
  suggestion_id uuid references kom_suggestions(id),
  queued_by     text not null check (queued_by in ('antoni','ai_auto')),
  send_after    timestamptz not null,   -- auto: now() + losowe 4–15 min
  status        text not null default 'queued'
                check (status in ('queued','sent','cancelled','failed')),
  sent_at       timestamptz,
  error         text,
  created_at    timestamptz not null default now()
);

-- ── Push ──────────────────────────────────────────────────────────────────
create table kom_push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  endpoint   text unique not null,
  keys       jsonb not null,    -- {p256dh, auth}
  created_at timestamptz not null default now()
);

-- Surowe payloady webhooków — debug + replay, gdy parser się wysypie.
create table kom_inbox_raw (
  id         uuid primary key default gen_random_uuid(),
  source     text not null,     -- 'manychat' | 'zadarma' | 'note'
  payload    jsonb not null,
  processed  boolean not null default false,
  error      text,
  created_at timestamptz not null default now()
);
```

Migracje jako pliki SQL w `apps/komunikator/migrations/`, odpalane ręcznie przez pooler (jak przy CRM — host db jest IPv6-only, działa `aws-0-eu-west-3` pooler).

---

## 2. Moduły ingestii (webhooki → wspólny model)

Wspólny wzorzec każdego modułu: **(1)** zweryfikuj sekret, **(2)** zapisz surowy payload do `kom_inbox_raw`, **(3)** dedup po `external_message_id`, **(4)** `identity.resolve()` → customer + thread, **(5)** insert `kom_messages`, thread → `attention`, **(6)** push. Kroki 1–6 są tanie i synchroniczne (mieszczą się w webhooku). Cała droga praca AI (embedding, ekstrakcja obietnic, sugestia) dzieje się **poza webhookiem** — patrz §6.

### 2a. ManyChat (Messenger, Instagram, później WhatsApp)

- W ManyChat: automatyzacja "na każdą wiadomość" → **External Request** na `POST /komunikator/api/webhooks/manychat?token=SEKRET`, body z polami: `subscriber_id`, kanał, treść, imię, timestamp.
- `subscriber_id` + kanał → tożsamość `fb`/`ig`/`wa`, `external_thread_id` wątku.
- **Wiadomości wychodzące**: przez ManyChat API (`/fb/sending/sendContent`) — panel wysyła odpowiedź tym samym subscriber_id. Wysłana wiadomość też ląduje w `kom_messages` (direction `out`).
- ⚠️ Ograniczenie Meta: na Messengerze/IG standardową wiadomość można wysłać do **24 h od ostatniej wiadomości klienta**. To reguła platformy Meta (Send API), nie ManyChata — **własna integracja z API FB/IG podlega dokładnie tej samej zasadzie**, więc nic nie daje. Panel pokazuje przy bubble "okno zamyka się za Xh" i po czasie blokuje wysyłkę z podpowiedziami. Drogi obejścia po zamknięciu okna, od najlepszej:
  1. **WhatsApp — template messages**: okno 24 h obowiązuje też na WhatsAppie, ALE WhatsApp jako jedyny ma oficjalny mechanizm jego otwierania — zatwierdzone szablony wiadomości (płatne per konwersacja, grosze). Idealne do follow-upów "obiecałem wycenę / miał się Pan odezwać". To mocny argument, żeby WhatsApp wszedł szybko i żeby AI w rozmowach na FB/IG naturalnie pozyskiwało numer telefonu.
  2. **Fallback ręczny przez Business Suite (pomysł Antoniego — wchodzi do fazy 1)**: panel przy zamkniętym oknie pokazuje **imię i nazwisko klienta** (ManyChat podaje je w webhooku) + przycisk kopiujący dane + sugerowaną treść. Antoni znajduje osobę w Meta Business Suite i wysyła ręcznie, a w panelu klika "wysłane ręcznie" — odpowiedź zapisuje się w wątku, więc historia zostaje kompletna.
  3. **Human agent tag (opcja na później)**: własna aplikacja Meta z zatwierdzonym tagiem `HUMAN_AGENT` wydłuża okno do **7 dni** dla odpowiedzi człowieka — wymaga app review u Mety; realne, ale to osobny projekt, nie na start.
  4. **Telefon** — panel podpowiada "zadzwoń", numer już w karcie klienta.

### 2b. Zadarma (telefon)

- **ROZSTRZYGNIĘTE (2026-07-11): osobne konto Zadarma** — Antoni kupi własny numer na nowym koncie. Webhook tego konta wskazuje wprost na `/komunikator/api/webhooks/zadarma?token=SEKRET`, zero styku z Backlogiem. Osobne klucze API w env varach Komunikatora (`ZADARMA_API_KEY`/`SECRET` tej appki).
- Pipeline po zdarzeniu zakończonej rozmowy: pobierz nagranie (kod podpisywania requestów już istnieje w `apps/backlog-b2c/server/zadarma.js` — wydzielić do `apps/shared/server/zadarma.js`), transkrybuj (wzorzec transkrypcji OpenAI też już jest w Backlogu), potem analiza LLM → jedna wiadomość `internal` w wątku `phone`: podsumowanie + pełna transkrypcja w `meta`.
- Analiza LLM przy okazji zwraca: wykryte obietnice (→ `kom_commitments`), wykryte identyfikatory ("pisałem na Facebooku", padł email) → `identity.enrich()` / propozycja scalenia.
- Nagranie może być gotowe z opóźnieniem → obsługa przez retry w cronie roboczym (payload czeka w `kom_inbox_raw` z `processed=false`).

### 2c. Notatki głosowe (Wispr Flow)

- Wispr Flow robi dyktowanie → tekst, więc nie potrzeba uploadu audio: w panelu pole "Nowa notatka" — Antoni wkleja/dyktuje tekst + podaje numer telefonu klienta (osobne pole, nie parsowanie z treści — mniej magii, zero pomyłek).
- `POST /komunikator/api/notes` → `identity.resolve({type:'phone', value})` → wiadomość `internal` w wątku `note` (albo dopięta do istniejącego wątku `phone` tego klienta — proponuję: do wątku `phone`, jeśli istnieje, inaczej nowy wątek `note`).
- Ta sama analiza LLM co przy transkrypcji rozmowy (obietnice, identyfikatory).

### 2d. Email (Gmail)

Poza zakresem startu (osobny moduł "Asystent LumLum"). Schemat jest gotowy (`channel='email'`, tożsamość `email`) — integracja dopnie się później bez zmian modelu.

---

## 3. Tożsamość klienta — `identity.js`

Osobny moduł czystych funkcji, testowalny `node --test` bez sieci (Supabase wstrzykiwany jako parametr).

**API modułu:**

```js
normalize(type, value)                 // phone → same cyfry (por. normalizePhoneDigits
                                       // z CRM), email → trim+lowercase, fb/ig/wa → string
resolveCustomer(db, {type, value})     // → { customer, created: bool }
                                       //   znajdź po unique(type,value); brak → nowy
                                       //   Customer LL-XXXXX + wpis tożsamości
attachThread(db, customer, channel, externalThreadId)
enrichCustomer(db, customerId, {type, value, source})
                                       // → 'added' | 'already_own'
                                       //   | { conflict: otherCustomer }  ← bezpiecznik
proposeMerge(db, {threadId, candidateId, reason, evidence, confidence})
confirmMerge(db, proposalId)           // przepina wątki+tożsamości+memory na jednego
                                       // klienta, drugiego oznacza jako scalonego
```

**Reguły (wprost z briefu):**

1. Pierwsze zdarzenie z nieznanym identyfikatorem → nowy Customer z nowym `LL-…` i tym jednym atrybutem.
2. Dopasowanie **wyłącznie** po tożsamościach z `kom_customer_identities` (fb / ig / wa / phone / email). Nigdy po imieniu ani treści.
3. Nowy identyfikator w treści (AI wyciągnęło numer z rozmowy): jeśli wolny → `enrich` z `confirmed=false` i `source='ai_extracted'`; jeśli należy do **innego** klienta → **żadnego automatycznego scalania**, powstaje `kom_merge_proposals` i panel pokazuje "połączenie do potwierdzenia".
4. Miękkie dopasowanie ("jestem Krzysiek, pisałem o schodach na FB"): krok analizy transkrypcji prosi LLM o kandydatów spośród ostatnich wątków FB/IG tego typu tematu → `kom_merge_proposals` z `evidence` i `confidence` → w panelu baner "wykryto prawdopodobne dopasowanie do wątku X — potwierdzasz?". Zawsze pytanie, nigdy auto.

**Testy jednostkowe** (przed jakimkolwiek webhookiem na żywo): nowy klient z każdego kanału; drugi kanał tego samego klienta; konflikt numeru między dwoma klientami; idempotencja (dwa razy ten sam webhook = jeden klient, jedna wiadomość); confirmMerge przepina wszystko.

### Wzmocnienia łączenia (dodane po feedbacku Antoniego, 2026-07-11)

Twarde dopasowanie po identyfikatorach działa tylko tak dobrze, jak dużo identyfikatorów system zna. Dlatego:

1. **Dociąganie profilu z ManyChat**: przy pierwszym kontakcie pobieramy przez ManyChat API pełny profil subskrybenta (imię i nazwisko, telefon/email jeśli podał, avatar) — nie tylko subscriber_id z webhooka. Imię nie służy do automatycznego łączenia (za słabe), ale zasila propozycje scaleń i widok karty.
2. **AI wyłuskuje identyfikatory z każdej treści**: każda wiadomość, transkrypcja i notatka przechodzi przez ekstrakcję "czy padł tu numer telefonu / email / wzmianka o innym kanale («pisałem na Facebooku», «napiszę z konta żony»)". Znaleziony identyfikator → `enrich` albo propozycja scalenia.
3. **AI aktywnie pozyskuje numer telefonu w czacie**: sugerowane odpowiedzi na FB/IG przy naturalnej okazji (wycena, umówienie rozmowy) proszą o numer — bo numer to najtwardszy łącznik między kanałami *i* jednocześnie otwiera drogę WhatsApp/telefon po zamknięciu okna 24 h. To zapisane w stałej instrukcji promptu sugestii.
4. **"Dzwonię do niego" — łączenie intencją**: w karcie wątku FB/IG przycisk "dzwonię do tego klienta" — panel zapamiętuje na ~30 min, że najbliższa rozmowa z nowego numeru na Zadarmie to prawdopodobnie ten klient, i proponuje połączenie jednym klikiem. Analogicznie rozmowa wychodząca na numer z karty → auto-link.
5. **Podpowiedzi kandydatów przy dzwoniącym nieznanym numerze**: po transkrypcji AI porównuje temat rozmowy (embedding) + imię z transkrypcji z otwartymi wątkami FB/IG z ostatnich tygodni → ranking kandydatów w `kom_merge_proposals`, nigdy auto-merge.
6. **Karta klienta = jedna oś czasu**: wszystkie wątki klienta w jednym widoku chronologicznym (Messenger, telefon, notatki przeplecione), z tożsamościami i otwartymi obietnicami na górze. To jest miejsce, gdzie scalenie realnie widać.
7. **Scal / rozdziel ręcznie**: wyszukiwarka klientów + ręczne scalenie dwóch kart z poziomu UI; scalenie odwracalne (przechowujemy, które wątki przyszły skąd — "rozdziel" przepina z powrotem). Bez tego jedna zła decyzja przy propozycji AI byłaby trwała.
8. **Push z kartą przy dzwoniącym znanym numerze**: Zadarma wysyła webhook już przy **początku** połączenia (NOTIFY_START) — jeśli numer jest znany, telefon dostaje push "Dzwoni Krzysiek — schody, obiecana wycena do piątku" zanim Antoni odbierze. Największa praktyczna wartość scalonych wątków: kontekst *przed* rozmową, nie po.
9. **Wyszukiwarka globalna**: jedno pole szukające po treści wszystkich wiadomości (tekstowo + wektorowo) i danych klientów — "gdzie była rozmowa o schodach dębowych" znajduje wątek niezależnie od kanału.

---

## 4. Powiadomienia push

**Web Push (VAPID)** — jedyna opcja bez zewnętrznych usług w stacku Vercel+Supabase:

- Biblioteka `web-push` (npm) po stronie serwera, klucze VAPID w env varach Vercela.
- W panelu: service worker (`sw.js`) + przycisk "Włącz powiadomienia" → subskrypcja do `kom_push_subscriptions`.
- Wysyłka w dwóch miejscach: (a) ingest — nowa wiadomość przychodząca od klienta, (b) cron obietnic — przeterminowany commitment / klient miał się odezwać i się nie odezwał.
- Klik w powiadomienie → otwiera panel na konkretnym bubble (`/komunikator/#thread=UUID`).
- Rozróżnienie "wymaga odpowiedzi" vs "tylko potwierdzenie odbioru": w **fazie 1 powiadamiamy o każdej przychodzącej** (prostota > filtrowanie); klasyfikator intencji z fazy 2 zacznie wyciszać wiadomości typu "ok, dzięki".
- ⚠️ iPhone: Web Push działa od iOS 16.4, ale **tylko gdy panel jest dodany do ekranu głównego jako PWA** (potrzebny `manifest.json`). Jednorazowa czynność Antoniego. Fallback, gdyby to uwierało: powiadomienia mailowe (wzorzec wysyłki maili już jest w Backlogu przy cronach).

---

## 5. Pamięć wektorowa

- **Co embedujemy**: (a) każdą wiadomość ≥ ~40 znaków (pomijamy "ok", "dzięki" — szum i koszt), (b) podsumowania rozmów telefonicznych (podsumowanie zamiast surowej transkrypcji — transkrypcja zostaje w `meta` do wglądu), (c) notatki, (d) `context` w `kom_examples`.
- **Model**: OpenAI `text-embedding-3-small` (1536 wymiarów — stąd `vector(1536)`; groszowe koszty przy tej skali). Klucz OpenAI już jest w projekcie.
- **Kiedy**: w cronie roboczym / lazy przy otwarciu bubble'a, nie w webhooku — brak embeddingu nigdy nie blokuje przyjęcia wiadomości.
- **Odczyt przy sugestii** (dwa zapytania, oba z limitem):
  1. `kom_memory where customer_id = X order by embedding <=> query limit 6` — istotna historia **tego** klienta sprzed tygodni (ostatnich ~15 wiadomości wątku i tak idzie do promptu w całości, wektor dociąga tylko starsze/inne kanały);
  2. `kom_examples order by embedding <=> query limit 4` — wzorce odpowiedzi (korekty + import) najbliższe obecnej sytuacji.
- **Kontrola kosztów**: sugestia generowana **lazy** (przy otwarciu bubble'a, patrz §6), embeddingi tylko raz per treść, HNSW zamiast skanu, twarde limity k. Przy skali LumLum (dziesiątki wiadomości dziennie, nie tysiące) koszty wektorów są pomijalne — realny koszt to generacja sugestii, i to kontroluje lazy.

---

## 6. Agent AI: sugestie, obietnice, uczenie na korektach

### Abstrakcja nad dostawcą — `llm.js`

```js
complete({ task, system, messages, json_schema? }) → { text | json, provider, model }
```

- `task` ('suggest' | 'extract' | 'classify' | 'summarize_call') mapuje się przez env vary na dostawcę+model, np. `LLM_SUGGEST=anthropic:claude-sonnet-5`, `LLM_EXTRACT=openai:gpt-5.1`. Zmiana modelu = zmiana env vara, zero zmian w logice panelu.
- Dwa adaptery: OpenAI (chat completions — wzorzec już w Backlogu) i Anthropic (Messages API). Oba zwracają ujednolicony kształt.
- Każda sugestia zapisuje `provider`, `model`, `prompt_version` → można porównywać jakość między modelami po fakcie (odsetek "wysłane bez edycji" per model).

### Pipeline sugestii — lazy, na otwarcie bubble'a

Rekomendacja: sugestia generuje się **w momencie wejścia w bubble** (spinner 2–4 s), nie z góry po każdym webhooku. Powody: zawsze świeży kontekst (klient mógł dopisać drugą wiadomość), zero kosztu za wątki, które Antoni zignoruje, zero potrzeby kolejki. Pre-generacja to łatwa optymalizacja później, jeśli spinner będzie wkurzał.

Prompt składany z: profil klienta (tożsamości, `display_name`, otwarte obietnice) → ostatnie ~15 wiadomości wątku → dociągnięta pamięć wektorowa (§5) → 4 przykłady z korpusu jako wzorce stylu i treści ("tak Antoni poprawia / tak Antoni pisze wyceny") → instrukcja stała (ton, podpis, numer telefonu firmowy).

### Trzy akcje w bubble → korpus

- **Wyślij** → `kom_suggestions.status='sent_as_is'` (sygnał: prompt działa).
- **Edytuj i wyślij** → `status='edited'`, `final_text` zapisany, automatycznie powstaje wiersz w `kom_examples (source='correction')` z embeddingiem kontekstu.
- **Ignoruj** → `status='ignored'`, bubble znika (thread → `waiting`), wraca gdy klient znów napisze.

### Import historycznych czatów

Jednorazowy skrypt `scripts/import-examples.js` (wzorzec: `scripts/sync-leady-from-sheet.js` w CRM): wejście = eksport rozmów (format do ustalenia z Antonim, patrz pytania), LLM tnie na pary *pytanie-klienta → finalna-odpowiedź-Antoniego*, każda para → `kom_examples (source='import')` z tagami i embeddingiem. Skrypt idempotentny, odpalany ręcznie.

### Obietnice i przeterminowania

- Po każdej przychodzącej wiadomości / transkrypcji: `extract` (JSON schema) zwraca listę obietnic z datami ("dam znać za tydzień" → `due_at = now()+7d`, owner=`my`/`klient`). Wpisy widoczne na karcie wątku — Antoni może skasować błędne (AI-created, human-curated).
- **Cron roboczy** (`/komunikator/api/cron/worker`, co 5–15 min w godzinach pracy): przetwarza zaległe `kom_inbox_raw` (nagrania Zadarmy gotowe z opóźnieniem), dociąga embeddingi, sprawdza `kom_commitments where status='open' and due_at < now()` → thread wraca do `attention` + push "Krzysiek miał się odezwać we wtorek — cisza".
- Zamknięcie obietnicy: ręcznie w UI albo auto-propozycja, gdy AI wykryje w nowej wiadomości, że temat załatwiony.

### Pomiar, czy jakość rośnie

Prosty widok/endpoint statystyk tygodniowych: % sugestii `sent_as_is` vs `edited` vs `ignored`, per `prompt_version` i per model. To jedyna metryka potrzebna na start; jeśli % bez edycji rośnie — uczenie działa.

### Faza 2 — responder intencji

- Tabela `kom_intents` (nazwa, opis dla klasyfikatora, lista wariantów odpowiedzi, `enabled`).
- Klasyfikator (`task='classify'`) przy każdej przychodzącej: dopasowana intencja + wysoka pewność → odpowiedź = losowy wariant.
- **Tryb shadow najpierw**: przez 2–4 tygodnie responder tylko proponuje ("wykryto intencję: kontakt — wysłać wariant B?"), Antoni klika tak/nie. Dopiero przy stabilnej trafności → `enabled=true` per intencja i wysyłka auto (`sent_by='ai_auto'`, bubble z odznaką "wysłane automatycznie" do wglądu, nie do akcji).
- **Opóźnienie anty-botowe (wymóg Antoniego)**: automatyczna odpowiedź nigdy nie wychodzi natychmiast. Trafia do `kom_outbox` z `send_after = now() + losowe 4–15 min` (zakres konfigurowalny env varem); cron roboczy wysyła zaległe wpisy. Bonus: do momentu `send_after` odpowiedź widać w panelu jako "zaplanowana" z przyciskami *wyślij teraz* / *anuluj* — naturalne okno "cofnij". Ręczne odpowiedzi Antoniego idą od razu (człowiek odpisujący po swoim czasie i tak nie wygląda jak bot), chyba że sam kliknie "wyślij później". Bezpiecznik: jeśli opóźnienie zbliżałoby wysyłkę do końca 24-godzinnego okna Meta, wysyłamy wcześniej.

---

## 7. Plan fazowy — etapy budowane i testowalne niezależnie

**Etap 0 — szkielet** (½ dnia): `apps/komunikator/` + `api/komunikator.js` + vercel.json + kafelek w hubie + migracje SQL. Test: logowanie działa, pusty panel wstaje na lumlum.dev/komunikator.

**Etap 1 — tożsamość + ingest ManyChat** (1–2 dni): `identity.js` z testami jednostkowymi, webhook ManyChat, surowa lista wątków i widok rozmowy (bez AI, bez wysyłania). Test: curl symulujący payloady ManyChat + realna wiadomość testowa z Messengera → pojawia się w panelu, drugi kanał skleja się do tego samego LL-ID.

**Etap 2 — wysyłanie odpowiedzi** (1 dzień): pole odpowiedzi w wątku → ManyChat API → `kom_messages(out)`. Wskaźnik okna 24 h. Test: pełna pętla Messenger tam-i-z-powrotem. *Już po tym etapie panel jest używalny jako zunifikowana skrzynka, bez AI.*

**Etap 3 — telefon + notatki** (1–2 dni): fan-out webhooka Zadarmy z Backlogu, pobranie nagrania, transkrypcja, podsumowanie LLM, endpoint notatek. Test: prawdziwa rozmowa testowa → podsumowanie w wątku klienta; notatka z numerem → dokleja się do właściwego LL-ID.

**Etap 4 — bubbles + sugestie + korpus korekt** (2–3 dni): widok bubble'ów (attention/waiting/closed), lazy sugestia, trzy akcje, zapis korekt do `kom_examples`, `llm.js` z oboma dostawcami. Test: kilka dni realnego używania w fazie 1 (wszystko ręcznie akceptowane).

**Etap 5 — obietnice** (1–2 dni): ekstrakcja, sekcja/filtr Commitmenty, cron roboczy, powrót bubble'a po terminie. Test: obietnica "za 2 dni" w rozmowie testowej → bubble wraca po terminie.

**Etap 6 — push** (1 dzień): VAPID, service worker, manifest PWA, wysyłka z ingestu i crona. Test: telefon w kieszeni, wiadomość z Messengera → push.

**Etap 7 — pamięć wektorowa + import** (1–2 dni): embeddingi w cronie, retrieval w prompcie sugestii, `scripts/import-examples.js` na historycznych czatach. Test: pytanie nawiązujące do rozmowy sprzed tygodni → sugestia zawiera właściwy kontekst.

**Etap 8 — Faza 2: responder** (po ≥2 tyg. stabilnej fazy 1): intencje, shadow mode, potem auto per intencja. **Faza 3** — świadomie bez planu teraz; decyzja po danych z etapów 4–8.

Kolejność 3↔4 i 5↔6↔7 można przestawiać — moduły są niezależne. Najkrótsza droga do wartości: 0→1→2 (zunifikowana skrzynka), potem 4 (AI), potem 5 (obietnice = główny ból).

---

## 8. Zadania Antoniego — rzeczy, które musisz zrobić ręcznie

Wszystko poza tą listą robi Claude Code (kod, migracje SQL, env vary przez Vercel CLI, deploye). Przy każdym kroku dostaniesz dokładną instrukcję klik-po-kliku w momencie, gdy będzie potrzebny.

**Przed startem (raz):**

- [ ] Odpowiedzieć na pytania otwarte z §9 (wystarczy głosówka / krótka wiadomość).
- [ ] **Klucz API Anthropic + kredyty**: konto na console.anthropic.com, doładować kredyty (np. $5–10 na start), wygenerować klucz i podesłać. *Uwaga: subskrypcja Claude Max tego NIE pokrywa — API rozlicza się osobno, pay-as-you-go.* Klucz OpenAI już jest w projekcie.

**Etap 1–2 (ManyChat):**

- [ ] Potwierdzić plan ManyChat Pro i wygenerować **API token** (Settings → API) — podesłać.
- [ ] W ManyChat utworzyć automatyzację "każda wiadomość → External Request" na URL webhooka, który podam (dostaniesz gotową konfigurację pól do przeklikania).
- [ ] Jeśli Instagram ma wchodzić od razu: podpiąć konto IG pod ManyChat.
- [ ] Wysłać testową wiadomość z Messengera i sprawdzić, że pojawia się w panelu.

**Etap 3 (telefon):**

- [ ] Założyć osobne konto Zadarma i kupić swój numer.
- [ ] W panelu Zadarma: włączyć nagrywanie rozmów, ustawić webhook na URL, który podam, wygenerować klucze API — podesłać.
- [ ] Wykonać testową rozmowę i sprawdzić podsumowanie w panelu.

**Etap 6 (powiadomienia):**

- [ ] Na iPhonie: otworzyć panel w Safari → Udostępnij → **"Dodaj do ekranu początkowego"** (30 sekund, raz) → otworzyć z ikonki → kliknąć "Włącz powiadomienia".

**Etap 7 (import wiedzy):**

- [ ] Dostarczyć historyczne czaty z wycenami (pytanie nr 5 — skąd i w jakim formacie).

**Na bieżąco (to jest jednocześnie trening AI):**

- [ ] Używać panelu: wysyłać/edytować/ignorować sugestie — każda edycja uczy system.
- [ ] Potwierdzać lub odrzucać proponowane scalenia klientów.

## 9. Pytania otwarte do Antoniego

**Biznesowe / produktowe:**

1. **Nazwa i ścieżka panelu** — proponuję `Komunikator` / `lumlum.dev/komunikator`. OK?
2. ~~Zadarma — Twój numer~~ **ROZSTRZYGNIĘTE**: osobne konto Zadarma z nowo kupionym numerem Antoniego — czysty, niezależny webhook.
3. **ManyChat — plan konta**: External Request i API wymagają planu Pro. Jest Pro? I czy Instagram jest już podpięty pod ManyChat, czy tylko Messenger?
4. ~~Okno 24 h Meta~~ **ROZSTRZYGNIĘTE (2026-07-11)**: po zamknięciu okna panel daje fallback ręczny przez Business Suite (imię i nazwisko + treść do skopiowania + przycisk "wysłane ręcznie"), docelowo follow-upy przez szablony WhatsApp; human agent tag (7 dni) jako ewentualny osobny projekt później — szczegóły w §2a.
5. **Import historycznych czatów**: skąd i w jakim formacie? (eksport z ChatGPT? skopiowane rozmowy z Messengera?) Od tego zależy parser importu.
6. **Push na iPhonie** wymaga dodania panelu do ekranu głównego jako PWA — jednorazowo, ale trzeba to zrobić. OK, czy wolisz równolegle powiadomienia mailem?
7. **Kto używa panelu?** Zakładam: tylko Ty (jedno hasło, brak ról). Lorenzzo nie potrzebuje dostępu?
8. **Numer telefonu w auto-odpowiedziach** ("604 650 590" z briefu) — potwierdź, że to właściwy numer do podawania klientom.

**Techniczne (mam rekomendacje, wystarczy "ok"):**

9. **Lazy generacja sugestii** (spinner 2–4 s przy otwarciu bubble'a) zamiast pre-generacji po każdym webhooku — rekomendowane dla kosztów i świeżości. OK?
10. **Cron roboczy co 5–15 min** — plan Vercela musi na to pozwalać (obecne crony są dzienne; Pro pozwala na częstsze). Potwierdzić plan konta.
11. **Embeddingi OpenAI** (`text-embedding-3-small`) — jeden dostawca embeddingów na stałe (zmiana dostawcy = re-embedding całości), sugestie pozostają przełączalne OpenAI/Anthropic. OK?
12. **Retencja nagrań**: nie kopiujemy audio do siebie, trzymamy link do Zadarmy + transkrypcję u nas (nagrania w Zadarmie wygasają po ich okresie retencji — transkrypcja zostaje na zawsze). OK?
