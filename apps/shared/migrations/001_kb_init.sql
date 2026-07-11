-- ── Baza Wiedzy LumLum: tabele kb_* (docs/plan-baza-wiedzy.md) ──────────────
-- Jednostką wiedzy jest atomowy FAKT (nie chunk dokumentu). Widoczność
-- egzekwowana przy retrievalu (funkcja kb_match_facts), nigdy w prompcie.

create extension if not exists vector;

create table if not exists kb_documents (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  visibility text not null default 'owner' check (visibility in ('owner','team','public')),
  raw        text,
  created_at timestamptz not null default now()
);

create table if not exists kb_facts (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  content       text not null,
  tags          text[],
  -- owner  = tylko Antoni (marże, zyski, koszty zakupu, strategie cenowe)
  -- team   = Antoni + Lorenzo + narzędzia odpowiadające klientom
  -- public = można cytować wprost klientowi (opisy produktów, FAQ)
  visibility    text not null default 'owner'
                check (visibility in ('owner','team','public')),
  status        text not null default 'active'
                check (status in ('proposed','active','rejected','archived')),
  source        text not null
                check (source in ('manual','import','extracted','correction')),
  source_ref    jsonb,
  superseded_by uuid references kb_facts(id),
  embedding     vector(1536),
  created_by    text,
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists kb_facts_embedding on kb_facts using hnsw (embedding vector_cosine_ops);
create index if not exists kb_facts_status on kb_facts (status, created_at desc);
create index if not exists kb_facts_tags on kb_facts using gin (tags);

-- Log pytań: audyt + luki wiedzy (answered=false → lista "system nie wiedział")
create table if not exists kb_questions (
  id            uuid primary key default gen_random_uuid(),
  asked_by      text,
  question      text not null,
  answered      boolean not null,
  answer        text,
  used_fact_ids uuid[],
  created_at    timestamptz not null default now()
);
create index if not exists kb_questions_gaps on kb_questions (answered, created_at desc);

-- ── Retrieval z filtrem widoczności PO STRONIE BAZY ──────────────────────────
-- Jedyna droga wyszukiwania wektorowego. allowed_visibility przychodzi z
-- mapowania roli w apps/shared/server/knowledge.js — fakt spoza listy nie
-- istnieje dla wywołującego (żadnego "brak dostępu", po prostu brak wyniku).
create or replace function kb_match_facts(
  query_embedding vector(1536),
  allowed_visibility text[],
  match_count int default 8
)
returns table (id uuid, title text, content text, tags text[], visibility text, similarity real)
language sql stable as $$
  select f.id, f.title, f.content, f.tags, f.visibility,
         (1 - (f.embedding <=> query_embedding))::real as similarity
  from kb_facts f
  where f.status = 'active'
    and f.visibility = any(allowed_visibility)
    and f.embedding is not null
  order by f.embedding <=> query_embedding
  limit match_count;
$$;
