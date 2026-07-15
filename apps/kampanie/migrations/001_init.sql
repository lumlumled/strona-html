-- Panel Kampanie (docs/plan-kampanie.md): mądra wysyłka SMS/mail do starych
-- otwartych wycen. Kampania = brief Antoniego + interpretacja AI + populacja
-- zamrożona w kampanie_odbiorcy (snapshot kontekstu per odbiorca — treść ma
-- odpowiadać temu, co klient faktycznie dostał, nawet gdy wycena się zmieni).

create table if not exists kampanie (
  id bigserial primary key,
  nazwa text not null,
  kanal text not null default 'sms' check (kanal in ('sms','email')),
  brief text not null,                          -- surowy opis Antoniego (dyktowany)
  szablon text,                                 -- opcjonalna wklejona przykładowa wiadomość
  interpretacja jsonb,                          -- co AI zrozumiało z briefu (filtr, instrukcje)
  korekty jsonb not null default '{"pary":[],"reguly":[]}'::jsonb, -- pamięć uczenia: edycje próbek + reguły
  nadawca text not null default 'lorenzo',      -- app_users.name lowercase -> caller_id SMS / skrzynka mail
  owner text not null default 'Antoni',         -- adresat pushy (podsumowania, alerty, do-decyzji)
  filtr jsonb not null default '{}'::jsonb,     -- {min_wiek_dni, owner}
  limit_dzienny integer not null default 25,
  godzina_od integer not null default 9,
  godzina_do integer not null default 17,
  bez_polskich_znakow boolean not null default true,  -- GSM-7: 160 zn./segment zamiast 70
  max_segmenty integer not null default 2,
  proba_size integer not null default 8,
  status text not null default 'draft'
    check (status in ('draft','sampling','review','active','paused','done','archived')),
  szacunek jsonb,                               -- {odbiorcy, srednie_segmenty, koszt_pln, saldo}
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists kampanie_odbiorcy (
  id bigserial primary key,
  kampania_id bigint not null references kampanie(id) on delete cascade,
  wycena_id integer references wyceny(id) on delete set null,  -- najnowsza otwarta wycena telefonu
  wyceny_ids integer[] not null default '{}',   -- WSZYSTKIE otwarte wyceny telefonu (dedupe)
  lead_id text,
  telefon text not null,                        -- digits BEZ 48 (konwencja wyceny.telefon_digits)
  email text,
  imie text,                                    -- mianownik (z leada/wyceny) lub null
  kontekst jsonb not null,                      -- SNAPSHOT dla AI: imie, items, kwota, komentarz, wiek_dni…
  tresc text,                                   -- wygenerowana wiadomość (edytowalna do wysyłki)
  temat text,                                   -- tylko email
  segmenty integer,
  sample boolean not null default false,        -- próbka do przeglądu Antoniego
  status text not null default 'pending' check (status in
    ('pending','generated','approved','sent','failed','replied','closed','optout','skipped')),
  wyslano_at timestamptz,
  koszt numeric,                                -- z odpowiedzi Zadarmy
  blad text,
  retry_count integer not null default 0,
  odpowiedz text,                               -- ostatnia odpowiedź klienta (Etap 2)
  triage jsonb,                                 -- wynik AI-triage odpowiedzi (Etap 2)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kampania_id, telefon)
);
create index if not exists kampanie_odbiorcy_tel_idx on kampanie_odbiorcy (telefon);
create index if not exists kampanie_odbiorcy_status_idx on kampanie_odbiorcy (kampania_id, status);

-- Globalna lista "nie kontaktować SMS-em/mailem" — sprawdzana przy budowie
-- populacji i tuż przed każdą wysyłką (odpowiedź STOP w Etapie 2 też tu trafia).
create table if not exists kampanie_optout (
  telefon text primary key,                     -- digits bez 48
  powod text,
  zrodlo text,
  created_at timestamptz not null default now()
);
