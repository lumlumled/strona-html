-- Wyceny 2.0 — fundament danych (docs/plan-wyceny-migracja.md, Etap 0).
-- Schemat = kolumny arkusza CRM_CASES przełożone na typy Postgresa;
-- wszystko, czego pipeline nie używa (vat_*, baselinker, kolumny robocze
-- Make), ląduje w `legacy` jsonb — nic z arkusza nie ginie, a tabela nie
-- dziedziczy 76 kolumn.

create table if not exists wyceny (
  id integer primary key,                    -- format arkusza (1503…), sekwencja niżej
  typ text not null default 'WYCENA',        -- WYCENA | ZAMÓWIENIE | NOTATKA
  status text not null default 'Open',       -- Open | Waiting for payment | Fulfilled | Closed | Stracone
  owner text not null default 'Antoni',
  lead_id text,                              -- spięcie z "Leady B2C"."ID Leada" (nullable)
  source text not null default 'import',     -- import | panel | quick-add | form | shopify
  shopify_order_id text,                     -- dedupe zamówień ze sklepu (gid lub legacyResourceId)
  shopify_order_name text,                   -- np. #111062

  imie_nazwisko text,
  telefon_e164 text,
  telefon_digits text,
  email text,
  adres text,
  opis_zamowienia text,
  komentarz text,                            -- "Komentarz" z arkusza Lorenzo
  dane_do_faktury text,
  partner text,
  prowizja_status text,

  items jsonb not null default '[]'::jsonb,  -- [{name, SKU, quantity, unit, price, VAT, image_url}]
  kwota_proponowana_brutto numeric,
  kwota_sprzedazy_brutto numeric,
  -- Rabat NIE jest osobną kolumną: discount = kwota_proponowana_brutto −
  -- Σ(price×quantity), dokładnie jak w webhooku GET Make ("Zniżka kwota").
  rabat24h_kwota numeric,
  rabat24h_wazny_do timestamptz,

  -- formularz (jednorazowy — patrz plan)
  form_status text not null default 'NEW',   -- NEW | SUBMITTED
  form_submitted_at timestamptz,
  form_token text,                           -- losowy token w linku (?id=…&t=…)

  -- dane z submitu formularza
  payment_method text,                       -- COD | transfer | FREE | shopify_payments…
  delivery_method text,                      -- INPOST_LOCKER | COURIER
  punkt_odbioru text,
  punkt_odbioru_adres text,
  first_name text,
  last_name text,
  ship_street text,
  ship_house_no text,
  ship_flat_no text,
  ship_postcode text,
  ship_city text,
  ship_country text,
  invoice_company_nip text,
  invoice_company_name text,
  invoice_dane jsonb,                        -- pełne pola invoice_* z formularza

  -- maszyna stanów pipeline'u
  process_stage text not null default 'NEW',
  paid boolean not null default false,
  paid_at timestamptz,
  cod_status text,
  lock_token text,
  lock_expires_at timestamptz,
  worker_last_error text,
  worker_last_run_at timestamptz,

  history_log text,                          -- log z arkusza (kompatybilność importu)
  legacy jsonb,                              -- reszta kolumn arkusza 1:1
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists wyceny_telefon_digits_idx on wyceny (telefon_digits);
create index if not exists wyceny_email_idx on wyceny (email);
create index if not exists wyceny_process_stage_idx on wyceny (process_stage);
create unique index if not exists wyceny_shopify_order_idx on wyceny (shopify_order_id) where shopify_order_id is not null;

-- Kontynuacja numeracji arkusza: setval po imporcie (skrypt importu).
create sequence if not exists wyceny_id_seq;

-- Nowe ID z panelu (supabase-js nie umie nextval bezpośrednio -> rpc).
create or replace function wyceny_next_id() returns integer
language sql as $$ select nextval('wyceny_id_seq')::integer $$;

create table if not exists wyceny_shipments (
  id bigserial primary key,
  wycena_id integer not null references wyceny(id) on delete cascade,
  provider text not null default 'shipx',    -- shipx | furgonetka
  kind text not null default 'order',        -- order | reship
  shipment_id text,                          -- ID po stronie providera
  service text,                              -- inpost_locker_standard | inpost_courier_standard | …
  status text not null default 'created',    -- created | confirmed | sent | delivered | error
  raw_status text,                           -- ostatni surowy status trackingu (jawne mapowanie!)
  tracking_number text,
  label_url text,
  target_point text,                         -- paczkomat
  cod_amount numeric,
  insurance_amount numeric,
  nadana_at timestamptz,                     -- ręcznie z panelu Fulfillment albo z trackingu
  delivered_at timestamptz,
  checked_at timestamptz,                    -- ostatni odczyt trackingu przez workera
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists wyceny_shipments_wycena_idx on wyceny_shipments (wycena_id);
create index if not exists wyceny_shipments_tracking_idx on wyceny_shipments (tracking_number);

create table if not exists wyceny_invoices (
  id bigserial primary key,
  wycena_id integer not null references wyceny(id) on delete cascade,
  kind text not null default 'proforma',     -- proforma | vat
  infakt_uuid text,
  task_reference_number text,                -- async API inFakt
  number text,                               -- numer faktury po wystawieniu
  status text,                               -- pending | issued | sent | paid | deleted | error
  gross numeric,
  paid_at timestamptz,
  ksef_at timestamptz,
  pdf_url text,
  quick_payment_url text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists wyceny_invoices_wycena_idx on wyceny_invoices (wycena_id);
create index if not exists wyceny_invoices_uuid_idx on wyceny_invoices (infakt_uuid);

-- Log zdarzeń pipeline'u: każdy krok, każdy odczyt trackingu, każdy błąd.
-- Panel pokazuje surową historię — diagnoza rozjazdów bez grzebania w Make.
create table if not exists wyceny_events (
  id bigserial primary key,
  wycena_id integer references wyceny(id) on delete cascade,
  kind text not null,                        -- np. form.submitted, shipment.created, tracking.read, invoice.paid, pipeline.error
  payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists wyceny_events_wycena_idx on wyceny_events (wycena_id, created_at desc);

-- Cennik SKU — jedyne źródło prawdy cen (zakładka SKU arkusza CRM 2.0).
-- `koszty` (ceny zakupu/marże) NIGDY nie wychodzi poza endpointy ownera —
-- ta sama zasada co w scripts/kb-import-sku.js.
create table if not exists sku_cennik (
  sku text primary key,
  nazwa text not null,
  price_brutto numeric,
  vat integer not null default 23,
  unit text default 'szt',
  weight_kg numeric,
  image_url text,
  shopify_id text,
  koszty jsonb,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);
