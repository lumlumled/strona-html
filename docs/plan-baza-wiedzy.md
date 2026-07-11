# Plan: Baza Wiedzy LumLum — samodoskonalący się mózg biznesu

**Status: OPIS PROJEKTU (2026-07-11, wieczór) — do realizacji w nowym czacie.**
Autor wymagań: Antoni (głosowo). Ten dokument jest jedynym briefem — nowy czat
zaczyna od przeczytania go w całości oraz sekcji ⚡ w `docs/plan-komunikator.md`.

## 1. Cel (słowami Antoniego, uporządkowane)

Jeden centralny **hub wiedzy o biznesie** (produkty, ceny, aspekty techniczne,
know-how, sposób prowadzenia działalności), który:

1. **Rozumie i odpowiada** — można mu zadać pytanie i dostać odpowiedź opartą
   na zgromadzonej wiedzy (panel Q&A + API).
2. **Sam się uczy** — wyłapuje wiedzę z codziennej pracy: odpowiedzi Antoniego
   i Lorenza na komentarze/maile/wiadomości, rozmowy telefoniczne (transkrypcje),
   wyceny, korekty sugestii AI. „Za dwa miesiące ma mieć wszystkie możliwe
   informacje o biznesie i podejmować mądrzejsze decyzje."
3. **Zasila każde narzędzie** — obecne i przyszłe: sugestie AI w Komunikatorze
   (komentarze, maile, DM), odpowiedzi AI w CRM dla Lorenza (leady), przyszły
   autoresponder, analiza rozmów telefonicznych. Jedno źródło prawdy zamiast
   wiedzy rozproszonej po promptach.
4. **Pilnuje dostępu** — dane krytyczne (zarobki, marże, zyski, koszty zakupu)
   są TYLKO dla Antoniego. Gdy Lorenzo (albo narzędzie działające w jego
   kontekście) zapyta o nie, system odpowiada **„nie mam takich informacji"**
   — NIGDY „nie masz dostępu" (nie wolno ujawniać, że ukryta wiedza istnieje).

## 2. Kontekst istniejącego systemu (z czym się integrujemy)

Monorepo `strona-html-repo`, jeden projekt Vercel (crm_ll), path-routing na
lumlum.dev, wspólna Supabase (Postgres + pgvector już włączony):

- **apps/hub** — ekran startowy, wspólne logowanie (`app_users`, cookie
  `lumlum_session` Path=/, HMAC). **Uprawnienia per panel już istnieją
  server-side** — patrz `apps/shared/server/auth.js`. Antoni i Lorenzo mają
  osobne konta → rola wywołującego jest znana przy KAŻDYM requeście. To jest
  fundament kontroli dostępu do wiedzy.
- **apps/komunikator** (lumlum.dev/wiadomosci) — zunifikowana skrzynka
  (FB/IG przez Zernio, komentarze TikTok przez Apify, Gmail przez OAuth),
  triage AI (`server/triage.js`), sugestie AI (`server/suggest.js` +
  `server/llm.js` — abstrakcja OpenAI/Anthropic per task przez env), pętla
  uczenia stylu odpowiedzi już istnieje: korekty sugestii → `kom_examples`
  (embedding, retrieval do promptu). **Baza wiedzy to rozszerzenie tej idei
  z „jak pisać" na „co wiedzieć".**
- **apps/crm** (lumlum.dev/crm) i **apps/backlog-b2c** — leady B2C, karta
  leada w `apps/shared/` (zmiany karty TYLKO tam), transkrypcje rozmów
  Zadarma + podsumowania AI już działają w Backlogu (wzorzec transkrypcji
  do reużycia).
- **Infra-ograniczenia:** Vercel HOBBY → crony częstsze niż dzienne przez
  pg_cron w Supabase (wzorzec: joby `komunikator_worker`, `komunikator_gmail`);
  db host IPv6-only → migracje przez pooler `aws-0-eu-west-3` (wzorzec:
  `apps/komunikator/migrations/run.js`); klucze LLM już w env (ANTHROPIC/OPENAI),
  embeddingi standardowo `text-embedding-3-small` (1536 wymiarów — jak
  `kom_memory`/`kom_examples`).

## 3. Pryncypia projektowe (nie negocjujemy bez Antoniego)

1. **Jedna baza, wielu konsumentów.** Moduł `apps/shared/server/knowledge.js`
   (jak LeadKarta) + tabele `kb_*` we wspólnej Supabase. Panel to tylko jeden
   z klientów modułu.
2. **Widoczność egzekwowana przy retrievalu, nie w prompcie.** Filtr
   `visibility` nakładany na zapytanie do bazy ZANIM cokolwiek trafi do
   kontekstu LLM. Zakazane: wkładanie tajnych faktów do promptu z instrukcją
   „nie mów o tym" (prompt-leak). Fakt niedostępny dla roli = dla LLM nie
   istnieje → naturalnie odpowie „nie mam takich informacji".
3. **Fakt jako jednostka wiedzy.** Nie surowe chunki dokumentów, tylko
   atomowe, redagowalne fakty (tytuł + treść + tagi + widoczność + źródło).
   Dokumenty się importuje, ale LLM tnie je na fakty. Fakt można poprawić,
   zdezaktualizować, podejrzeć skąd pochodzi.
4. **Human-in-the-loop na start.** Wiedza wyłapana automatycznie trafia do
   kolejki `proposed` — Antoni zatwierdza/edytuje/odrzuca w panelu (jak
   propozycje scaleń w Komunikatorze). Auto-zatwierdzanie dopiero, gdy
   trafność będzie potwierdzona (analogia: shadow mode respondera z planu
   Komunikatora).
5. **Wersjonowanie zamiast nadpisywania.** Nowa wersja faktu (np. zmiana ceny)
   archiwizuje starą (`superseded_by`) — historia „co system wiedział kiedy"
   zostaje. Konflikt nowej informacji z istniejącym faktem → propozycja
   aktualizacji, nie cicha podmiana.
6. **Domyślna widoczność przy ekstrakcji: `owner`** (bezpieczniej ukryć za
   dużo niż wyciec marżę). Antoni przy zatwierdzaniu obniża do `team`.
   Klasyfikator może proponować widoczność, decyduje człowiek.

## 4. Model danych (propozycja — do dopracowania w realizacji)

```sql
create table kb_facts (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,             -- "Cena zestawu schodowego 14 stopni"
  content       text not null,             -- pełna treść faktu, po polsku
  tags          text[],                    -- {'cennik','schody','montaż'}
  visibility    text not null default 'owner'
                check (visibility in ('owner','team','public')),
  -- owner  = tylko Antoni (marże, zyski, koszty, strategie cenowe)
  -- team   = Antoni + Lorenzo + narzędzia działające dla klientów
  -- public = można cytować wprost klientowi (opisy produktów, FAQ)
  status        text not null default 'active'
                check (status in ('proposed','active','rejected','archived')),
  source        text not null
                check (source in ('manual','import','extracted','correction')),
  source_ref    jsonb,                     -- {kind:'kom_message', id:...} / {kind:'call', ...} / {kind:'document', ...}
  superseded_by uuid references kb_facts(id),
  embedding     vector(1536),
  created_by    text,                      -- app_users.id / 'ai'
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index on kb_facts using hnsw (embedding vector_cosine_ops);

create table kb_documents (                -- importy: cenniki, opisy, PDF-y
  id uuid primary key default gen_random_uuid(),
  name text not null,
  visibility text not null default 'owner' check (visibility in ('owner','team','public')),
  raw text,                                 -- oryginał do wglądu
  created_at timestamptz not null default now()
);
-- fakty z dokumentu: kb_facts.source='import', source_ref={kind:'document',id}

create table kb_questions (                -- log pytań: audyt + luki wiedzy
  id uuid primary key default gen_random_uuid(),
  asked_by text,                            -- rola/użytkownik/narzędzie
  question text not null,
  answered boolean not null,                -- false = luka wiedzy do uzupełnienia
  answer text,
  used_fact_ids uuid[],
  created_at timestamptz not null default now()
);
```

## 5. API modułu (`apps/shared/server/knowledge.js`)

```js
ask(db, { question, role, context? })   // → { answer, facts:[{id,title}], confident }
  // role: 'owner' | 'team' — filtruje retrieval; brak faktów → answer
  // "nie mam takich informacji" + wpis do kb_questions(answered=false)
search(db, { query, role, k })          // → fakty (retrieval bez generacji)
retrieveForPrompt(db, { query, role, k }) // → fakty jako blok tekstu do promptów
                                          //   innych narzędzi (suggest.js, CRM)
proposeFact(db, {...})                  // → status 'proposed' (ekstrakcja/ręczne)
reviewFact(db, id, decision)            // approve/edit/reject (+ zmiana visibility)
importDocument(db, {...})               // dokument → LLM tnie na fakty 'proposed'
```

Endpointy HTTP w panelu wiedzy; inne appki używają modułu **bezpośrednio
w procesie** (jak LeadKarta), przekazując rolę zalogowanego użytkownika z auth.
Narzędzia bez użytkownika (np. autoresponder odpowiadający klientowi) działają
z rolą `team` — nigdy `owner`.

## 6. Pętle uczenia (skąd wpada wiedza)

1. **Ręcznie** — panel: „dodaj fakt" (najszybsza droga na start).
2. **Import** — cennik, opisy produktów, istniejące dokumenty; skrypt
   `scripts/import-kb.js` (idempotentny, wzorzec: sync-leady-from-sheet.js).
3. **Ekstrakcja z odpowiedzi (serce projektu)** — po każdej WYSŁANEJ odpowiedzi
   (Komunikator: send/manual-sent; docelowo CRM i maile Lorenza) task
   `extract` pyta: „czy ta wymiana zawiera fakt o biznesie/produkcie/procesie,
   którego nie ma w bazie?" → podobieństwo embeddingowe do istniejących faktów
   → nowy fakt `proposed` ALBO propozycja aktualizacji istniejącego. Przykład
   Antoniego: klient pyta o coś technicznego po rozmowie, Lorenzo/Antoni
   odpowiada „to się robi tak" → system to wyłapuje.
4. **Transkrypcje rozmów** (gdy telefonia wejdzie wg planu Komunikatora,
   Etap 3) — ta sama ekstrakcja na podsumowaniu rozmowy.
5. **Korekty sugestii** — `kom_examples` zostaje (styl pisania), ale korekta
   MERYTORYCZNA (Antoni zmienił cenę/parametr w sugestii) → dodatkowo
   propozycja faktu/aktualizacji.
6. **Luki wiedzy** — `kb_questions(answered=false)` = lista „system nie
   wiedział" w panelu; Antoni uzupełnia jednym kliknięciem (pytanie →
   formularz nowego faktu).

Ekstrakcja chodzi w istniejącym workerze pg_cron (`komunikator_worker`) —
żadnej nowej infrastruktury.

## 7. Konsumenci (kolejność podpinania)

1. **Komunikator/suggest.js** — do promptu sugestii dochodzi
   `retrieveForPrompt(pytanie klienta, role:'team')`: sugestie przestają
   zmyślać ceny/parametry, bo mają fakty. (Uwaga: sugestie widzi też Lorenzo →
   rola `team`, nawet gdy panel otwiera Antoni — sugestia idzie do klienta.)
2. **Panel Wiedza** (lumlum.dev/wiedza, `apps/wiedza/` wg wzorca monorepo) —
   Q&A (odpowiedź + cytowane fakty), przegląd/edycja faktów, kolejka review,
   luki wiedzy. Dostęp: panel widoczny dla Antoniego; jeśli Lorenzo dostanie
   dostęp, widzi tylko fakty `team`/`public` (filtr z auth, istniejący wzorzec
   Pozwoleń).
3. **CRM — odpowiedzi AI dla Lorenza w leadach** (wymóg Antoniego: „to też
   wprowadzimy") — generacja odpowiedzi na wiadomości leadów zasilana
   `retrieveForPrompt(role:'team')`.
4. **Przyszłe:** autoresponder intencji (Faza 2 Komunikatora), push z kartą
   przed odebraniem telefonu, „Podsumowanie dnia" w Backlogu.

## 8. Fazy realizacji

- **Etap 0 (½ dnia):** migracje `kb_*`, moduł knowledge.js z ask/search
  (retrieval + generacja, filtr ról), test jednostkowy filtra widoczności
  (owner-fakt NIE wycieka do team — test obowiązkowy przed jakimkolwiek UI).
- **Etap 1 (1 dzień):** panel Wiedza: Q&A + ręczne dodawanie + lista faktów.
  Antoni wrzuca pierwsze ~20–50 faktów (cennik, produkty, FAQ). Panel od razu
  używalny jako „zapytaj o biznes".
- **Etap 2 (1 dzień):** integracja z suggest.js (Komunikator) + `ask` z ról
  — pierwszy realny konsument.
- **Etap 3 (1–2 dni):** ekstrakcja z wysłanych odpowiedzi + kolejka review +
  luki wiedzy. Od tego momentu system uczy się sam.
- **Etap 4 (1 dzień):** import dokumentów + odpowiedzi AI w CRM dla Lorenza.
- **Etap 5 (później):** auto-zatwierdzanie wysokopewnych faktów, metryki
  (ile faktów, % pytań z odpowiedzią, % sugestii z użyciem faktów),
  transkrypcje telefoniczne.

## 9. Zadania Antoniego / pytania otwarte

- [ ] Dostarczyć wiedzę startową: cennik, opisy produktów, typowe pytania
  klientów + odpowiedzi (dowolna forma — wklejka, arkusz, PDF).
- [ ] Zdecydować, czy Lorenzo dostaje dostęp do panelu Wiedza (rekomendacja:
  tak, z widocznością `team` — sam sprawdzi „jak to robimy" zamiast pytać).
- [ ] Pierwsze tygodnie: przeglądać kolejkę `proposed` (jak scalenia
  w Komunikatorze) — to jest trening systemu.
- [ ] Potwierdzić granicę `owner` vs `team`: co dokładnie jest krytyczne?
  (marże, zyski, koszty zakupu, warunki dostawców — co jeszcze?)

## 10. Metryka sukcesu (za ~2 miesiące, wprost z briefu)

System „ma wszystkie możliwe informacje o biznesie": >90% pytań Antoniego
z sensowną odpowiedzią, luki wiedzy bliskie zeru, sugestie w Komunikatorze
i CRM nie wymagają poprawek merytorycznych (tylko ew. stylistyczne), a pytanie
Lorenza o marże kończy się spokojnym „nie mam takich informacji".
