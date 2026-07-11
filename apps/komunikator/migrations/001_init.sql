-- Komunikator (panel Wiadomości) — schemat początkowy.
-- Osobny świat od tabel CRM ("Leady B2C" itd.): prefiks kom_, snake_case.
-- Jedyny przyszły pomost do CRM to kom_customers.crm_lead_id (na razie nieużywany).
-- Pełny kontekst: docs/plan-komunikator.md §1.

create extension if not exists vector;

-- ── Klient ────────────────────────────────────────────────────────────────
create sequence if not exists kom_customer_seq start 10001;

create table if not exists kom_customers (
  id           uuid primary key default gen_random_uuid(),
  public_id    text unique not null default ('LL-' || nextval('kom_customer_seq')),
  display_name text,
  crm_lead_id  text,
  notes        text,
  -- Po scaleniu dwóch klientów przegrany rekord zostaje (odwracalność),
  -- wskazując zwycięzcę; wszystkie zapytania panelu filtrują merged_into is null.
  merged_into  uuid references kom_customers(id),
  created_at   timestamptz not null default now()
);

-- Tożsamości osobno (nie kolumny na kliencie): klient może mieć 2 telefony,
-- a unique(type,value) fizycznie uniemożliwia ciche podpięcie tego samego
-- numeru pod dwóch klientów — konflikt = propozycja scalenia, nigdy auto.
create table if not exists kom_customer_identities (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references kom_customers(id),
  type        text not null check (type in ('fb','ig','wa','phone','email')),
  value       text not null,
  source      text not null check (source in ('webhook','ai_extracted','manual')),
  confirmed   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (type, value)
);
create index if not exists kom_identities_customer on kom_customer_identities (customer_id);

-- ── Wątki i wiadomości ────────────────────────────────────────────────────
create table if not exists kom_threads (
  id                 uuid primary key default gen_random_uuid(),
  customer_id        uuid not null references kom_customers(id),
  channel            text not null check (channel in ('messenger','instagram','whatsapp','phone','email','note')),
  external_thread_id text,
  status             text not null default 'attention'
                     check (status in ('attention','waiting','snoozed','closed')),
  snooze_until       timestamptz,
  last_message_at    timestamptz,
  created_at         timestamptz not null default now(),
  unique (channel, external_thread_id)
);
create index if not exists kom_threads_customer on kom_threads (customer_id);
create index if not exists kom_threads_status on kom_threads (status, last_message_at desc);

create table if not exists kom_messages (
  id                  uuid primary key default gen_random_uuid(),
  thread_id           uuid not null references kom_threads(id),
  direction           text not null check (direction in ('in','out','internal')),
  body                text not null,
  sent_by             text check (sent_by in ('customer','antoni','ai_auto')),
  suggestion_id       uuid,
  external_message_id text,
  meta                jsonb,
  created_at          timestamptz not null default now(),
  unique (thread_id, external_message_id)
);
create index if not exists kom_messages_thread on kom_messages (thread_id, created_at);

-- ── Obietnice / follow-upy ────────────────────────────────────────────────
create table if not exists kom_commitments (
  id                uuid primary key default gen_random_uuid(),
  customer_id       uuid not null references kom_customers(id),
  thread_id         uuid references kom_threads(id),
  source_message_id uuid references kom_messages(id),
  description       text not null,
  owner             text not null check (owner in ('my','klient')),
  due_at            timestamptz not null,
  status            text not null default 'open'
                    check (status in ('open','done','cancelled')),
  created_by        text not null check (created_by in ('ai','manual')),
  resolved_at       timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists kom_commitments_open on kom_commitments (status, due_at);

-- ── Sugestie AI + korpus przykładów ──────────────────────────────────────
create table if not exists kom_suggestions (
  id             uuid primary key default gen_random_uuid(),
  thread_id      uuid not null references kom_threads(id),
  provider       text not null,
  model          text not null,
  prompt_version text not null,
  suggested_text text not null,
  status         text not null default 'pending'
                 check (status in ('pending','sent_as_is','edited','ignored','auto_sent')),
  final_text     text,
  decided_at     timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists kom_suggestions_thread on kom_suggestions (thread_id, created_at desc);

create table if not exists kom_examples (
  id            uuid primary key default gen_random_uuid(),
  source        text not null check (source in ('correction','import')),
  context       text not null,
  suggested     text,
  final         text not null,
  tags          text[],
  embedding     vector(1536),
  suggestion_id uuid references kom_suggestions(id),
  created_at    timestamptz not null default now()
);
create index if not exists kom_examples_embedding on kom_examples using hnsw (embedding vector_cosine_ops);

-- ── Pamięć wektorowa ─────────────────────────────────────────────────────
create table if not exists kom_memory (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references kom_customers(id),
  message_id  uuid references kom_messages(id),
  kind        text not null check (kind in ('message','call_summary','note')),
  content     text not null,
  embedding   vector(1536) not null,
  created_at  timestamptz not null default now()
);
create index if not exists kom_memory_embedding on kom_memory using hnsw (embedding vector_cosine_ops);
create index if not exists kom_memory_customer on kom_memory (customer_id);

-- ── Bezpiecznik scalania ─────────────────────────────────────────────────
create table if not exists kom_merge_proposals (
  id           uuid primary key default gen_random_uuid(),
  thread_id    uuid not null references kom_threads(id),
  candidate_id uuid not null references kom_customers(id),
  reason       text not null,
  evidence     jsonb not null,
  confidence   real,
  status       text not null default 'pending'
               check (status in ('pending','confirmed','rejected')),
  decided_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists kom_merge_pending on kom_merge_proposals (status, created_at desc);

-- ── Kolejka wysyłki (opóźnienie anty-botowe + okno "cofnij") ─────────────
create table if not exists kom_outbox (
  id            uuid primary key default gen_random_uuid(),
  thread_id     uuid not null references kom_threads(id),
  body          text not null,
  suggestion_id uuid references kom_suggestions(id),
  queued_by     text not null check (queued_by in ('antoni','ai_auto')),
  send_after    timestamptz not null,
  status        text not null default 'queued'
                check (status in ('queued','sent','cancelled','failed')),
  sent_at       timestamptz,
  error         text,
  created_at    timestamptz not null default now()
);
create index if not exists kom_outbox_due on kom_outbox (status, send_after);

-- ── Push ─────────────────────────────────────────────────────────────────
create table if not exists kom_push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  endpoint   text unique not null,
  keys       jsonb not null,
  created_at timestamptz not null default now()
);

-- ── Surowe payloady webhooków — debug + replay ───────────────────────────
create table if not exists kom_inbox_raw (
  id         uuid primary key default gen_random_uuid(),
  source     text not null,
  payload    jsonb not null,
  processed  boolean not null default false,
  error      text,
  created_at timestamptz not null default now()
);
create index if not exists kom_inbox_unprocessed on kom_inbox_raw (processed, created_at);
