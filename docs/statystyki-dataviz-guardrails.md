# Wizualizacja panelu statystyk — guardrails (dołącz do buildu panelu)

> Żeby dashboard nie był „z dupy". Metoda: **forma najpierw, kolor na końcu, paletę WALIDUJ skryptem — nie zgaduj.** Poniższe jest dopasowane do wykresów panelu LumLum. Paleta niżej jest już zwalidowana (light: worst CVD ΔE 24,2 PASS; dark: ΔE 10,3 floor-band PASS).

## Zasada #1 — nie każda liczba to wykres

- **KPI (przychód MTD, AOV, close rate, liczba zamówień) = STAT TILE, nie wykres.** Duża liczba + delta vs poprzedni miesiąc (↑ zielony `#006300`/`#0ca30c`, ↓ czerwony). Ewentualnie mikro-sparkline obok. Pojedynczej liczby NIE wykreślaj.
- **„268k martwych wycen" = hero number / stat tile**, nie słupek.

## Forma per wykres (dobrana do zadania danych)

| Wykres | Zadanie danych | Forma | Kolor |
|---|---|---|---|
| Przychód miesięczny | zmiana w czasie | **linia/area, JEDNA seria**, wyróżniony ostatni punkt, bez legendy | jeden akcent (blue `#2a78d6`) |
| Lejek leadów po etapach | uporządkowane etapy | **poziome słupki (ordinal)** | jeden hue, kroki blue; na light NIE jaśniej niż `#86b6ef` |
| Top martwe wyceny | lista + pilność | **tabela** z paskiem statusu po wieku | status: >90d `critical #d03b3b`, 30–90d `serious #ec835a`, <30d `warning #fab219` |
| ROAS/CAC per reklama | magnituda, ranking | **poziome słupki posortowane** | jeden hue; próg opłacalności = linia + kolor status nad/pod |
| Organic vs paid | 2 kategorie | słupek/donut 2-elem. | categorical sloty 1–2 (blue, aqua) |
| % dodzwonień / speed-to-lead w czasie | trend | linia lub stat tile + sparkline | jeden akcent |

## Nienaruszalne (najczęstsze wpadki)

- **JEDNA oś. Nigdy dual-axis** (dwie skale Y) — to zabójca #1. Dwie miary różnej skali → dwa wykresy albo indeks do wspólnej bazy.
- **Kolor po ZADANIU:** magnituda → jeden hue light→dark (sekwencyjny); tożsamość → **categorical w STAŁEJ kolejności, nigdy cyklicznie**; stan → status (good/warning/serious/critical), zarezerwowane, **zawsze z ikoną/labelką**, nie samym kolorem.
- **Kolor idzie za bytem, nie za rankingiem.** Filtr zmieniający liczbę serii NIE przemalowuje ocalałych.
- **Paletę walidujesz skryptem** (`dataviz/scripts/validate_palette.js`) jeśli ruszysz kolory. CVD ≥12 cel; 8–12 tylko z drugim kanałem (labelki/tekstura).
- **Hover na każdym wykresie** (crosshair+tooltip na linii/area, per-słupek na słupkach). Filtry w jednym rzędzie nad wykresami.
- **Dark mode PROJEKTOWANY, nie odwracany** — te same hue stepowane pod ciemną powierzchnię (kolumna „Dark" niżej).
- Cienkie marki, końce słupków zaokrąglone 4px u bazy, 2px przerwy między wypełnieniami, recesywna siatka (hairline). **Tekst w tokenach ink, nigdy w kolorze serii.** Legenda dla ≥2 serii (dla jednej — tytuł nazywa serię).
- **Relief rule:** na light aqua/yellow/magenta są <3:1 — jeśli ich użyjesz, DODAJ widoczne labelki albo widok tabeli.

## Paleta (zwalidowana — wklej jako CSS custom properties, swap w jednym miejscu)

**Categorical (tożsamość, stała kolejność):** slot1 blue `#2a78d6`/dark `#3987e5` · slot2 aqua `#1baf7a`/`#199e70` · slot3 yellow `#eda100`/`#c98500` · slot4 green `#008300` · slot5 violet `#4a3aa7`/`#9085e9` · slot6 red `#e34948`/`#e66767` · slot7 magenta `#e87ba4`/`#d55181` · slot8 orange `#eb6834`/`#d95926`. 9. seria → „Inne", nie nowy hue.

**Sekwencyjny (magnituda):** blue, `#cde2fb`→`#0d366b`. Ordinal (etapy): na light start `#86b6ef`, na dark nie ciemniej niż `#184f95`.

**Status (nigdy tematyzowany):** good `#0ca30c` · warning `#fab219` · serious `#ec835a` · critical `#d03b3b`.

**Chrome/ink:** surface light `#fcfcfb`/dark `#1a1a19` · ink primary `#0b0b0b`/`#fff` · secondary `#52514e`/`#c3c2b7` · muted axis `#898781` · grid `#e1e0d9`/`#2c2c2a`. Font: `system-ui,-apple-system,"Segoe UI",sans-serif`, `tabular-nums` tylko w kolumnach/osiach.

> Chcesz paletę w Twoim brandzie (bursztyn LED zamiast blue jako akcent)? Podmień hue i **przepuść przez walidator** — nie wklejaj na oko. Mogę to zrobić i dać Ci zwalidowany zestaw.
