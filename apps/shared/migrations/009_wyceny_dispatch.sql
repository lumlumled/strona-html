-- 009: znacznik "etykieta wydrukowana" + zlecenie odbioru kuriera (ShipX
-- dispatch_orders) w panelu Fulfillment. Plan: docs/plan-furgonetka-jutro.md §3.
--
-- label_printed_at    = pierwsze kliknięcie "Drukuj etykietę" w panelu.
-- dispatch_order_id   = ID zlecenia odbioru ShipX, którym przesyłka ma
--                       odjechać; NULL = kurier jeszcze nie zamówiony.
-- dispatch_ordered_at = kiedy zlecenie utworzono; idempotencja "RAZ dziennie"
--                       liczona po dacie warszawskiej tego znacznika.
--
-- Additive i nullable - worker/pipeline ich nie czyta. Idempotentne.
alter table wyceny_shipments add column if not exists label_printed_at timestamptz;
alter table wyceny_shipments add column if not exists dispatch_order_id text;
alter table wyceny_shipments add column if not exists dispatch_ordered_at timestamptz;
