# Panel Kampanie - mądra wysyłka SMS/mail do starych wycen

Cel biznesowy: ~100 otwartych wycen starszych niż 2 tygodnie (~230k zł), do których
nikt nie dodzwoni się pojedynczo. Kampania wysyła KAŻDEMU spersonalizowaną wiadomość
(imię w wołaczu, co było wyceniane, za ile) i pyta, czy temat aktualny. Odpowiedzi
domykają wyceny albo planują follow-upy. Workflow jak w Close CRM.

Decyzje Antoniego (2026-07-15):
- Kreator KONWERSACYJNY: swobodny (dyktowany) opis + opcjonalny szablon; AI
  interpretuje (filtr, instrukcje) i pokazuje edytowalne pola + populację.
- ZERO generycznych wiadomości - każda musi zawierać konkret z wyceny
  (walidator odrzuca treść bez produktu/kwoty).
- Próbka 5-10 do przeglądu → poprawki UCZĄ generator (pary przed/po + reguły
  w kampanie.korekty, few-shot w prompcie) → „Przegeneruj" do skutku →
  akceptacja → reszta generuje się i wysyła AUTOMATYCZNIE.
- Paczki dzienne (limit per kampania, default 25) w godz. 9-17 Warsaw.
- Jednoznaczne „nieaktualne" w odpowiedzi → AUTO-zamknięcie wyceny (Stracone);
  niejasne → propozycja dla człowieka (sekcja Do decyzji) + push.
- Dostęp: Antoni + Lorenzo (panelKey 'kampanie', bez adminOnly).
- Nadawca SMS: numer Lorenzo (resolveSmsCaller z kontakt-send), wybieralny.
- (v2, 2026-07-15) RĘCZNI ODBIORCY: tryb „wybrani ręcznie" w kreatorze +
  sekcja „Dodaj odbiorcę" w kampanii (też aktywnej) - wyszukiwarka po numerze
  /imieniu (wyceny + Leady B2C, GET /api/kampanie/szukaj), goły numer spoza
  bazy też można dodać (test do siebie); zbudujRecznegoOdbiorce dociąga
  otwarte wyceny telefonu i leada, więc kontekst personalizacji jest pełny.
- (v2) SEKWENCJA: kampanie.sekwencja={po_dniach,brief} (AI wyciąga ją też
  z opisu w interpretacji) - po N dniach bez odpowiedzi worker wysyła
  follow-up (AI: krótsze przypomnienie nawiązujące do poprzedniej wiadomości,
  z furtką „jeśli nieaktualne, krótkie nie"); odpowiedź SMS (kom in),
  kontakt na leadzie (Ostatni kontakt), zamknięta wycena albo optout
  WYPISUJE odbiorcę (sekwencja_stop z powodem); follow-upy liczą się do
  wspólnego limitu dziennego; kampania done wciąż domyka sekwencję; v1
  sekwencji = jeden krok, tylko SMS.

## Architektura

- apps/kampanie (port 3012, wzorzec fulfillment): server.js (endpointy),
  populacja.js (filtr typ=WYCENA∧status=Open∧wiek>N, dedupe po telefonie,
  imię z leada/wyceny, kwota=cenaFinalna, snapshot kontekstu), ai.js
  (anthropicJson→haiku-4-5, env LLM_KAMPANIE_GEN; prompt generacji z korektami;
  segmenty GSM-7 160/153 vs UCS-2 70/67 - KAŻDY polski diakrytyk przełącza na
  UCS-2, stąd toggle bez_polskich_znakow default ON + transliteracja; walidacja:
  em dash, długość, anty-generyczność), worker.js (cron: generacja pending→
  approved paczką 8, wysyłka approved→sent do limitu dziennego z claimem
  atomowym PRZED wysyłką, 3 błędy z rzędu → auto-pauza + push, push
  podsumowania paczki, done gdy pusto).
- Wysyłka przez apps/shared/server/kontakt-send.js (Etap 0: sendSmsAndLog/
  sendMailAndLog wyjęte z kontakt-endpoints; ta sama ścieżka co karta leada:
  kom_messages kanał sms + [SMS→] w Historii rozmów leada) + dopis do
  wyceny.history_log WSZYSTKICH wycen odbiorcy (ślad dla wycen bez leada).
- Tabele (apps/kampanie/migrations/001_init.sql, NA PRODZIE): kampanie
  (brief/szablon/interpretacja/korekty jsonb, limit_dzienny, godziny, status
  draft→sampling→review→active⇄paused→done→archived), kampanie_odbiorcy
  (wycena_id + wyceny_ids[], kontekst-SNAPSHOT, tresc, sample, status pending→
  approved→sent→replied→closed, unique(kampania_id,telefon)), kampanie_optout
  (globalny, telefon PK).
- pg_cron `kampanie_worker` */15 min całą dobę → POST lumlum.dev/kampanie/api/
  cron/kampanie?secret=CRON_SECRET; bramka godzin wysyłki W KODZIE (Warsaw, DST).

## Etapy

- [x] Etap 0: refactor kontakt-send.js (commit 724ebd9)
- [x] Etap 1: panel + wysyłka end-to-end (kreator konwersacyjny, próbka,
      uczenie z korekt, worker, limit dzienny, optout). Testy: e2e na żywej
      bazie 44 asercje + realny SMS (Zadarma OK, kom_messages, history_log
      obu wycen odbiorcy, limit dzienny) + mock DOM 19 asercji.
- [x] v2 (2026-07-15): ręczni odbiorcy (wyszukiwarka + goły numer) + sekwencja
      follow-upów (migracja 002, wspólny limit dzienny, wypisywanie po
      odpowiedzi/kontakcie). Testy: e2e 36 asercji (realny follow-up SMS,
      symulacja odpowiedzi przez kom in) + mock DOM 29.
- [ ] Etap 2: ODBIÓR odpowiedzi SMS - ⚠ webhooki Zadarmy: sprawdzić, czy
      kategoria 'sms' (POST /v1/pbx/webhooks/url/) współdzieli URL z webhookiem
      rozmów (backlog-b2c/api/webhooks/zadarma) - NIE nadpisywać w ciemno!
      Logger-first: surowy payload → kampanie_sms_inbox (migracja 003), parser
      dopiero po obejrzeniu realnego SMS-a przychodzącego (numer 48459567870 ma
      receive_sms:true). Potem: kom_messages in → dopasowanie odbiorcy po
      telefonie (90 dni od wysyłki) → regex STOP → triage AI (nieaktualna
      ≥0.85 → auto-Stracone wszystkich wyceny_ids + resolveWatch + push;
      termin → follow-up; reszta → Do decyzji + push). Sekwencja już dziś
      sprawdza kom in - odbiór zacznie ją zasilać bez zmian w kodzie.
- [ ] Etap 3: follow-upy scheduled (kampanie_followupy: auto-SMS dzień przed
      terminem + task na plan dnia w dniu terminu przez wyekstrahowany
      plan-dnia-task.js z POST /api/doradca/akcja).

## Pułapki / notatki

- wyceny.history_log to TEXT (linie \n, append na końcu jak wyceny-endpoints).
- wyceny.telefon_digits bywa z/bez prefiksu 48 - telefonKlucz() normalizuje
  do 9 cyfr; kom_* używa 48XXXXXXXXX (identity.normalize).
- Zadarma caller_id BEZ plusa; API echo-uje sukces nawet przy podmianie
  nadawcy - patrz saga w pamięci kontakt-karta-leada.
- Populacja wyklucza telefony z odbiorcą w innej niezakończonej kampanii
  oraz kampanie_optout; przed samą wysyłką re-check: optout + wycena Open.
- Vercel: funkcja api/kampanie.js maxDuration 180; cron NIE w vercel.json
  (Hobby = max 1/dzień) tylko pg_cron.
- Stawka szacunku kosztu: env ZADARMA_SMS_STAWKA (default 0.09 zł/segment).
