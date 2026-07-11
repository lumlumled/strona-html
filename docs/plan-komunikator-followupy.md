# Komunikator 2.0: jeden klient zamiast wątków + follow-upy, które nie uciekają

Data: 2026-07-11. Stan: PLAN (brief do wdrożenia etapami).

## Po co

Panel wiadomości ma przestać być "czytnikiem skrzynek", a stać się systemem
prowadzenia klienta:

1. **Jeden klient, wiele kanałów.** Klient pisze na FB, potem wysyła maila -
   to ta sama osoba i ma być jedna rozmowa. Odpowiedź idzie kanałem,
   z którego przyszła ostatnia wiadomość.
2. **Nic nie ucieka.** Z rozmowy wynika, co dalej: "odezwę się za 2 tygodnie",
   "klient miał pomierzyć i napisać", "wyślę wycenę jutro". System ma te
   zobowiązania wyłapywać (AI + ręcznie), przypominać o nich i domykać je,
   gdy klient się odezwie.
3. **Wiadomość na przyszłość.** Skoro wiem dziś, co napiszę za tydzień
   ("udało się pomierzyć?"), piszę ją od razu - system poda mi ją w dniu
   wysyłki gotową do kliknięcia (na razie ręcznie, auto-wysyłka później).

## Co już jest (audyt 2026-07-11)

| Element | Stan |
|---|---|
| `kom_customers` + `kom_customer_identities` + łańcuch `merged_into` | działa (identity.js, testy) |
| `kom_merge_proposals` + baner "Scalenie?" + confirm/reject w panelu | działa |
| Wzbogacanie tożsamości z TREŚCI wiadomości (email podany w DM na FB) | **BRAK** - jedyny enrich to numer telefonu z webhooka WhatsApp (pole payloadu, nie treść). Dlatego test "FB z adresem e-mail + mail z tego adresu" NIE scala. |
| `kom_commitments` (obietnice, owner my/klient, due_at) | tabela istnieje od 001_init.sql, **zero kodu** - nic nie pisze, nic nie czyta |
| `kom_outbox` (kolejka wysyłki z `send_after`) | tabela istnieje, **zero kodu** |
| Lista w panelu | per WĄTEK (kanał), nie per klient; detal wątku zwraca już `customer.threads` (fundament pod grupowanie) |

## Etap 1 - Scalanie po treści wiadomości (naprawia test FB+e-mail)

Ekstrakcja twardych identyfikatorów z treści każdej przychodzącej wiadomości.
**Regex, nie LLM** - e-mail i telefon w treści to literalne wzorce, LLM zbędny
(tanio, deterministycznie, bez budżetu czasowego webhooka):

- e-mail: standardowy wzorzec, `normalize('email', …)` (lowercase);
- telefon PL: ciągi 9 cyfr / +48…, `normalize('phone', …)` (48 + 9 cyfr).

Przepływ (w webhooku po insercie wiadomości, a dla zaległości w sweep cron):

```
treść in-wiadomości → regex → dla każdego znaleziska:
  identity.enrichCustomer(customer, {type, value, source:'ai_extracted'})
    'added'      → tożsamość dopięta; następny mail z tego adresu
                   resolveCustomer() trafi w TEGO klienta = zero nowych bytów
    'conflict'   → identity.proposeMerge() → baner "Scalenie?" (UI już jest)
    'already_own'→ nic
```

Kluczowy efekt kolejnościowy: FB-wiadomość z e-mailem PRZED mailem → enrich
dopina e-mail do klienta FB → późniejszy mail dołącza do niego automatycznie
(bez propozycji). Mail PRZED wiadomością FB → enrich zgłasza konflikt →
propozycja scalenia do potwierdzenia. Oba scenariusze kończą się jednym klientem.

Dodatkowo: skrypt retro `scripts/extract-identities.js` - przejście po
istniejących `kom_messages` (direction='in') i to samo, żeby scalić historię.

v2 (później): miękkie wzmianki ("pisałem do was na Facebooku") przez LLM przy
okazji ekstrakcji obietnic z Etapu 3 - zawsze jako propozycja, nigdy auto.

## Etap 2 - Panel per KLIENT, odpowiedź ostatnim kanałem

Jednostką listy przestaje być wątek, staje się klient:

- **Lista**: grupowanie po `customer_id` - jedna karta = klient; ikony kanałów,
  ostatnia wiadomość niezależnie od kanału, sort po najnowszej. Triage/status
  karty = z wątku ostatniej przychodzącej.
- **Rozmowa**: scalona oś czasu ze WSZYSTKICH wątków klienta (ikona kanału przy
  bąbelku). API detalu już zwraca `customer.threads` - trzeba dociągnąć
  wiadomości wszystkich wątków i posortować po `created_at`.
- **Composer**: domyślny kanał = wątek ostatniej PRZYCHODZĄCEJ wiadomości
  ("odpisz tam, gdzie klient jest teraz"); obok przełącznik kanału (np. klient
  pisał na FB, ale wolę odpisać mailem). `computeSendState` liczony per wybrany
  wątek (okno 7 dni Messengera, mailbox Gmaila itd. bez zmian).
- Scalenie klientów (Etap 1) automatycznie skleja rozmowę w jedną kartę -
  to jest właściwa nagroda za merge.

Uwaga wdrożeniowa: to zmiana `/api/threads` (grupowanie) + widoku listy
i otwartej rozmowy w `app.html`. Endpointy wysyłki zostają per wątek.

## Etap 3 - Obietnice i follow-upy (`kom_commitments` ożywa)

### Skąd się biorą

1. **AI po każdej wiadomości inboxowej** (in ORAZ out - "wyślę wycenę jutro"
   to nasza wiadomość): nowy task LLM `commitments` w pętli po triage
   (webhook poza budżetem → sweep cron dokańcza, wzór jak triage).
   Zwraca listę: `{description, owner: 'my'|'klient', due_at}`.
   - daty względne ("za dwa tygodnie") liczone od `created_at` wiadomości;
   - obietnica klienta bez terminu ("zmierzę i napiszę") → domyślnie +4 dni;
   - dedupe: nie twórz, jeśli w wątku jest otwarta obietnica o zbliżonym opisie.
2. **Ręcznie z rozmowy**: przycisk "+ przypomnienie" (opis + data, skróty:
   jutro / 3 dni / tydzień / 2 tygodnie), `created_by='manual'`.

Model zaufania: AI tworzy obietnicę OD RAZU jako `open` (bez kolejki
zatwierdzania - zgubiony follow-up kosztuje więcej niż nadmiarowy, a usunięcie
to jeden klik "anuluj" w wątku). Bezpiecznik jak przy triage: chipy obietnic
widoczne w rozmowie zaraz po utworzeniu.

### Gdzie je widać

- **W rozmowie**: sekcja "Do zrobienia" nad composerem - otwarte obietnice
  klienta (chip: opis + termin + done/anuluj/edytuj datę).
- **Zakładka "Follow-upy"** w komunikatorze: wszystkie otwarte, sekcje
  Zaległe / Dziś / Nadchodzące; owner='klient' opisane jako "miał napisać do…".
- **Hub "Do zrobienia dziś"**: sekcja z obietnicami na dziś + zaległymi
  (ten sam ekran startowy, który już mamy).
- **Push** (po wdrożeniu plan-powiadomienia-push): trigger na
  `kom_commitments` due dziś / przeterminowane - rano jedna zbiorcza sztuka.

### Jak się domykają

- Ręcznie: klik "zrobione" / "anuluj".
- **Auto (owner='klient')**: przychodzi wiadomość od klienta → wszystkie jego
  otwarte obietnice `owner='klient'` → `done` z adnotacją w meta ("domknięte
  wiadomością X"). Sens: przypomnienie "miał napisać" jest po to, żeby wyłapać
  CISZĘ - gdy klient się odezwał, przypomnienie znika, a rozmowa i tak wraca
  na górę inboxa. (LLM-owa ocena "czy odpowiedź faktycznie realizuje
  obietnicę" - v2, nie blokuje wdrożenia.)
- Obietnica `owner='my'` NIE domyka się sama - domyka ją moja wysłana
  wiadomość w wątku (pytanie przy wysyłce: "domknąć follow-up?" gdy jest
  otwarty) albo ręczny klik.

## Etap 4 - Wiadomość napisana dziś, wysłana w przyszłości

- `alter table kom_commitments add column draft_text text;` - obietnica
  `owner='my'` może mieć od razu gotową treść ("udało się pomierzyć?").
- W dniu `due_at` follow-up pojawia się w "Do zrobienia" z draftem; klik
  otwiera rozmowę z composerem wypełnionym draftem, kanał = ostatni aktywny
  → wyślij → obietnica `done`. **Ręcznie na start** (decyzja Antoniego).
- v2: toggle "wyślij automatycznie" → wpis w `kom_outbox` (`send_after` =
  due_at) + dispatcher w pg_cron (tabela i indeks od dawna czekają); okno
  "cofnij" przed wysyłką zgodnie z pierwotnym planem komunikatora.

## Kolejność wdrożenia i zależności

1. **Etap 1** (regex-enrich + retro-skrypt) - mały, samodzielny, od razu
   naprawia przetestowany scenariusz FB+e-mail.
2. **Etap 3** (obietnice + zakładka Follow-upy) - największa wartość
   ("wiadomości nie uciekają"), niezależny od Etapu 2.
3. **Etap 2** (widok per klient) - największa zmiana UI; robić po 1,
   bo scalanie musi działać, żeby grupowanie miało sens.
4. **Etap 4** (draft + wysyłka w przyszłości) - nakładka na 3.

Crony: ekstrakcja identyfikatorów i obietnic dokleja się do istniejącego
sweep (pg_cron w Supabase - NIE vercel.json, Hobby ogranicza do 1/dzień,
a częstszy cron w vercel.json = cichy brak deployu z pusha).

## Poza zakresem (świadomie)

- Automatyczna wysyłka bez potwierdzenia (v2 Etapu 4).
- LLM-owa ocena, czy odpowiedź klienta realizuje obietnicę (v1: każda
  wiadomość domyka).
- Scalanie po imieniu/nazwisku lub podobieństwie treści - NIGDY auto,
  najwyżej propozycja (zasada z identity.js zostaje).
- Powiązanie kom_customers ↔ CRM lead (`crm_lead_id`) - osobny temat.
