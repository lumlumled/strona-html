-- Reguły wyciszeń: dopasowanie 'contains' obok 'exact' — jedna reguła
-- "make.com" wycisza noreply@eu1.make.com, billing@make.com itd.
-- (Antoni 2026-07-11: Make/InPost/podobne automaty mają omijać panel
-- i być oznaczane jako przeczytane w Gmailu.)
alter table kom_triage_rules add column if not exists match_type text not null default 'exact'
  check (match_type in ('exact','contains'));
