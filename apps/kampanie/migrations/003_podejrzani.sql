-- Podejrzane case'y do zatwierdzenia (2026-07-15): wycena z kwotą poniżej
-- progu (default 400 zł) albo bez kwoty prawie na pewno jest błędna/śmieciowa
-- - taki odbiorca dostaje flagę i NIE wychodzi z wysyłką, dopóki Antoni go
-- nie zatwierdzi (może najpierw otworzyć wycenę deep-linkiem /wyceny/?id=X).
alter table kampanie_odbiorcy
  add column if not exists podejrzany boolean not null default false,
  add column if not exists podejrzany_powod text;
