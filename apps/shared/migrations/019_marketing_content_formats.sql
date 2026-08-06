-- Taksonomia formatów kreacji LumLum (od SMM, doc "Formaty LumLum" 06.08.2026).
-- Źródło prawdy dla klasyfikatora: skrypt scripts/tiktok-video-base.js wczytuje
-- aktywne formaty i wstrzykuje je do promptu Opusa, który przypisuje każdą rolkę
-- do jednego slugu -> marketing_video_analysis.format. Edytowalne bez zmian w kodzie.
-- Re-runnable (upsert po slug).
create table if not exists marketing_content_formats (
  slug         text primary key,
  name         text not null,
  description  text,
  cues         text,           -- sygnały rozpoznawcze dla klasyfikatora
  example_note text,           -- przykład z doca (co widać + zasięg)
  sort_order   int default 0,
  active       boolean default true,
  updated_at   timestamptz default now()
);

insert into marketing_content_formats (slug, name, description, cues, example_note, sort_order) values
('obiekt_grafika', '(obiekt) + grafika',
 'Osoba trzyma w rękach produkt (taśma LED, sterownik, szpula) a obok/nad nim pojawia się GRAFIKA lub wizualizacja efektu, często ze strzałką.',
 'produkt w dłoniach + nakładka graficzna/render efektu + ew. odręczna strzałka',
 'szpula taśmy w ręku + strzałka do wklejki ogrodu; ~75K', 10),
('obiekt_fake_comment', '(obiekt) + fake comment',
 'Trzyma produkt w rękach + u góry wklejony FAŁSZYWY komentarz/DM widza, potem nagranie z efektem.',
 'produkt w dłoniach + dymek komentarza/pytanie widza jako nakładka na górze',
 'sterownik LumLum w rękach + komentarz "laurita: A jak takie ledy...?"; ~100K', 20),
('talking_head_popup', 'talking head + pop up grafika/film',
 'Gadająca głowa, a NAD/OBOK niej wyskakuje grafika lub film z efektem (bez produktu w ręku; grafika może być od początku).',
 'osoba mówi + wklejka grafiki/filmu w rogu/nad głową; produkt NIE w dłoniach',
 '"taki efekt na ścianie" 282K; "myślisz że montaż" 95K', 30),
('reakcja', 'reakcja',
 'Ogląda odtwarzany film BEZ tekstu na nim, potem mówi jak to zrobić itd.',
 'osoba + wklejka odtwarzanej rolki BEZ napisów na niej',
 'ogląda render sypialni na telefonie; ~22K', 40),
('reakcja_text_hook', 'reakcja + text hook',
 'Jak reakcja, ale na odtwarzanym filmie JEST tekst-hook (np. "JAK TO ZROBIĆ? ILE TO KOSZTUJE?").',
 'osoba + wklejka odtwarzanej rolki Z napisem-hookiem na niej',
 '"JAK TO ZROBIĆ? ILE TO KOSZTUJE?" 558K', 50),
('start_stop', 'start stop',
 'Ogląda rolkę, zatrzymuje ją i wtrąca komentarz, potem leci dalej (powtarzalnie, ocenianie).',
 'reakcja na odtwarzaną rolkę + pauzy + komentarze + ew. czerwony X / ocena',
 '"mm nieoptymalne", OŚWIETLENIE LEVEL 2 z czerwonym X', 60),
('porownanie', 'porównanie',
 'Zestawienie X vs Y (np. "0zł vs 300zł vs 1300zł", "z jedną lampką"), obok siebie lub kolejno; napisy porównawcze.',
 'układ/tekst "X vs Y", warianty obok siebie, "małe vs duże", warianty cenowe',
 '"Z JEDNĄ LAMPKĄ" 124K; "0ZŁ VS 300ZŁ VS 1300ZŁ" 70K', 70),
('green_screen', 'green screen',
 'Głowa/sylwetka wycięta (green screen) na pełnoekranowym tle filmu lub zdjęcia.',
 'osoba wkomponowana na całoekranowe tło (b-roll/render), zwykle mała postać na dole',
 '"jak to zrobić" 676K; "jakiegoś specjalnego elektryka" 393K', 80),
('voiceover_broll', 'voiceover + b-roll',
 'Bez osoby na ekranie; leci b-roll (wnętrza/efekt) z GŁOSEM lektora.',
 'brak twarzy, materiał wideo wnętrz + narracja głosowa, mało napisów',
 'wnętrze nocne "TAKI EFEKT" 88K', 90),
('napis_broll', 'napis + b-roll',
 'Bez osoby i BEZ głosu; tylko napisy na b-rollu (Antek nic nie mówi).',
 'brak twarzy, brak mowy (muzyka), tekst na ekranie + b-roll',
 'schody z ledami "pov: wkońcu zamontowaliście..." 159K', 100)
on conflict (slug) do update set
  name = excluded.name, description = excluded.description, cues = excluded.cues,
  example_note = excluded.example_note, sort_order = excluded.sort_order, updated_at = now();

-- Odśwież cache schematu PostgREST (Supabase) — nowa tabela musi być widoczna
-- dla klienta supabase-js (db.from), inaczej "table not found in schema cache".
notify pgrst, 'reload schema';
