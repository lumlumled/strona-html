-- ── Organic = kontakty zmierzające do wyceny ────────────────────────────────
-- Decyzja Antoniego 2026-07-29: lista "Organic" w CRM ma być pełnoprawną kartą
-- leada (kiedy przyszło, Kontakt, Notatka, Historia rozmów, WYCENA), a nie gołą
-- historią rozmowy. Do tego brakuje danych: analiza rozmowy WYŁAPUJE produkty
-- (analyzeCall.produkty), ale applyRozmowaDoKontaktu je gubiła — kontakt organic
-- nie miał gdzie ich zapisać. Bez produktów nie da się zaproponować "wykryliśmy
-- wycenę, podaj ceny".
--
-- Kolumny lustrzane wobec leada (który te same dane trzyma w "Produkty z wyceny"
-- / "Kwota wyceny"), plus most do tabeli `wyceny` (utworzony szkic).

-- Produkty ustalone w rozmowie (tekst, jak "Produkty z wyceny" na leadzie) —
-- twardy dowód pod wycenę: tylko konkretne pozycje z ilościami.
alter table kontakty_organic add column if not exists produkty text;

-- Kwota zaproponowana w rozmowie, jeśli padła (analyzeCall.cena_zaproponowana).
alter table kontakty_organic add column if not exists kwota text;

-- Most do utworzonego szkicu wyceny (POST /api/wyceny). Gdy ustawiony, karta
-- Organic pokazuje sekcję Wycena zamiast przycisku "Utwórz wycenę".
alter table kontakty_organic add column if not exists wycena_id bigint;

create index if not exists kontakty_organic_wycena_id_idx
  on kontakty_organic (wycena_id);
