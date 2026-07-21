-- Numer wewnętrzny zamówień ze SKLEPU (Shopify): S1, S2, … — nadawany kolejno
-- przy imporcie (ostatnie S + 1) i odsyłany do Shopify jako tag zamówienia.
-- Tag w Shopify = znacznik "już przeprocesowane" + czytelna referencja.
alter table wyceny add column if not exists sklep_nr text;
create unique index if not exists wyceny_sklep_nr_key
  on wyceny (sklep_nr) where sklep_nr is not null;

-- Backfill istniejących zamówień sklepowych chronologicznie (S1 = najstarsze).
-- Idempotentne: numeruje tylko wiersze bez sklep_nr, startując od max(S)+1.
with base as (
  select coalesce(max(nullif(regexp_replace(sklep_nr, '\D', '', 'g'), '')::int), 0) as maxn
  from wyceny where sklep_nr is not null
), numbered as (
  select id, row_number() over (order by created_at, id) as rn
  from wyceny
  where source = 'shopify' and sklep_nr is null
)
update wyceny w
set sklep_nr = 'S' || (n.rn + b.maxn)
from numbered n, base b
where w.id = n.id;
