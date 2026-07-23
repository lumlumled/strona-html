# Spec: priorytetyzacja lidów w Backlog B2C (do wdrożenia ~po tygodniu sprzedaży)

> UKŁAD (iteracja 2026-07-23 popołudniu, NA PRODZIE): finalnie **3 kategorie** zamiast „zostaw kafelki": **Priorytet dziś (5-7, pick AI, na górze) → Nowe → 💰 Wyceny do domknięcia → 📞 Reszta lejka → Zaległe feedbacki (dół, zwinięte)**. „Reszta lejka" = scalone inne_z_feedbackiem + nieodebrane + rozmowy_spoza_bazy (serwer: `mergeRestaLejka`), z suwakiem sortowania **Pilność (score) / Cena (kwota)** na froncie. Ukryte w widoku: 🚨 Alerty (temat ucieka) + 🌡️ Leady do odświeżenia (nadal budowane serwerowo, hub ich używa).
>
> Status: **PHASE 1 ZBUDOWANE 2026-07-23, czeka na deploy.** Kod na branchu (niezacommitowany): moduł `apps/backlog-b2c/server/scoring.js`, kubełek „Wyceny do domknięcia" z kanonicznej `wyceny`, dedup, tier UI 🔴🟠⚪+💎+„dlaczego", re-scoring temperatury po rozmowie (RPC `app_update_leady_after_call` + `p_temperatura`). Przetestowane E2E na prod-danych (read-only). ZOSTAŁO do wdrożenia: (1) `node scripts/add-temperatura-po-rozmowie.js` (migracja RPC), (2) commit + deploy Vercel. Phase 2 (auto-SMS po 5-6 nieodebranych, real-time push, pełna żywa lista 268k) — nietknięte. Cel: żeby Lorenzo dostawał lidy w kolejności potencjalnego zwrotu.

## AKTUALIZACJA 2026-07-22 — decyzje dopięte (NADPISUJĄ poniższe, gdzie się różnią)

Rozmowa z Antonim doprecyzowała spec. Te ustalenia mają pierwszeństwo nad starszymi sekcjami:

1. **„Wycena" ≠ „wysłana oferta". Kluczowe.** +30 i punkty za wartość dostaje TYLKO realna wycena wpisana w systemie = koszyk z konkretnymi produktami i kwotą (rekord w tabeli `wyceny`, typ=WYCENA, status Open, z pozycjami + `kwota`). NIE liczy się: oferta produktowa/katalog wysyłany projektantom albo B2C „na maila żeby popatrzeć", „poproszę o ofertę" bez konkretów, sam link formularza, ani status „Wycena wysłana" na leadzie. → **Poprawka do Reżimu A niżej: usuwamy „leady 'Wycena wysłana'" jako źródło; źródło = wyłącznie rekordy z tabeli `wyceny`.**
2. **Układ backlogu: ZOSTAWIAMY istniejące kafelki + naprawiamy** (NIE robimy 3 czystych kategorii z sekcji „3 KATEGORIE" niżej — ta zostaje jako alternatywa historyczna). Nie wyrzucamy tego, co już działa.
3. **Kasujemy kafelek „Wyceny historyczne"** jako osobny. Jego wyceny wpadają do kubełka „Wyceny do domknięcia" (scoring). **Dedup: case z realną wyceną pojawia się TYLKO w jednym kubełku (wyceny do domknięcia), nigdy równolegle w „inne z feedbackiem".** To usuwa dzisiejsze miksowanie (te same 7 „inne z feedbackiem" siedziały też w „historycznych").
4. **Kolejność kafelków od góry:**
   1. 🔥 **DZIŚ / PILNE** — zostaje na samej górze (świeże leady real-time + terminy na dziś).
   2. 📥 **Nowe leady**.
   3. 💰 **Wyceny do domknięcia** — scoring (Reżim A), 💎 na 5k+, **nowe wyceny lądują na górze tego kubełka** (świeżość podbija score). Wchłania dawne „wyceny z feedbackiem" + „historyczne".
   4. 📞 **Nieodebrane** (≤5 prób; 6+ → auto-SMS i znika).
   5. 📋 **Inne z feedbackiem** — tylko BEZ wyceny, deduped względem kubełka 3.
5. **Dynamiczny re-scoring po każdej odebranej rozmowie.** Score przelicza się automatycznie po telefonie (webhook Zadarmy — wpina się w istniejące przeliczanie temperatury/najbliższej akcji). Klient mówi „temat za 2 miesiące" → temperatura spada / termin się przesuwa → score leci w dół, case schodzi z góry.
6. **Widok priorytetu = tier 🔴/🟠/⚪ + „dlaczego"** (2–3 powody), NIE liczba. (Rozstrzyga otwarte pytanie z końca pliku.)
7. **Auto-SMS po 5–6 próbach — potwierdzone** (case znika z góry listy).

## Kontekst / dlaczego

Dziś cron „Umowa" dzieli lidy na 5 kategorii w sztywnej kolejności; wewnątrz sortuje **po dacie feedbacku**, a Kwota to tylko tie-breaker. W danych: **Kwota pusta u 89% lidów, Temperatura u 92%** (system AI-analizy jest świeży, wypełnia się z każdą rozmową — to OK, będzie rósł). Efekt: lista jest de facto **chronologiczna, wartość prawie nie gra** — a big-ticket to 56% przychodu. Trzeba, żeby **najgrubsze/najgorętsze wyceny szły na górę.**

Kwota żyje przy WYCENIE, nie przy leadzie (na początku rozmowy klient często nie wie, czego chce → brak kwoty). Więc wartość steruje priorytetem tylko tam, gdzie wycena już jest — i to dokładnie te case'y, które są najbliżej pieniędzy.

## DECYZJE (zamrożone przez Antoniego)

1. **NIE robimy drugiego widoku.** Jeden system. (Dwa widoki = podwójne utrzymanie + Lorenzo nie wie, którego używać + nigdy tego nie zamrozisz.)
2. **Zostają kategorie, ale 3 zamiast 5.** Wewnątrz każdej sortowanie po **liczonym wyniku priorytetu** (score), nie po samej dacie.
3. **Świeży lead wpada do Backlogu NATYCHMIAST** (real-time), nie czeka do jutrzejszej Umowy. Plus push „dzwoń w 5 min".
4. **Powyżej 5–6 prób bez kontaktu → odpuść dzwonienie, auto-SMS wysyła się raz sam** (darmowa automatyzacja), case schodzi z góry listy.
5. **Zaległe wyceny (268k z panelu `wyceny`) trafiają do Backlogu Lorenza** — sortowane po dacie ORAZ wartości (najwyższy potencjalny zwrot na górze). Lorenzo robi follow-upy do zaległych linków wycen.
6. **NIE dotykamy silnika edycji Umowy** (AI voice-edit, priorytet_dzis, plan). Zmieniamy tylko warstwę: (a) ile kategorii, (b) sort wewnątrz, (c) źródło danych (dochodzą wyceny). Silnik zostaje.

## 3 KATEGORIE (nowa struktura)

**1. 🔥 DZIŚ / PILNE** — must-touch dzisiaj.
- świeże leady (speed-to-lead, wpadają real-time) + feedbacki z terminem na dziś.
- sort: świeżość (najnowszy lead pierwszy) → termin.

**2. 💰 WYCENY DO DOMKNIĘCIA** (Reżim A — „blisko pieniędzy") — kubełek pieniędzy.
- wszystko, co ma wysłaną wycenę / kwotę: leady „Wycena wysłana" + otwarte wyceny z panelu `wyceny` (te 268k).
- sort: **score = wartość × termin × temperatura** (patrz niżej). 💎 na 5k+.

**3. 📞 RESZTA LEJKA** (Reżim B — „góra lejka") — do oddzwonienia.
- nowe starsze + nieodebrane (≤5 prób) + „Po pierwszym tel / Zadzwonić jeszcze raz".
- sort: score = świeżość / szansa kontaktu. 6+ prób → auto-SMS i znika.

## SCORING (0–100, wagi startowe — dostroić z Lorenzo po tygodniu)

**Reżim A (ma wycenę/kwotę):**
| Sygnał | Punkty |
|---|---|
| Ma wysłaną wycenę | +30 |
| Wartość <1k / 1–2k / 2–5k / **5k+** | +5 / +12 / +22 / **+35** |
| Temperatura gorący / średni | +18 / +8 |
| Termin dziś / przeterm. 1–3d / 4–7d / >7d | +15 / +12 / +6 / +2 |

**Reżim B (brak wyceny):**
| Sygnał | Punkty |
|---|---|
| Nowy: <1h / <4h / dziś / starszy | +40 / +30 / +22 / +6 |
| Nieodebrał: 1–2 próby / 3–5 / **6+** | +20 / +12 / **+3 → auto-SMS** |
| Był kontakt (Po tel / Zadzwonić raz) | +10 |

Wagi to hipoteza — po tygodniu Lorenzo mówi „ten był wyżej, a nie powinien" i korygujemy. **Potem zamrażamy na min. miesiąc.**

## WYŚWIETLANIE (front karty)

- badge priorytetu (🔴/🟠/⚪ albo liczba), **Kwota wytłuszczona**, chip temperatury, chip etapu, „czeka od / termin", liczba prób, jedna następna akcja.
- **💎 na 5k+** — żeby fizycznie nie dało się przeskoczyć grubej wyceny.
- **„Dlaczego #1"** — 2–3 powody score'a („wycena 6 500 zł · termin minął 2 dni · gorący"). Bez tego handlowiec nie ufa kolejności.
- pasek na górze: **„🔥 świeży lead — dzwoń w 5 min"** (oddzielny od kolejki dziennej).

## ZAKRES / CO RUSZAMY (żeby nie rozlazło się)

W `apps/backlog-b2c/server/server.js`:
- skonsolidować `fetchNowe / fetchWycenyZFeedbackiem / fetchInneZFeedbackiem / fetchNieodebrane / fetchWycenyHistoryczne` z 5 → 3 kategorii;
- dodać funkcję `scoreCase()` + sort po score wewnątrz kategorii (zamiast sort po dacie);
- dodać **źródło: otwarte wyceny z tabeli `wyceny`** (typ=WYCENA, status Open) do kategorii 2, dopasowane po telefonie do leadów (dedup).
Nowe, małe, osobne kawałki:
- **real-time**: webhook leada FB → insert do „DZIŚ" + push (masz webhook + push infra);
- **auto-SMS po 6 próbach** — sprawdzić, czy Zadarma wysyła SMS (ma API SMS) albo dobrać dostawcę.
Front `app.html`: render 3 kategorii + badge/💎/„dlaczego".

**NIE ruszamy:** silnika AI edycji Umowy (voice-edit, priorytet_dzis, plan, podsumowanie dnia).

## OTWARTE PYTANIA (rozstrzygnąć w nowym czacie)

- Czy „DZIŚ" i „WYCENY DO DOMKNIĘCIA" mogą się nakładać (wycena z terminem na dziś)? — proponuję: wycena zawsze w kubełku 2, ale z podbiciem score za termin-dziś; kubełek 1 = tylko świeże leady + nie-wycenowe feedbacki na dziś.
- SMS: dostawca + treść („Cześć [imię], próbowaliśmy się dodzwonić w sprawie oświetlenia LED — kiedy wygodnie oddzwonić? LumLum").
- Czy pokazywać score liczbowo Lorenzo, czy tylko tier (🔴/🟠/⚪)? (proponuję tier + „dlaczego", liczba myli.)
