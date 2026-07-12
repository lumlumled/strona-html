-- Watchdog "temat ucieka" (docs/plan-watchdog-feedback.md): obietnice z
-- wiadomości alertuje dispatcher watchdoga — kom_commitments dostaje stan
-- alertu (ten sam wzorzec co feedback_watch.alert_text/alerted_at).
alter table kom_commitments add column if not exists alert_text text;
alter table kom_commitments add column if not exists alerted_at timestamptz;
