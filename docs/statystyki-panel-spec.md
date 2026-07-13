# Spec: panel STATYSTYKI (kokpit decyzyjny + feed dla AI-doradcy)

> Status: **SPEC / DESIGN — do budowy, nie teraz.** Ten plik = brief dla przyszłego czatu, który to zbuduje. Zwiad po danych zrobiony (lipiec 2026), każda metryka oznaczona: JEST policzalna z istniejących danych / wymaga Make. Powiązanie: [fable-doradca-lumlum.md](fable-doradca-lumlum.md) (panel = żywy scorecard z sekcji 7 briefu) i [backlog-priorytetyzacja-spec.md](backlog-priorytetyzacja-spec.md).

## Filozofia (dlaczego i po co)

Dwie zasady, inaczej to będzie ładny, martwy dashboard:

1. **Każda metryka musi kończyć się decyzją.** Jeśli nie umiem dopisać „i co z tego zrobisz" — wypada. Zero metryk próżności (np. „która reklama dała najwięcej leadów" bez konwersji na sprzedaż).
2. **Panel ma DWA wyjścia:** (a) front dla Antoniego, (b) czysty `GET /api/stats/snapshot`, który czyta AI-doradca (Fable). Wtedy „co dziś?" ciągnie żywe liczby zamiast zgadywać. To jest właściwy powód budowy — panel jako wspornik decyzyjny dla AI.

**Uwaga strategiczna (czapka doradcy):** wąskie gardło firmy to domykanie sprzedaży, nie brak dashboardu. Ten panel to potencjalna ucieczka w budowanie. Dlatego v1 celowo = tylko dane, które JUŻ mamy (Sprzedaż + Outreach), zero zależności od Make, i ma zmieniać zachowanie w tym tygodniu (uwidocznić close rate i przeciekający pipeline). Marketing dokładamy dopiero, gdy domykasz (Silnik 3).

## DECYZJE (zamrożone przez Antoniego)

1. **v1 = tylko Sprzedaż + Outreach.** Dane są w bazie, zero Make. Marketing (paid/organic) = v2/v3.
2. **`GET /api/stats/snapshot` od razu w v1** — feed dla AI-doradcy jest głównym powodem budowy, nie dodatkiem.
3. **Hierarchia segmentów:** Sprzedaż+Outreach = kokpit domykania (Silnik 1, najważniejsze) → Paid = pętla optymalizacji (Silnik 3) → Organic = najniższa dźwignia.
4. **Panel aktywujemy z istniejącego placeholdera** (`statystyki`, status `soon`), nie tworzymy od zera.

---

## SEGMENT 1 — SPRZEDAŻ (kokpit, najważniejszy)

Źródło: tabela `wyceny` (`apps/shared/migrations/002_wyceny_init.sql`). Sprzedaż = `wyceny WHERE typ='ZAMÓWIENIE'` (Shopify + opłacone wyceny). Częściowo gotowe: `GET /api/sprzedaze/stats` ([wyceny-endpoints.js:470-511](../apps/shared/server/wyceny-endpoints.js#L470)).

**Gwiazda polarna — 2 kafle na górze, duże:**

| Metryka | Definicja / kolumny | Cel | Status |
|---|---|---|---|
| **Close rate** | kohortowa (patrz „twarde definicje") — z wycen `typ='WYCENA'` ile ma powiązane `ZAMÓWIENIE`/`paid` w 30 dni | **25–35%** | JEST (do policzenia) |
| **Otwarty pipeline** | `count` + Σ `kwota_proponowana_brutto` + śr. wiek (dni od `created_at`); `typ='WYCENA' AND status IN ('Open','Waiting for payment')` | maleje ↓ (dziś ~268k / 76 dni) | JEST |

**Pod spodem:**
- **Wyceny wysłane** (tydzień/miesiąc): count + Σ wartość. `typ='WYCENA'`, `created_at` w oknie. *(Proxy „wysłana" = istnienie wiersza; brak osobnego stanu „sent" — patrz definicje.)* — JEST
- **Sprzedaże domknięte**: count + Σ `kwota_sprzedazy_brutto`, tydzień/miesiąc, trend vs poprzedni. **Reuse `GET /api/sprzedaze/stats`** (liczy już tempo miesiąca, timezone Europe/Warsaw). — JEST
- **AOV**: Σ kwota / count zamówień w oknie. Cel 1600 → 2500+. — JEST
- **Big-ticket mix**: % wartości z zamówień ≥2k i ≥5k (u nas 56% przychodu z 22% zamówień). — JEST
- **B2B**: % zamówień z `invoice_company_nip` niepuste + AOV B2B vs B2C. ⚠️ Import Shopify NIE mapuje NIP → **undercount** (tylko wyceny z formularza mają NIP). — JEST z zastrzeżeniem
- **Powracający klient**: % klientów z ≥2 zamówieniami (self-join `wyceny` po email/telefon_digits — brak gotowej flagi). — JEST (self-join)
- **Per owner**: Lorenzo vs Antoni (`owner`, endpoint już scoped per user, `?owner=` tylko admin). — JEST

---

## SEGMENT 2 — OUTREACH (czy maszyna mieli; Silnik 1)

Źródło: tabela `"Log zmian"` — realny timestamp `data_zmiany` (jedyne wiarygodne pole czasowe), `disposition`, `czas_trwania_s`, `kierunek`, `status_przed/po`, `zrodlo`. Insert: [server.js:1070-1101](../apps/backlog-b2c/server/server.js#L1070). Wzorzec liczenia: `fetchCallStatsByPhone` ([crm/server.js:131](../apps/crm/server/server.js#L131)).

| Metryka | Definicja / kolumny | Cel | Status |
|---|---|---|---|
| **Speed-to-lead** (mediana) | czas: event utworzenia leada (`Log zmian` `status_po='Nowy'`, opis „Nowy lead z Facebook Lead Ads") → MIN(`data_zmiany`) pierwszego wychodzącego telefonu | **<1h** (ideał <5 min) | JEST (heurystyka) |
| **% leadów nietkniętych** | leady w statusie `Nowy`/`Nie odebrał` z 0 wierszy telefonicznych w `Log zmian`. Dziś ~93/407 (23%) | ↓ do <5% | JEST |
| **% dodzwonień** | 1 − (`disposition='no_answer'` / wszystkie telefony) | rośnie | JEST |
| **Telefony dziś / tydzień** | COUNT wierszy `zrodlo='zadarma_webhook'` (albo NOT IN `NIE_TELEFON_ZRODLA`) po `data_zmiany`, split `kierunek` in/out | — | JEST |
| **Kadencja** | śr. prób/lead + rozkład leadów wg prób (0 / 1–2 / 3–5 / 6+). Brief: 80% sprzedaży = 5+ kontaktów | więcej leadów w 5+ | JEST |
| **Martwe wyceny tknięte w tygodniu** | ile otwartych wycen >14 dni dostało wpis kontaktu (match po telefonie) w oknie 7 dni — łącznik z kokpitem sprzedaży | rośnie (drenaż 268k) | JEST |

**Uzupełniająco (aktywność pisana, komunikator):** liczba wiadomości wychodzących (`kom_messages direction='out'`), follow-upy otwarte/zaległe (`kom_commitments status='open' AND due_at<now`), realne wysyłki (`kom_outbox status='sent'`). — JEST

⚠️ **Pułapki (zapisać, żeby nie kłamać liczbami):**
- `"Ilość telefonów"` na leadzie jest **legacy-skażona** (string-konkatenacja) — NIE ufać, liczyć z `Log zmian`.
- Daty leadów (`"Date"`, `"Data Feedbacku"`) są **prawdopodobnie nadal tekstem** `DD.MM.YYYY` (relikt po erze arkusza) — do szeregów czasowych używać `Log zmian.data_zmiany`. **AKTUALIZACJA 2026-07-13:** Leady B2C to już natywna tabela Supabase, NIE sync z Google Sheets (koniec importów psujących formaty). Typy kolumn to jednak wciąż legacy — przy budowie sprawdzić i rozważyć migrację dat na `timestamptz` (teraz, gdy nic ich nie nadpisuje z arkusza, jest to bezpieczne i uprościłoby całą warstwę statystyk).
- ~~Kolumny `handlowiec`/`sip` w `Log zmian` niezasilane~~ **ROZWIĄZANE 2026-07-13:** `handlowiec` w webhooku Zadarmy zasilany regułą na numer (server.js, insert do `Log zmian`): jeśli **numer Zadarmy Lorenza** (`459 567 870`, env `LORENZO_ZADARMA_NUMBER`) występuje na którejkolwiek nodze połączenia (dzwonił z niego LUB dzwoniono do niego) → `'Lorenzo'`; jawny `call.pracownik` z Make ma pierwszeństwo; brak dopasowania → `DEFAULT_HANDLOWIEC` = **Lorenzo** (cała aktywność Zadarmy to dziś de facto Lorenzo; Antoni nie ma jeszcze numeru, głównie odbiera). ⚠️ Wygaszone env-em: bez `LORENZO_ZADARMA_NUMBER` zachowanie = jak dotąd. **Do włączenia: ustawić env + zdeployować** (historii wstecz nie odtworzymy).

---

## SEGMENT 3 — MARKETING (v2 paid / v3 organic — deferred)

> **AKTUALIZACJA 2026-07-13 — źródło = ZERNIO, nie Make.** Zernio (`https://zernio.com/api/v1`, klucz `ZERNIO_API_KEY` już wpięty w komunikatorze) daje jednym API: `/analytics` (organik: reach/engagement/followers per post i konto, 15+ platform) ORAZ `/ads` (paid: kampanie Meta/TikTok/Google + lead forms + wypychanie konwersji). To upraszcza marketing — osobne webhooki Make `/ingest/ad-spend` i `/ingest/organic` stają się zbędne. **Pełna mapa źródeł per zapytanie: `docs/statystyki-data-catalog.md`.** Poniższy opis Make zostaje jako fallback, gdyby Zernio nie pokrywał jakiegoś pola.

### Paid (v2 — właściwy cel: pętla optymalizacji, nie dashboard)

Supermoc: lead niesie atrybucję w `marketing_meta` (jsonb): `ad_id`, `ad_name`, `adset_id`/`adset_name`, `campaign_id`/`campaign_name`, `platform`, `is_organic`. Zapis: [server.js:1232-1246](../apps/backlog-b2c/server/server.js#L1232). **Grupować po `marketing_meta->>'ad_id'`** (kolumna `ad_name` to tylko sklejony string do wyświetlania).

**Lejek PER REKLAMA (liczony wewnętrznie z leady + wyceny):**
> reklama → #leadów → #dodzwonionych → #wycen → #sprzedaży → Σ przychód

Po dołączeniu kosztu z Make: **CAC** (spend/sprzedaże), **ROAS** (przychód/spend), koszt/lead, koszt/wycena. Kluczowe: rankować po **przychodzie/CAC**, nie po liczbie leadów (tanie leady bywają śmieciem). Ten sam wynik wraca do Mety przez Conversions API (Silnik 3) — panel = źródło feedbacku.

**Webhook #1 (Make → koszt reklam):** nowa tabela `marketing_ad_stats` (ad_id, ad_name, adset_id, campaign_id, date, spend, impressions, clicks, currency; PK `(ad_id, date)` — dzienny snapshot, wzorem `kom_tiktok_stats`).
```
POST /api/statystyki/ingest/ad-spend?token=...
{ "date":"2026-07-13", "currency":"PLN",
  "rows":[ {"ad_id":"...","ad_name":"...","adset_id":"...","campaign_id":"...","spend":123.45,"impressions":10000,"clicks":210} ] }
```

### Organic (v3 — najniższa dźwignia)

- **TikTok — JUŻ w bazie**: `kom_tiktok_stats` (`plays/likes/comments/shares/saves` per film per dzień; [migrations/006](../apps/komunikator/migrations/006_tiktok_stats.sql), zasilane cronem worker 7:15). Można pokazać już w v1 jako tani bonus.
- **FB/IG zasięgi — BRAK** (komunikator trzyma tylko treść wiadomości, nie insights). Wymaga Make.

**Webhook #2 (Make → FB/IG insights):** nowa tabela `marketing_organic_stats` (platform, post_id, date, reach, impressions, likes, comments, shares, saves, clicks; + snapshot konta: followers, profile_views).
```
POST /api/statystyki/ingest/organic?token=...
{ "platform":"instagram", "date":"2026-07-13",
  "account": {"followers":3400,"reach":50000,"profile_views":900},
  "posts":[ {"post_id":"...","url":"...","published_at":"...","reach":5000,"impressions":8000,"likes":120,"comments":8,"shares":3,"saves":10,"clicks":25} ] }
```

Oba ingesty tokenowane (wzorem publiczny formularz wyceny). Antoni buduje scenariusze Make; my dajemy gotowy kształt JSON.

---

## `GET /api/stats/snapshot` — feed dla AI-doradcy (v1)

Kompaktowy JSON = „jedna prawda" dla Fable. Doradca czyta to w rytuale dziennym (brief sekcja 8) i sam wybiera liczbę do pokazania. Pole `alerty` = gotowe zdania do wrzucenia w rozmowę.

**PLACEHOLDER JUŻ ISTNIEJE (2026-07-13):** `apps/statystyki/server/server.js` + wrapper `api/statystyki.js` + routing w `vercel.json` (`/statystyki/api/:path*` → `/api/statystyki`; strona „wkrótce" zostaje na hubie). Endpoint maszynowy, autoryzacja tokenem (`STATS_API_TOKEN`), zwraca kontrakt z `null` + `_status:"placeholder"`. Publiczny URL: `https://lumlum.dev/statystyki/api/stats/snapshot`. Handoff dla czatu budującego asystenta: `docs/statystyki-ai-handoff.md`. **Build v1 = wpiąć realne zapytania w miejsce `null` (mapowanie pól → tabele wyżej).**
```json
{
  "generated_at": "2026-07-13T08:00:00+02:00",
  "sprzedaz": {
    "close_rate_30d": 0.14,
    "sprzedaz_mies": { "count": 22, "suma": 41000 },
    "aov": 1863,
    "pipeline_otwarty": { "count": 119, "suma": 268000, "sredni_wiek_dni": 76 }
  },
  "outreach": {
    "telefony_dzis": 0, "telefony_tydzien": 0,
    "pct_dodzwonien": 0.58, "speed_to_lead_med_min": null,
    "leady_nietkniete": 93, "martwe_wyceny_tkniete_7d": 0
  },
  "alerty": [
    "268 000 zł leży w otwartych wycenach, średni wiek 76 dni.",
    "23% leadów nigdy nie dobrzwonione (93/407)."
  ]
}
```

---

## TWARDE DEFINICJE (żeby nie ściemniać liczbami)

- **Sprzedaż** = `wyceny WHERE typ='ZAMÓWIENIE'` (Shopify orders + opłacone wyceny). Kwota = `kwota_sprzedazy_brutto ?? kwota_proponowana_brutto`.
- **Close rate** — DWIE wersje, nie mylić:
  - *Naiwna „tempo"* = sprzedaże(mies)/wyceny(mies). **Myląca** (kohorty się nie zgadzają — wycena z tego miesiąca domyka się w następnym). Tylko szybki puls.
  - *Prawdziwa kohortowa (KPI)* = z wycen `typ='WYCENA'` utworzonych w miesiącu M, ile ma powiązane `ZAMÓWIENIE`/`paid` w ciągu 30 dni. Świeże kohorty oznaczyć „dojrzewa". **To jest liczba, którą się mierzysz.**
- **Wycena wysłana** = proxy przez istnienie wiersza `typ='WYCENA'` (`created_at`); brak osobnego stanu „sent".
- **Martwa wycena** = `status IN ('Open','Waiting for payment')` + `created_at` starsze niż 14/30 dni + brak aktywności. Heurystyka, nie flaga.
- **B2B** = `invoice_company_nip` niepuste (undercount — Shopify bez NIP).
- **Powracający klient** = ≥2 wiersze `ZAMÓWIENIE` po email/telefon_digits (self-join, brak flagi).

---

## ZAKRES / CO RUSZAMY (żeby się nie rozlazło)

- **Aktywacja placeholdera:** [auth.js:43](../apps/shared/server/auth.js#L43) — `statystyki` status `'soon'` → `'ready'`; ewentualnie dodać do `NAV_ITEMS` w [topbar.js](../apps/shared/topbar.js) (decyzja niżej).
- **Panel:** rekomendacja — osobna funkcja `apps/statystyki/` + `api/statystyki.js` + wpisy w `vercel.json` (`functions`/`rewrites`/`redirects` wzorem `wyceny`/`sprzedaze`). Alternatywa: strona w hubie (`api/index.js`).
- **Endpointy v1:** reuse `GET /api/sprzedaze/stats`; nowe `GET /api/statystyki/outreach`, `GET /api/statystyki/sprzedaz` (rozszerzenie), `GET /api/stats/snapshot`.
- **v2/v3:** migracja `marketing_ad_stats` + `marketing_organic_stats` w `apps/shared/migrations` (wzorem `kom_tiktok_stats`); tokenowane `POST /api/statystyki/ingest/ad-spend` i `/ingest/organic`.
- **NIE ruszamy:** pipeline'u wycen, komunikatora, silnika Umowy. Panel tylko czyta.

## ZMIENNE ENV (Vercel)

| Env | Do czego | Status |
|---|---|---|
| `STATS_API_TOKEN` | sekret, którym AI-doradca autoryzuje `GET /statystyki/api/stats/*`. Bez niego endpoint = 503. | ✅ USTAWIONE na prod (2026-07-13) |
| `LORENZO_ZADARMA_NUMBER` | numer Zadarmy Lorenza (`459567870`) — zasila `handlowiec='Lorenzo'` w Log zmian. | ✅ USTAWIONE na prod (2026-07-13) |
| `DEFAULT_HANDLOWIEC` | fallback handlowca, gdy brak dopasowania numeru = **`Lorenzo`** (Antoni głównie odbiera; cała aktywność Zadarmy to dziś de facto Lorenzo). | ✅ już na prod (4d) |

⚠️ Env są ustawione, ale **wchodzą w życie dopiero po redeployu** (Vercel nie stosuje ich do działających deploymentów wstecz) — a kod endpointu i reguła handlowca też czekają na deploy.

## V2 — MARKETING/PAID: PĘTLA OPTYMALIZACJI (korekta 2026-07-13)

**Sedno wg Antoniego:** rolą integracji z Metą jest **wysyłanie sygnału zwrotnego** — „ten lead (i tym bardziej: ten lead, który stał się sprzedażą) był świetny → optymalizuj pod podobne", kluczowane po `lead_id`/`ad_id`. To jest offline conversions / Conversions API (Silnik 3). **NIE trzeba do tego ściągać kosztów** — koszt siedzi po stronie Mety i to Meta liczy ROAS oraz dobiera lookalike. My tylko odsyłamy zdarzenie konwersji z wartością sprzedaży.

**Co robi Make (główny kierunek — EKSPORT do Mety):**
1. Nasz cron/endpoint wystawia świeże konwersje: leady, które stały się sprzedażą (z `wyceny` + `lead_id` + `marketing_meta.ad_id` + wartość `kwota_sprzedazy_brutto`). Make (albo bezpośrednio Meta CAPI) wysyła je do Mety jako offline/served conversions. **To zamyka pętlę „Meta optymalizuje pod kupujących, nie pod wypełniaczy formularzy".** Nic więcej do V2 nie jest ci potrzebne.
2. **Potwierdzenie, że leady niosą `ad_id`** — już tak jest (`marketing_meta` jsonb na leadzie), więc mapowanie lead→sprzedaż→reklama liczy się u nas bez twojej pracy.

**Import kosztów = OPCJONALNY (tylko jeśli chcesz CAC/ROAS w NASZYM panelu, a nie w Meta Ads Manager).** Wtedy: `POST /statystyki/api/ingest/ad-spend` + tabela `marketing_ad_stats`. Ale do samej optymalizacji zbędny — niższy priorytet niż eksport konwersji.

Dla **organic (v3):** eksport historyczny (Antoni robi) — statystyki TikToka z ostatniego roku, żeby mieć dane wstecz; FB/IG zasięgi dojdą przez `POST /statystyki/api/ingest/organic`. TikTok bieżący już leci do `kom_tiktok_stats`.

## OTWARTE PYTANIA (do rozstrzygnięcia w czacie budującym)

1. **Close rate — okno kohorty:** 30 czy 60 dni? (rekomendacja: 30 dni + tag „dojrzewa" dla świeżych).
2. **Per-rep outreach:** mapować telefon→lead→`"Owner"` (tanio, teraz) czy zasilić `handlowiec` w `Log zmian` (dokładniej, więcej pracy)? (rekomendacja: Owner na start).
3. **Panel osobny (`api/statystyki.js`) czy strona w hubie?** (rekomendacja: osobny — spójnie z innymi panelami).
4. **TikTok organic w v1 jako bonus?** Dane gotowe w `kom_tiktok_stats` (rekomendacja: tak, tani quick-win, choć to formalnie v3).
5. **Uprawnienia:** czy Lorenzo widzi cały panel czy tylko swoje (Sprzedaż/Outreach scoped per owner, marketing = admin)? (rekomendacja: Lorenzo widzi swoje Sprzedaż+Outreach, marketing admin-only).
