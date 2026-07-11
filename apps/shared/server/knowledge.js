// ── Baza Wiedzy LumLum — wspólny moduł (docs/plan-baza-wiedzy.md) ────────────
// Jedna baza, wielu konsumentów: panel Wiedza, sugestie Komunikatora,
// odpowiedzi AI w CRM. Każda appka używa modułu bezpośrednio w procesie
// (wzorzec LeadKarta), przekazując klienta Supabase + ROLĘ wywołującego.
//
// PRYNCYPIUM BEZPIECZEŃSTWA: widoczność faktów jest egzekwowana przy
// retrievalu (funkcja SQL kb_match_facts dostaje listę dozwolonych
// widoczności), NIGDY w prompcie. Fakt niedostępny dla roli nie trafia do
// kontekstu LLM → model naturalnie odpowiada "nie mam takich informacji",
// bez zdradzania, że ukryta wiedza istnieje.
//
// Role:
//   'owner' — tylko Antoni osobiście (widzi też marże, koszty zakupu, zyski)
//   'team'  — Lorenzo oraz KAŻDE narzędzie generujące treść dla klientów
//             (sugestie widzi/wysyła się klientom, więc zawsze 'team',
//              nawet gdy panel otworzył Antoni)
// Nieznana rola = błąd (świadomie: lepiej wybuchnąć niż wyciec marżę).

const ROLE_VISIBILITY = {
  owner: ['owner', 'team', 'public'],
  team: ['team', 'public'],
};

const NO_KNOWLEDGE_ANSWER = 'Nie mam takich informacji.';
const EMBEDDING_MODEL = 'text-embedding-3-small'; // 1536 wymiarów, jak kom_memory

function allowedVisibility(role) {
  const allowed = ROLE_VISIBILITY[role];
  if (!allowed) throw new Error(`Nieznana rola bazy wiedzy: ${role}`);
  return allowed;
}

// ── Embeddingi (OpenAI, fetch wbudowany) ─────────────────────────────────────

async function embed(text) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('Brak OPENAI_API_KEY w konfiguracji serwera');
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: String(text).slice(0, 8000) }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`OpenAI embeddings ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body).data[0].embedding;
}

// ── Generacja odpowiedzi (Anthropic; model per env jak w komunikator/llm.js) ─

const ASK_MODEL_DEFAULT = 'anthropic:claude-sonnet-4-6';

async function completeAsk({ system, user, maxTokens = 700 }) {
  const spec = process.env.LLM_KB_ASK || ASK_MODEL_DEFAULT;
  const [provider, ...rest] = spec.split(':');
  const model = rest.join(':');
  if (provider === 'anthropic') {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('Brak ANTHROPIC_API_KEY w konfiguracji serwera');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${body.slice(0, 300)}`);
    const data = JSON.parse(body);
    return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  }
  if (provider === 'openai') {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('Brak OPENAI_API_KEY w konfiguracji serwera');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_completion_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${body.slice(0, 300)}`);
    return String(JSON.parse(body).choices?.[0]?.message?.content || '').trim();
  }
  throw new Error(`Nieznany dostawca LLM: ${provider}`);
}

// ── Retrieval ────────────────────────────────────────────────────────────────

// Fakty najbliższe zapytaniu, TYLKO w widoczności roli. Zwraca
// [{id,title,content,tags,visibility,similarity}].
async function search(db, { query, role, k = 8 }) {
  const allowed = allowedVisibility(role);
  const queryEmbedding = await embed(query);
  const { data, error } = await db.rpc('kb_match_facts', {
    query_embedding: queryEmbedding,
    allowed_visibility: allowed,
    match_count: k,
  });
  if (error) throw error;
  return data || [];
}

// Fakty jako gotowy blok tekstu do wstrzyknięcia w prompt innego narzędzia
// (suggest.js, CRM). Pusty string, gdy nic nie pasuje — konsument nie
// dokleja wtedy sekcji wiedzy w ogóle.
async function retrieveForPrompt(db, { query, role, k = 6, minSimilarity = 0.3 }) {
  const facts = (await search(db, { query, role, k })).filter(
    (f) => f.similarity == null || f.similarity >= minSimilarity
  );
  if (!facts.length) return '';
  const lines = facts.map((f) => `- ${f.title}: ${f.content}`);
  return `Fakty z bazy wiedzy LumLum (używaj tylko ich, nie zmyślaj danych spoza nich):\n${lines.join('\n')}`;
}

const ASK_SYSTEM = `Jesteś bazą wiedzy firmy LumLum (polska firma: zestawy oświetlenia LED schodów,
cyfrowe taśmy LED, autorski sterownik LumControl — lumlum.co). Odpowiadasz po polsku, konkretnie.

Zasady, których NIE wolno złamać:
- Odpowiadasz WYŁĄCZNIE na podstawie faktów podanych w wiadomości użytkownika.
- Jeśli fakty nie zawierają odpowiedzi na pytanie, odpowiadasz dokładnie:
  "${NO_KNOWLEDGE_ANSWER}" — bez zgadywania, bez wiedzy ogólnej, bez dopowiadania.
- Nie wspominasz o istnieniu bazy, faktów ani ograniczeń dostępu.`;

// Pytanie → retrieval w widoczności roli → odpowiedź LLM oparta o fakty.
// Brak faktów → NO_KNOWLEDGE_ANSWER + luka w kb_questions (answered=false).
// Zwraca { answer, facts: [{id,title}], confident }.
async function ask(db, { question, role, askedBy = null, k = 8 }) {
  const facts = await search(db, { query: question, role, k });
  const relevant = facts.filter((f) => f.similarity == null || f.similarity >= 0.25);

  let answer = NO_KNOWLEDGE_ANSWER;
  let confident = false;
  if (relevant.length) {
    const factBlock = relevant.map((f, i) => `[${i + 1}] ${f.title}\n${f.content}`).join('\n\n');
    answer = await completeAsk({
      system: ASK_SYSTEM,
      user: `FAKTY:\n${factBlock}\n\nPYTANIE: ${question}`,
    });
    confident = answer.trim() !== NO_KNOWLEDGE_ANSWER;
  }

  const { error } = await db.from('kb_questions').insert({
    asked_by: askedBy || role,
    question,
    answered: confident,
    answer: confident ? answer : null,
    used_fact_ids: confident ? relevant.map((f) => f.id) : null,
  });
  if (error) throw error;

  return { answer, facts: relevant.map((f) => ({ id: f.id, title: f.title })), confident };
}

// ── Zapis wiedzy ─────────────────────────────────────────────────────────────

// Nowy fakt. Domyślnie 'proposed' (human-in-the-loop) i 'owner' (bezpieczniej
// ukryć za dużo). Import zaufanych danych Antoniego może podać status:'active'.
async function proposeFact(db, {
  title, content, tags = [], visibility = 'owner', status = 'proposed',
  source, sourceRef = null, createdBy = 'ai',
}) {
  if (!title || !content) throw new Error('Fakt wymaga title i content');
  const embedding = await embed(`${title}\n${content}`);
  const { data, error } = await db
    .from('kb_facts')
    .insert({
      title, content, tags, visibility, status, source,
      source_ref: sourceRef, embedding, created_by: createdBy,
      reviewed_at: status === 'active' ? new Date().toISOString() : null,
    })
    .select('id');
  if (error) throw error;
  return { id: data[0].id };
}

// Decyzja z kolejki review: approve/reject, opcjonalnie z edycją treści
// i obniżeniem widoczności. Edycja treści → nowy embedding.
async function reviewFact(db, id, { decision, title, content, tags, visibility }) {
  if (!['approve', 'reject'].includes(decision)) throw new Error(`Nieznana decyzja: ${decision}`);
  const patch = {
    status: decision === 'approve' ? 'active' : 'rejected',
    reviewed_at: new Date().toISOString(),
  };
  if (visibility) patch.visibility = visibility;
  if (tags) patch.tags = tags;
  if (title) patch.title = title;
  if (content) patch.content = content;
  if (title || content) {
    const { data, error } = await db.from('kb_facts').select('title,content').eq('id', id).limit(1);
    if (error) throw error;
    const current = data && data[0];
    patch.embedding = await embed(`${title || current.title}\n${content || current.content}`);
  }
  const { error } = await db.from('kb_facts').update(patch).eq('id', id);
  if (error) throw error;
  return { id, status: patch.status };
}

// Nowa wersja faktu (np. zmiana ceny): stary → archived + superseded_by.
async function supersedeFact(db, oldId, newFactInput) {
  const created = await proposeFact(db, newFactInput);
  const { error } = await db
    .from('kb_facts')
    .update({ status: 'archived', superseded_by: created.id })
    .eq('id', oldId);
  if (error) throw error;
  return created;
}

module.exports = {
  ask,
  search,
  retrieveForPrompt,
  proposeFact,
  reviewFact,
  supersedeFact,
  embed,
  allowedVisibility,
  NO_KNOWLEDGE_ANSWER,
};
