# Kontakt na karcie leada: jedna historia (telefon + mail + SMS) + ręczna transkrypcja rozmowy

Data: 2026-07-14. Stan: PLAN (brief do wdrożenia etapami).

## Po co

Karta leada (wspólna - Backlog, CRM, wszędzie) dostaje panel **Kontakt**:

1. **Cała historia kontaktu w jednym miejscu.** Dziś "Historia rozmów" pokazuje
   tylko telefony i notatki. Ma pokazywać też maile i SMS-y (a docelowo DM-y),
   chronologicznie, z ikoną kanału - jak oś czasu klienta.
2. **Odpowiedź z karty.** Composer pod osią czasu: domyślny kanał = ostatni
   kanał PISANY (telefon nie jest kanałem odpowiedzi - decyzja z planu
   follow-upów), obok przełącznik Mail / SMS.
3. **Ręcznie nagrana rozmowa przechodzi przez pipeline Zadarmy.** Antoni odbiera
   na komórce (poza Zadarmą) → nagrywa/transkrybuje (panel albo WisprFlow) →
   wkleja/wysyła → system robi DOKŁADNIE to co przy rozmowie z Zadarmy:
   analiza AI, status (lejek monotoniczny), wpis w Historii rozmów, Ocena AI,
   najbliższa akcja, wpis w Log zmian, sync planu dnia.
4. **Multi-user od pierwszego dnia.** Logowanie już jest (app_users, wspólne
   cookie). Mail: każdy wysyła ze SWOJEJ skrzynki lumlum.co (kom_mailboxes).
   SMS: na start jedno konto Zadarmy (firmowe/Lorenzo), w przyszłości nadawca
   per user.

## Co już jest (audyt 2026-07-14)

| Element | Stan |
|---|---|
| Wspólna karta leada `apps/shared/lead-card.js` | jest; sekcje składane w `buildBody` (l. 1131-1143), wzorzec lazy-collapsible `buildNestedDetails` (l. 753) |
| "Historia rozmów" | kolumna text na `Leady B2C`, linia = `DD.MM.YYYY HH:mm - treść`, newest-first; render `parseHistoriaRozmow` (lead-card.js:496); fallback `GET /api/leady/:telefon/historia` z Log zmian |
| Pipeline analizy rozmów | webhook `POST /api/webhooks/zadarma` (backlog server.js:952): transkrypcja (`gpt-4o-mini-transcribe`) → `analyzeCall` (`gpt-5-mini`, server.js:754) → lejek statusów monotoniczny (server.js:791) → RPC `app_update_leady_after_call` (bypass triggera Log zmian) → `updateStatusInUmowa` (plan dnia, tylko status, commit f580f96) |
| Transkrypcja audio przez HTTP | **JUŻ JEST**: `POST /api/transcribe` (backlog server.js:444), raw audio → `{text}`, audio nieprzechowywane |
| Wzorzec "tekst z zewnątrz → analiza → lead" | `POST /api/leady/notatka` (shared leady-endpoints.js:359) - najbliższy analog dla ręcznej transkrypcji (ale używa lżejszego `analyzeNotatka`, nie pełnego `analyzeCall`) |
| Komunikator: model wielokanałowy | `kom_customers` → `kom_threads` (channel: messenger/instagram/whatsapp/phone/email/note/tiktok) → `kom_messages`; **brak kanału `sms`** (check constraint) |
| Most kom ↔ CRM | `kom_customers.crm_lead_id` istnieje od 001_init.sql, **zero kodu** - "jedyny przyszły most do CRM" wg komentarza migracji. Ten plan go ożywia |
| Wysyłka mail per user | działa: `gmail.sendReply` (Re:/In-Reply-To/threadId), skrzynka wątku z `meta.gmail.mailbox`, mapowanie skrzynka→user w `kom_mailboxes.app_user_id`, OAuth `/api/gmail/auth` (Workspace internal = tylko lumlum.co) |
| SMS | **BRAK w całym repo**. Zadarma ma API `/v1/sms/send/`; podpis requestów już zaimplementowany w `apps/backlog-b2c/server/zadarma.js` (`callZadarma`) |
| Dopasowanie klient↔lead bez FK | wzorzec read-time: `GET /api/wyceny/dla-leada?telefon=&email=` (match po telefon_digits/email); tak samo komunikator pokazuje wyceny w wątku |
| Push do ownera | `notifyUser(getClient, userId, ...)` w `apps/shared/server/push.js` |
| Normalizacja telefonu | komunikator: `48XXXXXXXXX` (identity.js:15); wyceny: digits BEZ 48; karta: `_telefon_digits` Z 48 - przy matchowaniu pamiętać o obu konwencjach |

Pokrewny plan: `docs/plan-komunikator-followupy.md` - Etap 2 (panel per klient,
odpowiedź ostatnim kanałem) to ta sama logika, tylko zakotwiczona w
komunikatorze. Wspólne kawałki (merged timeline, wybór kanału) budować tak,
żeby posłużyły obu widokom. Ostatnia linia tamtego planu ("powiązanie
kom_customers ↔ CRM lead - osobny temat") = TEN plan.

## Decyzje projektowe

### D1. Kanoniczne źródła danych - bez nowej tabeli wiadomości

- **Telefony/notatki**: zostają w `Log zmian` + kolumnach leada (nic nie ruszamy).
- **Mail/SMS/DM**: zostają w `kom_messages` (SMS = nowy kanał).
- **Oś czasu Kontakt = merge na read-time** w nowym endpoincie: wpisy z
  `Log zmian` (telefony: zadarma_webhook/zadarma_poll/rozmowa_reczna, notatki)
  + `kom_messages` wszystkich wątków dopasowanego `kom_customers`,
  sortowane po dacie. Wzorzec = wyceny/dla-leada (sprawdzony).

### D2. Ożywiamy `kom_customers.crm_lead_id`

Przy pierwszym dopasowaniu (telefon leada ↔ `kom_customer_identities`, obie
normalizacje) zapisujemy `crm_lead_id = "ID Leada"` - trwały link, szybszy
odczyt, odwrotne lookupy (komunikator → karta leada). Fallback read-time
zostaje (gdy brak linku). Gdy lead nie ma klienta kom, a wysyłamy mail/SMS
z karty → `resolveCustomer` + `attachThread` (identity.js jest czyste,
dependency-injected - importujemy, nie kopiujemy).

### D3. Ręczna rozmowa = pełny pipeline Zadarmy, nie notatka

Nowy endpoint `POST /api/leady/rozmowa-reczna` `{telefon, tresc, kierunek?}`:
`analyzeCall(transcript)` → lejek statusów → insert `Log zmian`
(`zrodlo: 'rozmowa_reczna'`, `transkrypcja`, `handlowiec` = user z sesji)
→ RPC `app_update_leady_after_call` → `updateStatusInUmowa`. Czyli krok 4-10
webhooka bez parsowania payloadu Zadarmy.

Refactor wymagany: `analyzeCall` + prompt + lejek statusów + wspólna funkcja
`processCallTranscript()` wyjęte z backlog `server.js` do
`apps/shared/server/call-analysis.js`; webhook Zadarmy i nowy endpoint używają
tego samego kodu (jedna prawda, zero dryfu promptów).

Wejście = **zawsze TEKST** (decyzja Antoniego 2026-07-14):
- transkrypcję robi zewnętrzna automatyzacja (WisprFlow / Make) - do panelu
  trafia gotowy tekst przez wklejkę (textarea w panelu Kontakt);
- webhook Zadarmy też dostaje transkrypcję z Make'a w payloadzie (Antoni
  potwierdzi konfigurację w Make'u) - fallback transkrypcji z record_url
  zostaje w kodzie, ale nie jest ścieżką główną;
- ŻADNEGO nagrywania audio w panelu ani uploadu plików - temat limitu body
  Vercela znika. `POST /api/transcribe` zostaje nieużywany przez ten feature.
- Lead znany z kontekstu karty (panel jest NA karcie) - zero zgadywania.
  Globalny przycisk "dodaj rozmowę bez leada" + auto-match przez AI = v2.

Duplikaty: NIE MA ryzyka (wyjaśnione 2026-07-14) - Zadarma jest podpięta do
telefonu Antoniego wyłącznie jako przekierowanie połączeń PRZYCHODZĄCYCH,
więc te rozmowy obsługuje webhook automatycznie; ręczna wklejka służy
pozostałym rozmowom (bez udziału Zadarmy). Dwie ścieżki są rozłączne.

⚠️ Liczniki: `rozmowa_reczna` to prawdziwy telefon → RPC podbija
`Ilość telefonów` (OK), ale sprawdzić `NIE_TELEFON_ZRODLA` w statystykach
(queries.js) i liczniki `_ilosc_polaczen` - nowe źródło ma się liczyć jak
telefon (odwrotnie niż przy notatka_handlowca - por. pamięć "liczniki
telefonów muszą pomijać nowe zrodła").

### D4. SMS = nowy kanał w komunikatorze, wysyłka przez Zadarmę

- Migracja: `kom_threads.channel` check + `'sms'`; wątek per klient
  (`external_thread_id` = numer 48XXXXXXXXX).
- Wysyłka: `POST /v1/sms/send/` (number, message, caller_id) podpisane przez
  `callZadarma` - klient wyjęty do `apps/shared/server/zadarma-client.js`
  (albo require z backlogu). Wynik → insert `kom_messages`
  (direction out, channel sms).
- Odbiór: sprawdzić w panelu Zadarmy, czy numer firmowy przyjmuje SMS-y
  przychodzące i czy webhook ma event SMS (NOTIFY_*). Jeśli tak → handler w
  istniejącym webhooku Zadarmy → `resolveCustomer(phone)` → kom_messages in
  → push do ownera leada. Jeśli nie → v1 jest send-only i JAWNIE to piszemy
  w UI ("odpowiedzi SMS nie wpadają tutaj").
- Nadawca per user (numer Antoniego) = v2; na start jedno konto (env).

### D5. Composer - ostatni kanał pisany, przełącznik Mail/SMS

- Default = kanał ostatniej wiadomości PISANEJ (in lub out) klienta;
  telefon/notatka nigdy nie jest defaultem (spójnie z planem follow-upów).
- Mail: skrzynka usera z sesji (`kom_mailboxes.app_user_id`); jeśli istnieje
  wątek gmail klienta → reply-in-thread (Re:/In-Reply-To/threadId, jak
  komunikator); jeśli nie → nowy mail (pole Temat się pokazuje). Brak
  podpiętej skrzynki → przycisk "Podepnij Gmail" (`/api/gmail/auth`).
- SMS: licznik znaków (GSM 160 / UTF-16 70, sklejanie), bez tematu.
- DM-y (FB/IG/TikTok) w osi czasu: POKAZUJEMY (read-only, ikona kanału),
  odpowiedź = link "Odpisz w komunikatorze" (okna 24h/7d i tryby wysyłki
  zostają tam, nie dublujemy `computeSendState` w karcie - v1).
- Każda wysyłka z karty: insert `kom_messages` + jednolinijkowy wpis do
  kolumny `Historia rozmów` (`[Mail→] Temat…` / `[SMS→] treść…`) przez RPC
  `app_update_leady_notatka`-podobny (bypass triggera) - dzięki temu mobile
  i wszystkie stare widoki widzą kontakt bez zmian. Wiadomości PRZYCHODZĄCE
  nie dopisują się do kolumny w v1 (spam newsletterowy) - widać je w panelu.

### D6. Miejsce w karcie i pliki

- Sekcja "Historia rozmów" → **"Kontakt"**: jedna rozwijana sekcja
  (`buildNestedDetails`), w środku: oś czasu (merge D1) + composer (D5) +
  przycisk 🎙️/wklejka (D3). Stare renderowanie z kolumny zostaje jako
  szybki fallback zanim endpoint odpowie.
- Front: nowy `apps/shared/kontakt-panel.js` (wzór: wycena-card.js),
  ładowany przez CRM i Backlog obok lead-card.js; lead-card tylko montuje.
- Server: nowy `apps/shared/server/kontakt-endpoints.js`
  (`registerKontaktEndpoints`), montowany w CRM i Backlogu obok
  registerLeadyEndpoints:
  - `GET /api/kontakt/dla-leada?telefon=&email=` - merged timeline
    (+ zapis crm_lead_id przy pierwszym matchu),
  - `POST /api/kontakt/mail` - wysyłka (import gmail.js z komunikatora),
  - `POST /api/kontakt/sms`,
  - `POST /api/leady/rozmowa-reczna` (w leady-endpoints albo tu).
  Wszystko za istniejącym auth (cookie lumlum_session), user z sesji.
- Env: GOOGLE_CLIENT_ID/SECRET, ZADARMA_* są project-wide na Vercelu -
  dostępne dla CRM/Backlogu bez zmian.

### D7. Migracje/constrainty

1. `kom_threads` check channel + `'sms'`.
2. `kom_messages.sent_by` check to dziś `('customer','antoni','ai_auto')` -
   rozszerzyć (dowolny tekst albo dopisać nazwy userów; rekomendacja: drop
   check, kolumna trzyma `app_users.name`).
3. `Log zmian`: nowa wartość `zrodlo='rozmowa_reczna'` (+ `sms_out`/`mail_out`
   NIE - te żyją w kom_messages, patrz D1).
4. Ops: skrzynka lorenzo@lumlum.co (konto Workspace) + `/api/gmail/auth`;
   weryfikacja SMS-in w panelu Zadarmy.

### D8. Szybkie dodawanie rozmowy z dowolnego miejsca + kontakty organic
(dodane 2026-07-14 po decyzji Antoniego)

- **Plus (+) w topbarze** (wzorzec: szybka wycena) → strona
  `/backlog-b2c/rozmowa`: pole telefonu + wklejka transkrypcji + kierunek.
  Ten sam link jako przycisk "🎙 Dodaj rozmowę" w panelu Kontakt na karcie
  leada (prefill telefonu przez `?telefon=`).
- **Dopasowanie po telefonie**: lead → pełny pipeline (jak webhook);
  numer spoza bazy → **NIE tworzymy leada w Leady B2C** (decyzja Antoniego),
  tylko wiersz w nowej tabeli **`kontakty_organic`** (telefon unikalny,
  imię, `zrodlo` domyślnie `'organic'` - można podać inne, status/ocena_ai/
  historia_rozmow/najbliższa akcja lustrzane wobec leada, ta sama analiza).
- **Webhook Zadarmy zna kontakty organic**: numer z kontakty_organic nie
  tworzy już duplikatu leada - rozmowa dopisuje się do kontaktu (jeden
  klient = jedno miejsce). Ślad w Logi automatyzacji
  (dopasowano_kontakt_organic).
- **Log zmian**: `zrodlo='rozmowa_reczna'`, transkrypcja, handlowiec z sesji,
  `czas_trwania_s=null` (nie 0 - nie fałszować średnich), disposition
  'answered'; dopasowano_tabela = Leady B2C albo kontakty_organic.
- Kod: `apps/shared/server/call-analysis.js` (analiza+lejek, jedna prawda
  dla webhooka i ręcznej ścieżki), `apps/backlog-b2c/server/rozmowy.js`
  (endpointy: POST /api/rozmowy/reczna, GET szukaj, GET kontakty-organic),
  `apps/backlog-b2c/rozmowa.html` (strona). Promocja kontaktu organic →
  lead = v2 (świadomie poza zakresem).

## Etapy wdrożenia

1. **Etap 1 - Oś czasu (read-only).** ✅ NA PRODZIE 2026-07-14 (a1ce909).
2. **Etap 2 - Rozmowa ręczna + szybkie dodawanie (D8).** ✅ NA PRODZIE
   2026-07-14 (f1c20ab + b68e8de).
3. **Etap 3 - Mail z karty.** ✅ ZBUDOWANE 2026-07-14: composer w panelu
   Kontakt (zakładki Mail/SMS, domyślnie ostatni kanał pisany),
   `POST /api/kontakt/mail` (skrzynka usera z kom_mailboxes.app_user_id;
   odpowiedź w wątku TYLKO gdy wątek należy do skrzynki piszącego, inaczej
   nowy mail z tematem), gmail.sendNew + mailboxForUser, wpis `[Mail→]`
   do Historii rozmów (RPC), kom_messages/kom_threads jak przy ingest.
   Ops nadal: skrzynka lorenzo@lumlum.co (bez niej Lorenzo widzi
   "podepnij Gmail").
4. **Etap 4 - SMS (wysyłka).** ✅ ZBUDOWANE 2026-07-14: migracja 010 (kanał
   'sms' + zdjęty CHECK sent_by), `POST /api/kontakt/sms` przez Zadarma
   `/v1/sms/send/` (konto firmowe; nadawca per user = v2), licznik znaków
   GSM/UCS-2, wpis `[SMS→]` do Historii. ⚠️ NIE wysłano testowego SMS-a
   (tylko walidacja kredencjałów przez /v1/info/balance) - pierwszy test
   zrobić na WŁASNY numer. Odbiór SMS (webhook) = do sprawdzenia w panelu
   Zadarmy, dalej otwarte.

## Poza zakresem (świadomie)

- Auto-wysyłka i kolejka (kom_outbox) - osobny plan follow-upów.
- Globalne nagrywanie bez wybranego leada + AI-match do leada.
- Nadawca SMS per user (numer Antoniego) - v2.
- Dublowanie composera DM (okna Messengera) w karcie - odsyłamy do komunikatora.
- Przepisywanie starych maili do Historii rozmów (kolumny) - historia żyje
  w panelu.

## Decyzje Antoniego (2026-07-14) + co zostało otwarte

1. ✅ Wpisy `[Mail→]/[SMS→]` w kolumnie Historia rozmów przy wysyłce z karty:
   **TAK, dopisywać**.
2. ✅ Wejście ręcznej rozmowy: **tylko tekst** (transkrypcja zewnętrzna -
   WisprFlow/Make); zero audio w panelu. Webhook Zadarmy też dostaje
   transkrypcję z Make'a (Antoni potwierdzi w Make'u).
3. ✅ Duplikaty: brak - Zadarma na telefonie Antoniego to wyłącznie
   przekierowanie przychodzących; ręczna wklejka = rozmowy poza Zadarmą.
4. OTWARTE: czy oś czasu ma pokazywać też komentarze publiczne FB/IG/TikTok
   klienta, czy tylko DM+mail+SMS+telefony? (rekomendacja: wszystko,
   ikona kanału; do potwierdzenia w praktyce na Etapie 1).
5. OTWARTE: SMS-y przychodzące - czy numer Zadarmy je przyjmuje (sprawdzić
   w panelu Zadarmy przed Etapem 4).
