# Cutover wycen — NOC 2 (2026-07-12/13) — checklista

Stan po nocy 1: CAŁY system zbudowany, przetestowany i wdrożony na lumlum.dev.
Produkcyjny formularz na lumlum.co dalej wskazuje huki Make — poniższe kroki
przepinają klientów na nowy system. Każdy krok ma rollback.

## Przed startem (dzień, z Antonim)

- [ ] Wspólne testy wizualne + funkcjonalne (CRM zakładka Wyceny, panel
      Sprzedaże, szybkie dodanie, edytor, formularz testowy
      https://lumlum.dev/formularz/test?id=...&t=...).
- [ ] Test pełnej ścieżki PRZELEW: opłać testową proformę #1875 linkiem
      szybkiej płatności (1 zł? — kwota to 100 zł; można w inFakt ręcznie
      oznaczyć "opłacona", webhook przetestujemy przy przepięciu) — po
      opłaceniu: przesyłka + faktura VAT + KSeF + delete proformy + mail.
      ⚠️ To zużyje 3. (ostatnią uzgodnioną) testową przesyłkę InPost i
      utworzy PRAWDZIWĄ fakturę VAT — zrobić świadomie.
- [ ] Skasować testowe wyceny #1875, #1876 (panel/SQL) + testowe proformy
      w inFakt (`398d3bbb-...` i `99b47e34-...`) + anulować testowe
      przesyłki w Menedżerze Paczek (2848368028 paczkomat, 2848370502 kurier),
      jeśli nie mają być nadane.
- [ ] Token Shopify: Settings → Apps → Develop apps → Create app →
      Admin API scope `read_orders`, `read_products` → Install → token
      `shpat_...` → dodać w Vercel jako `SHOPIFY_ADMIN_TOKEN` (worker sam
      zacznie synchronizować zamówienia sklepu).

## NOC 2 — kolejność

1. **Świeży import z Sheets** (gdyby doszły nowe wyceny przez Telegram):
   - wyeksportować CRM_CASES, Wyceny B2C (Lorenzo), SKU do CSV,
   - `node scripts/wyceny-import.js <CRM_CASES.csv> <WycenyB2C.csv> <SKU.csv>`
   - skrypt jest re-runnable (upsert po id, nie nadpisuje form_tokenów,
     nie dotyka wycen spoza arkusza).

2. **Shopify: podmiana sekcji formularza** (Antoni, ~3 minuty):
   - Online Store → Themes → aktywny theme → Edit code →
     `sections/formularz.liquid`,
   - zastąpić CAŁĄ zawartość plikiem z repo:
     `apps/formularz/liquid/formularz.liquid`
     (to identyczna sekcja + 3 zmiany: URL-e GET/POST na lumlum.dev,
     token `t` z linku, ekran "Zamówienie zostało już złożone"),
   - Save.
   - **Rollback**: przywrócić stare URL-e
     GET `https://hook.eu1.make.com/ys6kt2vajdpc1f1e2mm8fgnctovhqrms`,
     POST `https://hook.eu1.make.com/o6c03cmquavhoc19zbt1uu9bnucpmhp8`
     (albo cofnąć wersję pliku w edytorze theme — Shopify trzyma historię).

3. **inFakt: przepięcie webhooka** (Ustawienia → Integracje/Webhooki):
   - zdarzenie "faktura opłacona" (invoice_paid) z huka Make na:
     `https://lumlum.dev/formularz/api/infakt-webhook`
   - **Rollback**: przepiąć z powrotem na URL Make.

4. **Make: dezaktywacja scenariuszy** (wyłączyć, NIE kasować — rollback):
   - [ ] #1 Dodanie casów do CRM (Telegram)
   - [ ] #1 B2B Dodanie casów do CRM (Telegram, rabat 24h)
   - [ ] #2 Wysłanie linku do formularza
   - [ ] Formularz na lumlum - Get
   - [ ] Formularz LumLum - post
   - [ ] #2 Shopify draft order, inpost + infakt
   - [ ] #3 Wywołanie auto PAID
   - [ ] #4 Sprawdzenie dostawy
   - [ ] #5 Fulfillment
   - [ ] Przesyłka nadana

5. **Test kontrolny na żywo**:
   - nowa wycena w panelu (szybkie dodanie) → skopiować link → otworzyć
     `lumlum.co/pages/formularz?id=...&t=...` → wypełnić (przelew) →
     sprawdzić: proforma w inFakt, mail z linkiem płatności, karta wyceny
     pokazuje PROFORMA_SENT,
   - wejść w ten sam link drugi raz → ekran "Zamówienie zostało już złożone".

6. **Obserwacja** (1-2 tygodnie):
   - błędy pipeline widać na kartach wycen (stage ERROR + zdarzenia)
     i w `wyceny_events`,
   - worker działa co 20 min 6-22 (pg_cron `wyceny_worker`; ręcznie:
     `curl -s "https://lumlum.dev/formularz/api/cron/worker?secret=<CRON_SECRET>"`).

## Po stabilizacji

- [ ] Arkusze Google → read-only (archiwum), skasowanie scenariuszy Make.
- [ ] **ROTACJA SEKRETÓW**: klucz API inFakt + token ShipX InPost (stare były
      jawnie w blueprintach na dysku i w Make!) → podmienić w Vercel env
      (INFAKT_API_KEY, INPOST_SHIPX_TOKEN) i lokalnych .env.
- [ ] Wypowiedzenie Baselinkera.
- [ ] Po ~30 dniach: token w linku formularza obowiązkowy (dziś stare linki
      bez tokenu przechodzą) — jedna linijka w `apps/formularz/server/server.js`
      (funkcja `tokenOk`).
- [ ] Furgonetka (zagranica): konto API, moduł provider 'furgonetka',
      flat fee 50 zł w formularzu i na fakturze (do tego czasu zagranica =
      faktura bez auto-przesyłki, jak w Make).
- [ ] Etap 6: panel Fulfillment ("do nadania dziś") + etap 7 (COD raporty,
      integracja bankowa inFakt, push).
