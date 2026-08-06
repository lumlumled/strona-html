-- Okladka (miniatura) rolki do panelu bazy filmu. Zrodlo NIEZALEZNE od Apify
-- (linki coverow Apify wygasaja, a saldo Apify bywa puste) - bierzemy kadr, ktory
-- i tak wycinamy pod analize wizualna, i wrzucamy do PUBLICZNEGO bucketa
-- 'marketing-media'. cover_url = publiczny URL do <img> na panelu (widac ktora to
-- rolka obok opisu/formatu); cover_path = sciezka w buckecie (podmiana/kasowanie).
alter table marketing_video_analysis add column if not exists cover_path text;
alter table marketing_video_analysis add column if not exists cover_url  text;
