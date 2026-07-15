-- "Dodatkowa przesyłka" na leadzie — dosyłka bez faktury (0 zł).
-- Przypadek: wysłano klientowi zły towar (np. nie te czujniki) i trzeba dosłać
-- właściwy — bez nowej faktury, bo to korekta naszego błędu. Handlowiec z karty
-- leada zapisuje CO wysłać (pozycje) + notatkę (dyktowaną) KIEDY: "za tydzień",
-- "gdy przyjdą nowe czujniki". Potem jednym ruchem "Nadaj do fulfillmentu" →
-- powstaje 0-zł ZAMÓWIENIE (source='dodatkowa-przesylka') + etykieta, bez FV.
--
-- FUNDAMENT PRZYSZŁEGO SYSTEMU MAGAZYNU (decyzja Antoniego 2026-07-15):
-- pozycje trzymają `sku`, a flaga `czeka_na_dostawe` = "wyślę, gdy przyjdzie
-- towar". Gdy powstanie magazyn (stany po SKU + przyjęcia dostaw od dostawcy),
-- przyjęcie dostawy z danym SKU ma wyszukać tu wszystkie oczekujące dosyłki
-- (status='oczekuje' AND czeka_na_dostawe) i wypchnąć push „przyszła dostawa —
-- miałeś dosłać X panu Y". Ta tabela jest tym, na czym magazyn się oprze.

create table if not exists dodatkowe_przesylki (
  id bigserial primary key,
  lead_id text,                                    -- "Leady B2C"."ID Leada" (spięcie po telefonie)
  telefon_digits text,                             -- cyfry bez prefiksu 48, spójnie z `wyceny`
  imie text,                                        -- podgląd na karcie/w fulfillmencie
  owner text,                                       -- handlowiec (z leada)
  pozycje jsonb not null default '[]'::jsonb,       -- [{ nazwa, ilosc, sku }]
  notatka text,                                     -- dyktowana: kiedy/dlaczego dosłać
  czeka_na_dostawe boolean not null default false,  -- wyzwalacz = przyjęcie dostawy (magazyn v2)
  planowana_data date,                              -- opcjonalny termin nadania
  status text not null default 'oczekuje',          -- oczekuje | nadane | anulowane
  wycena_id integer references wyceny(id) on delete set null, -- 0-zł ZAMÓWIENIE po nadaniu
  nadane_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists dodatkowe_przesylki_lead_idx on dodatkowe_przesylki (lead_id);
create index if not exists dodatkowe_przesylki_tel_idx on dodatkowe_przesylki (telefon_digits);
-- Kolejka „do nadania" per status (i przyszły skan magazynu po czeka_na_dostawe).
create index if not exists dodatkowe_przesylki_status_idx on dodatkowe_przesylki (status);
