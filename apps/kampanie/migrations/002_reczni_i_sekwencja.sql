-- Kampanie v2 (2026-07-15): ręcznie wybrani odbiorcy + sekwencja follow-upów.
-- Ręczny odbiorca (zrodlo='reczny') dodawany z wyszukiwarki (lead/wycena/goły
-- numer, np. test do siebie) - może nie mieć żadnej wyceny.
-- Sekwencja: kampanie.sekwencja = {"po_dniach":7,"brief":"..."} (null = wyłączona);
-- follow-up wychodzi gdy odbiorca 'sent' nie odpowiedział przez po_dniach,
-- odpowiedź/kontakt wypisuje go z sekwencji (sekwencja_stop = powód).

alter table kampanie
  add column if not exists sekwencja jsonb;

-- tryb "wybrani ręcznie" = filtr null (populacji się nie zamraża)
alter table kampanie
  alter column filtr drop not null,
  alter column filtr drop default;
alter table kampanie
  alter column filtr set default '{}'::jsonb;

alter table kampanie_odbiorcy
  add column if not exists zrodlo text not null default 'filtr',
  add column if not exists sekwencja_krok integer not null default 0,
  add column if not exists sekwencja_at timestamptz,
  add column if not exists sekwencja_stop text;

create index if not exists kampanie_odbiorcy_sekw_idx
  on kampanie_odbiorcy (kampania_id, status, sekwencja_krok)
  where status = 'sent';
