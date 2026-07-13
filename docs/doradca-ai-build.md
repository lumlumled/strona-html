# Build: AI-doradca LumLum (osobny build, konsumuje panel statystyk)

> To jest **osobny build** od panelu statystyk. Panel (`docs/statystyki-doradca-build-guardrails.md`) wystawia dane; ten doradca je konsumuje. Zależność twarda: **doradca rusza dopiero gdy działa `GET /api/stats/snapshot`** (i najlepiej grupy A–D). Do tego czasu można scaffoldować pod kontrakt, ale nie ma czego testować.

> **STATUS (2026-07-13): ODŁOŻONE — na razie doradca żyje jako CZAT** (ten czat / claude.ai z promptem Fable). Antoni myśli nad docelową formą w hubie. Ten plik = spec na przyszłość, buildu nie zaczynamy teraz.

## Czym jest

Czat w hubie (panel `/doradca` albo bok-w-bok z panelem statystyk), z którym Antoni rozmawia o firmie. Widzi żywe dane przez panel statystyk, odpowiada od razu, **idzie w głąb** i mówi rzeczy, których sam sobie nie powie (ślepe plamy, niewygodne prawdy). Nie jest raportem — jest doradcą.

## Kontrakt z panelem (jedyne wejście danych)

- `GET /api/stats/snapshot` → bogaty rollup + `alerts[]` (KPI, pipeline+top martwe wyceny, outreach, leady, paid gdy gotowe). Główne źródło — wstrzykiwane do promptu co turę.
- `GET /api/stats/{A..F}` z parametrami scope (from/to, owner, platform, source, level) → doszczegółowienie.
- read-only, stabilny JSON. Doradca NIE dotyka bazy ani Zernio bezpośrednio.

## Kształt techniczny

- **Endpoint** `POST /api/doradca/chat` (w hubie, za auth). Wejście: wiadomość + historia. Wyjście: **streaming SSE**.
- **Model:** Anthropic API (`ANTHROPIC_API_KEY` już jest). Czat = szybki model (Fable / Sonnet); Opus tylko na jawne „zrób głęboką analizę".
- **System prompt = CAŁA treść `docs/fable-doradca-lumlum.md` VERBATIM.** To mózg (charakter, strategia, cele, twarde zasady, sekcja 9 „tryb głęboki").
- **Kontekst co turę:** wynik `GET /api/stats/snapshot` doklejany do promptu → 80% odpowiedzi bez round-tripu = uczucie „od razu".
- **Narzędzie = jedno:** `stats(group, params)` → mapuje na `/api/stats/*`, read-only, limit wyniku.
- **WYMÓG GŁĘBI:** pozwól na **wiele kolejnych wywołań `stats()` w jednej odpowiedzi** (snapshot → anomalia → dociągnij grupę → skoreluj → odpowiedz). Sekcja 9 promptu (drugie dno, korelacje, ślepe plamy) tego wymaga. Płytki jednostrzałowiec = porażka.
- **Streaming** — token po tokenie.
- **Dyktowanie (głos) — wymóg.** Antoni woli MÓWIĆ niż pisać (jego wiadomości i tak są dyktowane). Na teraz (wersja-czat): dyktowanie w apce claude.ai / systemowe. W wersji w hubie: mikrofon w polu czatu → speech-to-text (Web Speech API na start, Whisper gdy trzeba lepiej po polsku) → wstawia tekst do inputu (edytowalny przed wysłaniem, bo dyktowanie miewa literówki). Opcjonalnie odpowiedź czytana głosem (TTS) — miły dodatek, nie v0.

## Pamięć i proaktywność (accountability — sekcja 9 promptu pkt 6 tego wymaga)

- Tabela `doradca_memory`: ustalenia, obietnice Antoniego, rzeczy odkładane, wątki. Doradca czyta na starcie rozmowy, dopisuje po niej. To zmienia go z „obcego co turę" w partnera, który pilnuje.
- Proaktywność (cron): rano „plan na dziś" + raz w tygodniu „Co pomijasz" (1 ślepa plama + 1 niewygodna prawda + 1 odkładana rzecz) → push. Można po v0, ale schemat pamięci zaprojektuj od razu.

## Kolejność

- **v0:** endpoint czatu + snapshot w kontekście + narzędzie `stats()` z głębią + streaming + prompt Fable. Ruszaj, gdy panel wystawia snapshot + A–D.
- **v1:** pamięć `doradca_memory` (accountability).
- **v2:** proaktywny push (plan na dziś, „Co pomijasz").

## Bezpieczeństwo

read-only na danych, limity rozmiaru, auth huba, żadnego surowego SQL z modelu, sekrety po stronie serwera (klucz Anthropic nie idzie do frontu).

## Definition of done (v0)

- Piszę w hubie „nie wiem co robić" → doradca w <~2s zaczyna streamować, opiera się na realnym snapshocie, kończy jedną konkretną akcją.
- Pytam „która reklama robi kasę" (gdy E gotowe) / „które wyceny 5k+ wiszą najdłużej" → sięga `stats()` po właściwą grupę, nie zgaduje.
- Sam dorzuca „a czego nie pytasz, a powinieneś: …" (sekcja 9 promptu działa).
