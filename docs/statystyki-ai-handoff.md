# Handoff dla czatu budującego AI-doradcę (Fable) — feed statystyk LumLum

> **Wklej to w całości do nowego czata, w którym budujesz asystenta.** To opis JEDNEGO endpointu, z którego asystent bierze wszystkie statystyki firmy zamiast przeszukiwać system. Kontrakt pól jest finalny; wartości są na razie `null` (placeholder), realne dane wpina się w buildzie v1.

## Co to jest

LumLum ma panel Statystyki wystawiający **maszynowy endpoint** dla wewnętrznego AI-doradcy. Zamiast odpytywać wiele tabel, asystent robi **jeden GET** i dostaje komplet: sprzedaż, pipeline, outreach + gotowe zdania-alerty. Endpoint ma być głównym paliwem „rytuału dziennego" doradcy (patrz `docs/fable-doradca-lumlum.md`, sekcja 8): przy „co dziś?" doradca ciągnie żywe liczby, nie zgaduje.

## Endpoint

```
GET https://lumlum.dev/statystyki/api/stats/snapshot
Authorization: Bearer <STATS_API_TOKEN>      # albo ?token=<STATS_API_TOKEN>
```

- Autoryzacja tokenem (sekret w env `STATS_API_TOKEN`, ustawiany na Vercel). Bez tokena → 401. Bez ustawionego sekretu na serwerze → 503 (celowo wyłączony).
- Health-check bez tokena: `GET /statystyki/api/stats/health` → `{ ok, token_set, ts }`.
- Aliasy segmentowe (opcjonalne): `/statystyki/api/stats/sprzedaz`, `/statystyki/api/stats/outreach`.
- Kod: `apps/statystyki/server/server.js` (placeholder), wrapper `api/statystyki.js`, routing w `vercel.json`.

## Kontrakt odpowiedzi (kształt FINALNY)

Pola są ustalone; teraz zwracają `null` z `_status:"placeholder"`. Przykład z realistycznymi wartościami (żeby asystent wiedział, czego się spodziewać po wpięciu danych):

```json
{
  "_status": "ready",
  "generated_at": "2026-07-13T08:00:00+02:00",
  "sprzedaz": {
    "close_rate_30d": 0.14,
    "sprzedaz_mies": { "count": 22, "suma": 41000 },
    "aov": 1863,
    "pipeline_otwarty": { "count": 119, "suma": 268000, "sredni_wiek_dni": 76 }
  },
  "outreach": {
    "telefony_dzis": 12,
    "telefony_tydzien": 47,
    "pct_dodzwonien": 0.58,
    "speed_to_lead_med_min": 84,
    "leady_nietkniete": 93,
    "martwe_wyceny_tkniete_7d": 6
  },
  "alerty": [
    "268 000 zł leży w otwartych wycenach, średni wiek 76 dni.",
    "23% leadów nigdy nie dobrzwonione (93/407)."
  ]
}
```

### Znaczenie pól

| Pole | Znaczenie | Cel / interpretacja dla doradcy |
|---|---|---|
| `sprzedaz.close_rate_30d` | close rate kohortowy (wyceny sprzed 30 dni → ile domknięte) | **główny KPI**; <0,25 = pipeline przecieka, priorytet = domykanie |
| `sprzedaz.sprzedaz_mies` | liczba i suma sprzedaży w bieżącym miesiącu | trend vs cel miesiąca |
| `sprzedaz.aov` | średnia wartość zamówienia (zł) | 1600 → cel 2500+; niski = pchać zestawy/B2B |
| `sprzedaz.pipeline_otwarty` | otwarte wyceny: liczba, suma zł, średni wiek dni | **ma maleć**; rośnie = follow-up nie działa |
| `outreach.telefony_dzis/tydzien` | wolumen połączeń | zero dziś rano = alarm dla Lorenza |
| `outreach.pct_dodzwonien` | % dodzwonień | niski = problem z jakością/porą dzwonienia |
| `outreach.speed_to_lead_med_min` | mediana minut: nowy lead → 1. telefon | <60 dobrze, <5 ideał; wysoki = leady stygną |
| `outreach.leady_nietkniete` | leady nigdy nie dobrzwonione | to są wyrzucone pieniądze; ma maleć |
| `outreach.martwe_wyceny_tkniete_7d` | ile starych wycen dostało kontakt w 7 dni | dowód pracy po pipeline 268k |
| `alerty[]` | gotowe zdania po polsku | doradca może je cytować wprost w rozmowie |

## Jak asystent ma tego używać

1. Na starcie rozmowy dziennej (`co dziś` / `dzień dobry`) — **jeden GET snapshot**, zbuduj obraz sytuacji z liczb, nie pytaj użytkownika o dane, które tu są.
2. Priorytet: dopóki `close_rate_30d < 0.25` → pierwsza rekomendacja zawsze z domykania (Silnik 1). Nie proponuj skalowania reklam ani budowania, gdy pipeline przecieka.
3. `alerty[]` = gotowce do wrzucenia w rozmowę.
4. Zawsze kończ **jedną konkretną akcją z godziną** (styl z briefu doradcy).

## Status / czego jeszcze nie ma

- **v1 = Sprzedaż + Outreach** (dane już w systemie LumLum, zero zależności zewnętrznych). Pola powyżej. Realne zapytania do wpięcia — mapowanie na tabele/kolumny: `docs/statystyki-panel-spec.md`.
- **v2 = Marketing/Paid** (lejek per reklama, CAC/ROAS) — dojdzie osobny blok w snapshot (`marketing.paid`), wymaga danych o koszcie reklam z Make.
- **v3 = Marketing/Organic** (zasięgi social) — dojdzie `marketing.organic`.

Gdy dojdą v2/v3, snapshot rozszerzy się o klucz `marketing` — kontrakt v1 zostaje bez zmian (asystent nie musi nic przepisywać).
