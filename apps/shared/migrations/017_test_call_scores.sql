-- 017: Panel Test (kokpit umowy 30 dni handlowca) — oceny AI transkrypcji
-- rozmów. Jedna ocena na wiersz "Log zmian"; log_id UNIQUE robi z ponownego
-- uruchomienia oceniania no-op zamiast dubli (ON CONFLICT DO NOTHING).
CREATE TABLE IF NOT EXISTS test_call_scores (
  id bigserial PRIMARY KEY,
  log_id text NOT NULL UNIQUE,
  telefon text,
  data_rozmowy timestamptz,
  czas_trwania_s integer,
  -- {otwarcie,potrzeba,wartosc,obiekcje,next_step} 1-5; null = kryterium nie
  -- wystąpiło w rozmowie (np. brak obiekcji) i nie wchodzi do średnich.
  scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- {rabat_bez_zobowiazania,odeslanie_do_konkurencji,brak_next_stepu,
  --  kapitulacja_po_obiekcji,zapytam_kolegi} boolean
  flagi jsonb NOT NULL DEFAULT '{}'::jsonb,
  pominieta boolean NOT NULL DEFAULT false,
  cytat text,
  rada text,
  podsumowanie text,
  model text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS test_call_scores_data_idx ON test_call_scores (data_rozmowy DESC);
