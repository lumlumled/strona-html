-- ── Intencja wyceny na wątku (bramka do listy Organic w CRM) ────────────────
-- Decyzja Antoniego 2026-07-29: do listy "Organic" (apps/crm) mają wchodzić
-- rozmowy z Messengera/WhatsAppa TYLKO gdy zmierzają do wyceny (konkretny
-- produkt pod projekt, pytanie o wykończenie/montaż), a nie luźne "ile kosztuje
-- ten sterownik". Sam triage='inbox' jest za szeroki (obejmuje każdą trwającą
-- rozmowę i każdy sygnał zainteresowania), więc dokładamy węższy sygnał, który
-- liczy ten sam klasyfikator triage (apps/komunikator/server/triage.js).
--
-- "Lepki": raz ustawiony na true zostaje (applyTriage nigdy nie cofa do false),
-- żeby późniejsze "ok, dziękuję" nie odbierało wątkowi kwalifikacji.
-- Domyślnie false → do czasu backfillu żaden istniejący wątek nie pojawi się
-- w Organic (zgodne z prośbą "wywalmy messenger/sms/mail"); nowe kwalifikujące
-- się rozmowy dochodzą same. Backfill retro: scripts/backfill-wycena-intent.js.
alter table kom_threads add column if not exists wycena_intent boolean not null default false;

create index if not exists kom_threads_wycena_intent_idx
  on kom_threads (wycena_intent) where wycena_intent;
