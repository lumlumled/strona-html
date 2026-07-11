-- Wektorowa selekcja przykładów stylu do promptu sugestii (Etap 7 planu
-- Komunikatora, odblokowany przez Bazę Wiedzy: kom_examples ma już embeddingi
-- z importu wzorców Messengera). Wiersze bez embeddingu (stare korekty)
-- pomijamy — dobiera je fallback "najnowsze" w suggest.js.
create or replace function kom_match_examples(
  query_embedding vector(1536),
  match_count int default 4
)
returns table (context text, final text, similarity real)
language sql stable as $$
  select e.context, e.final, (1 - (e.embedding <=> query_embedding))::real as similarity
  from kom_examples e
  where e.embedding is not null
  order by e.embedding <=> query_embedding
  limit match_count;
$$;
