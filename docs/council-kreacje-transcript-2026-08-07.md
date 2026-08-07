# Rada AI (LLM Council) — architektura panelu /kreacje v2

Data: 2026-08-07 (noc). Zwołana na prośbę Antoniego („kilka rund eksperckich, przemyśl poważnie, nic nie commituj").

## Pytanie (po sformułowaniu)

Docelowa architektura panelu /kreacje (Content Intelligence LumLum: korelacja treść→sprzedaż, planowanie contentu pod przychód; TikTok+IG+FB; pieniądze tygodniowo bez atrybucji per-rolka). Nowe wymagania: presety czasowe 4/8 tyg. + własny zakres dat od–do; eksplorator „które rolki zrobiły jaki zasięg w wybranym przedziale" z pełnymi statystykami na TT/IG/FB. Ograniczenia: views=lifetime przypisywane do tygodnia publikacji; FB bez per-post (crossposty), ale najsilniejsza korelacja z pieniędzmi (+0,50 lag1); jeden plik vanilla JS+SVG; użytkownicy: Antoni + SMM.

**Aktualizacja w trakcie rady (od Antoniego):** WSZYSTKIE fazy planu danych będą zrealizowane — IG formaty już w bazie (twin-match); Meta Graph API dowiezie żywe per-post insighty IG (zasięg, saved, watch time, retencja) + świeże dzienne serie FB i IG (cotygodniowy cron); potem split per platforma wszędzie, markery rolek na timeline, wymiar hooka jako ranking.

## Odpowiedzi doradców

### Kontrarianin (anonimizacja: D)

Fatalna wada jest w samym środku zamówienia: właściciel chce przedziałów dat na metryce, która przedziałów nie ma. „Które rolki zrobiły jaki zasięg w wybranym przedziale" to pytanie, na które dane odpowiadają tylko dla ~25 rolek ze snapshotami od 11.07. Dla pozostałych 500+ każda odpowiedź będzie kłamstwem ubranym w UI. Jeśli zbudujecie custom od–do i cicho podstawicie lifetime views, panel „uczciwości" stanie się maszyną do samooszukiwania — i to gorszą niż brak panelu, bo z aurą rygoru (placebo-testy obok sfałszowanej osi X!). Jedyna uczciwa wersja: „rolki OPUBLIKOWANE w przedziale, views = całe życie" z twardym banerem, a prawdziwy „zasięg w oknie" wyłącznie tam, gdzie są snapshoty. Wszystko inne to teatr.

Druga rzecz, którą wszyscy omijają: pieniądze robi FB (+0,50, największy zasięg), a eksplorator budujecie dla TikToka i IG, bo tam są dane. Optymalizujecie latarnię, nie zgubione klucze. Karta rolki z retencją i saved to zabawka — sygnał sprzedażowy siedzi w kanale, gdzie macie tylko dzienny agregat.

Trzecia: custom zakres dat przy 26 tygodniach danych, ~10 formatach i sprzedaży zdominowanej przez telefon (jedna awaria przekierowania = tydzień szumu) to fabryka p-hackingu. Właściciel przesunie suwak, aż korelacja potwierdzi jego przekonanie o formacie. Presety 4/8/12/26 są ograniczeniem CELOWYM — dowolne od–do je znosi. Skoro musi być custom, to z automatycznym ostrzeżeniem przy n<8 tygodni i bez werdyktów formatów w takim oknie (4 tygodnie = 4 punkty danych; „korelacja" z 4 punktów to horoskop).

NIE budować: retencji w werdyktach (koreluje z views, nie ze sprzedażą — dopóki nie udowodnicie inaczej), rankingów per-rolka sugerujących atrybucję, niczego dla FB poza agregatem tygodniowym. „Jak najwięcej danych o rolkach" to wprost recepta na dashboard, który ogląda się zamiast nagrywać.

### Myśliciel od Pierwszych Zasad (anonimizacja: C)

Zacznijmy od pytania, które nie pada: **jaką decyzję ten panel ma podejmować?** Odpowiedź brzmi: „co produkować w przyszłym tygodniu". To decyzja na poziomie FORMATU, nie rolki i nie przedziału dat. Wszystko, co nie karmi tej decyzji, to dekoracja.

(a) „Konflikt" lifetime vs okno to pseudoproblem — jeśli zmienisz semantykę. Nie pytaj „ile wyświetleń było w przedziale" (nie wiesz i nie będziesz wiedział). Pytaj „które rolki OPUBLIKOWANO w przedziale i ile łącznie zarobiły życia". To uczciwe, spójne i wystarczające do decyzji. Custom zakres = filtr po dacie publikacji, z etykietą „staty = całe życie rolki". Zero udawania.

(b) Zapytaj, PO CO Antoni chce custom zakresu. Prawie na pewno: „co się działo wokół zdarzenia X" (awaria telefonu, hit, festiwal). To potrzeba adnotacji/nakładki zdarzeń — już ją macie — nie potrzeba nowej maszynerii okien. Eksplorator rolek: ranking po dacie publikacji + lifetime staty, koniec. Dla FB pokażcie prawdę: „brak danych per-post, oto agregat dzienny strony" — pusta półka z wyjaśnieniem jest cenniejsza niż proxy-fikcja.

(c) Największa nieuczciwość panelu jest gdzie indziej: kanał z NAJWIĘKSZYM zasięgiem i najsilniejszą korelacją z pieniędzmi (FB, +0,50) jest niewidzialny per-post, a panel precyzyjnie mierzy TikToka, który może być ogonem. Ryzyko: optymalizujecie to, co mierzalne, nie to, co zarabia. Retencja IG to najlepszy nadchodzący sygnał — bo crossposty FB to te same kreacje. Retencja IG jako proxy jakości kreacji NA FB — to wpleciecie w werdykt formatu, nie w kartę rolki.

(d) Hero = werdykt formatów + timeline. Eksplorator = drugorzędny katalog.

(e) Nie budować: dziennych snapshotów wstecz, interpolacji views „w oknie", per-rolkowej atrybucji w przebraniu. Każda z nich to precyzyjna odpowiedź na złe pytanie.

### Ekspansjonista (anonimizacja: E)

Wszyscy patrzą na konflikt lifetime-vs-przedział jako problem. To jest brama do czegoś większego: od 11.07 macie dzienne snapshoty nowych rolek — czyli KAŻDA rolka od teraz ma prawdziwą krzywą życia. Nie łatajcie archiwum. Zbudujcie eksplorator na delta-views w przedziale dla nowych rolek, a stare oznaczcie „archiwum lifetime" i tyle. Za 12 tygodni macie zbiór danych, jakiego nie ma 99% firm w tym segmencie — realne krzywe zasięgu per rolka skorelowane z tygodniami pieniędzy.

Największa niedowartościowana rzecz: Facebook. Najsilniejsza korelacja z przychodem (+0,50), największy zasięg — i wszyscy go spisują na straty, bo „nie ma per-post". Ale to CROSSPOSTY. Metadane TikToka (format, hook, transkrypcja) to SĄ metadane rolek FB. Zróbcie widok „co poszło na FB w tym przedziale" z kart TikToka + dzienny agregat page-level jako tło. Korelacja dzień-publikacji-formatu ↔ skok agregatu FB to quasi-per-post za darmo.

Retencja i watch time z IG to nie „dodatkowa metryka na kartę rolki" — to leading indicator. Pieniądze przychodzą z lagiem tygodnia; retencja jest znana po 48h. Wpleciona w werdykt formatu daje wam prognozę zanim kasa spłynie: „ten format ma retencję top-kwartyla → spodziewaj się pieniędzy za tydzień". To zmienia panel z lusterka wstecznego w przednią szybę.

I docelowy skok: panel dziś mierzy, a powinien BRIEFOWAĆ. Macie formaty, hooki, streszczenia wizji AI, werdykty. Przycisk „wygeneruj brief na przyszły tydzień" (top 3 formaty + przykładowe hooki z najlepszych rolek) zamienia narzędzie analityczne w maszynę produkcyjną dla SMM-a. To jest właściwe „hero" hierarchii: werdykt → brief, reszta to dowody.

Czego nie budować? Niczego, co poprawia pomiar przeszłości kosztem pętli decyzja→produkcja→pomiar. Tam jest 100k+.

### Outsider (anonimizacja: A)

Patrzę na ten panel jak nowy social media manager pierwszego dnia — i jestem zgubiony w trzech miejscach.

1. „zł/1000 wyśw." to kłamstwo etykiety. Deklarujecie „bez udawania atrybucji per-rolka", a potem oś Y nazywa się jak twarde revenue-per-mille. Ja, nowy, przeczytam: „ta rolka zarobiła X zł". Nazwijcie to wprost: „szacunkowy udział w tygodniowym utargu" i dajcie przy osi jedno zdanie po ludzku. „Placebo", „tasowania" — bez tooltipa „co to znaczy i kiedy mam się martwić" to szum, który zignoruję albo źle zrozumiem.

2. Własny zakres dat bez ostrzeżenia = pułapka dnia pierwszego. Wybiorę „1–31 maja" i pomyślę, że widzę wyświetlenia Z MAJA. A dostanę rolki OPUBLIKOWANE w maju z wyświetleniami z całego życia. To musi być wypisane na stałe nad wynikami, nie w tooltipie.

3. Efekt latarni: panel każe mi optymalizować TikToka, bo tam są dane — a pieniądze robi Facebook. Jako nowy nawet nie zauważę, że FB istnieje. W eksploratorze FB musi mieć jawny kafel: „FB: brak danych per-rolka — patrz na tydzień strony", a hero panelu powinien odpowiadać na JEDNO pytanie: „co mam nakręcić w tym tygodniu i dlaczego" — dziś odpowiada na „co było", nie „co robić".

Retencję IG pokazujcie surowo (krzywa, sekundy), bez kolejnego autorskiego wskaźnika z fajną nazwą — mam już trzy metafory (konie/perły/wydmuszki) do nauczenia się. NIE budujcie: więcej testów uczciwości (rozumie je tylko Antoni), własnych composite scores, porównywarki okien. Najpierw słowniczek i etykiety — to najtańszy feature o największym wpływie na decyzje.

### Egzekutor (anonimizacja: B)

Poniedziałek rano robisz trzy rzeczy, w tej kolejności:

1. Zakres dat (pół dnia). Custom od–do to filtr po **dacie publikacji rolki**, koniec dyskusji. Nie próbuj dzielić lifetime views na dni — nie masz danych i nie będziesz miał. Rolka opublikowana w przedziale = wchodzi z całym lifetime. Jeden baner: „Wyświetlenia = całe życie rolek opublikowanych w tym oknie". Presety 4/8 to ten sam parametr `weeks`, który już masz. To jest robota na jedną sesję, nie projekt.

2. Eksplorator (jedna sesja). Masz już katalog rolek z kartami — eksplorator to TEN SAM komponent + filtr dat + sortowanie po views + suma na górze. Nie buduj nowego widoku. FB: nie masz per-post i nie będziesz miał — pokaż obok listy pasek „zasięg strony FB w tym oknie: X" z danych dziennych i przestań kombinować.

3. Token Meta (blokada nie po Twojej stronie). Cały punkt o retencji jest teoretyzowaniem, dopóki Antoni nie da tokena. Kod czeka gotowy od migracji 021. Pierwsza czynność: napisać Antoniemu „daj token dziś, bo retencja IG leży martwa". Dopiero po backfillu dokładasz JEDEN wiersz do karty rolki (retencja/saved/watch time) — żadnych nowych werdyktów formatów, zanim nie zobaczysz realnych danych na 20 rolkach.

Hierarchia: eksplorator na górę — to o niego prosił właściciel, a kwadrant zjeżdża niżej. Właściciel głosuje wymaganiami.

NIE buduj: interpolacji dziennej z lifetime, „szacowanego zasięgu FB per-rolka", nowych wykresów SVG, per-day timeline dla 25 rolek z snapshotami.

Test końcowy: SMM otwiera panel w poniedziałek i w 3 minuty wie, co nagrać. Wszystko, co temu nie służy — wycinasz.

## Recenzje wzajemne (anonimizacja: A=Outsider, B=Egzekutor, C=Pierwsze Zasady, D=Kontrarianin, E=Ekspansjonista)

### Recenzja 1 (soczewka Kontrarianina)

Najsilniejsza: E — crossposty jako darmowe metadane FB to jedyny pomysł realnie atakujący paradoks „pieniądze na FB, dane na TT"; delta-views rozwiązuje lifetime-problem zamiast go banerować. Największa ślepa plamka: D — zakazy zakładają, że dane nie przyjdą, a przyjdą; broni się tylko ostrzeżenie o p-hackingu. Wszyscy przegapili: higienę strony pieniędzy (szoki egzogenne — awaria telefonu, posty bez opisów — flagować w SERII pieniędzy, nie tylko na osi), wersjonowanie metodologii przy przejściu lifetime→okna, backtest hipotezy retencja→pieniądze zanim trafi do briefu.

### Recenzja 2 (soczewka Pierwszych Zasad)

Najsilniejsza: E — projektuje pod stan docelowy; „mierzy→briefuje" domyka pętlę produkcyjną. Ślepa plamka: D — projektuje klatkę pod wygasające ograniczenie (zachować guard n<8). Zabrakło wszystkim: pętli walidacji panelu (dziennik decyzji: werdykt → co nakręcono → co się stało), jawnej świeżości danych per źródło (cron może cicho paść), flagowania szoków po stronie pieniędzy.

### Recenzja 3 (soczewka Ekspansjonisty)

Najsilniejsza: E — ograniczenia jako bramy; crosspost-mapping = największa dźwignia. Ślepa plamka: D — zamienia tymczasowy stan danych w permanentną doktrynę. Nikt nie zauważył: (a) mostu organic→paid — Meta CAPI już działa, zwycięskie kreacje = kandydaci do płatnej amplifikacji; (b) przejścia z retrospektywnej korelacji na PROSPEKTYWNE EKSPERYMENTY („format tygodnia" jako zaplanowany test) — jedyne realne lekarstwo na p-hacking.

### Recenzja 4 (soczewka Outsidera)

Najsilniejsza: C — zaczyna od decyzji (format, nie rolka), rozbraja konflikt semantycznie, przeżywa aktualizację kontekstu bez poprawek. Ślepa plamka: E — „przednia szyba" bez testu, czy retencja→pieniądze istnieje; auto-brief na 26 tyg. danych to fabryka p-hackingu z przyciskiem; ambicja słuszna, guardraili zero. Nikt nie widział: starzenia się lifetime views TikToka (snapshot z dnia scrape'u — potrzebna kadencja re-scrape'u i stempel „stan z dnia X"), szoków egzogennych w pieniądzach, walidacji prospektywnej.

### Recenzja 5 (soczewka Egzekutora)

Najsilniejsza: E (aktualizacja potwierdza zakłady; crosspost-mapping ROZWIĄZUJE latarnię) — ale kolejność wdrożenia brać z B (jedyny plan shipowalny w tydzień). Ślepa plamka: D (lista zakazów unieważniona; zachować guard n<8). Wszyscy przeoczyli: jakość osi PIENIĘDZY — w presecie 4 tyg. obejmującym sierpień z awarią telefonu każda korelacja format→sprzedaż jest śmieciem; potrzebne flagi „tydzień skażony" + znacznik świeżości ETL.

## Werdykt Przewodniczącego

[pełna treść — patrz raport HTML council-kreacje-report-2026-08-07.html; skrót:]

**Zgoda rady:** (1) zakres dat = filtr po dacie publikacji, views lifetime z jawną etykietą, zero interpolacji; (2) hero = decyzja „co nagrać", nie archiwum; (3) efekt latarni FB jest realny; (4) guard n<8 tyg. zostaje; (5) zero fabrykowanych liczb; (6) peer review 4/5 wskazało Ekspansjonistę jako najsilniejszego, Kontrarianina jako ślepą plamkę (zakazy pod wygasające ograniczenie).

**Spory rozstrzygnięte:** custom okno służy EKSPLORACJI, werdykty tylko z presetów; retencja najpierw surowo na karcie → backtest → dopiero werdykty; kolejność budowy ≠ kolejność na stronie (eksplorator budowany pierwszy, hero zostaje werdykt); FB dostaje widok crosspostowy (metadane TT/IG jako metadane kreacji FB + dzienny agregat jako tło; liczb per-post NIGDY); brief tak, ale jako szkic zatwierdzany przez człowieka + dziennik decyzji.

**Ślepe punkty złapane przez recenzje:** higiena serii pieniędzy (skażone tygodnie flagowane w DANYCH, wykluczane z korelacji), starzenie się lifetime views TT (stempel „stan z dnia" + kadencja re-scrape'u), dziennik decyzji (pętla walidacji panelu), eksperymenty prospektywne, most organic→paid (CAPI), wersjonowanie metodologii v1/v2.

**Pierwsza rzecz:** zaflagować skażone tygodnie w serii pieniędzy i przeliczyć korelacje z ich pominięciem — PRZED budową nowych sekcji (test fundamentu). Równolegle: token Meta (dzienne serie nie backfillują się — każdy tydzień zwłoki to dane stracone na zawsze).
