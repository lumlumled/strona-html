// ── Abstrakcja nad dostawcą modelu (OpenAI / Anthropic) ─────────────────────
// Zadanie → dostawca:model z env varów, np. LLM_SUGGEST=anthropic:claude-sonnet-4-6.
// Zmiana modelu = zmiana env vara, zero zmian w logice panelu
// (docs/plan-komunikator.md §6). Oba adaptery zwracają ten sam kształt:
// { text, provider, model }.

const TASK_DEFAULTS = {
  suggest: 'anthropic:claude-sonnet-4-6',
  extract: 'anthropic:claude-sonnet-4-6',
  classify: 'anthropic:claude-sonnet-4-6',
  summarize_call: 'openai:gpt-5.1',
};

function taskConfig(task) {
  const envKey = `LLM_${String(task).toUpperCase()}`;
  const spec = process.env[envKey] || TASK_DEFAULTS[task];
  if (!spec) throw new Error(`Brak konfiguracji modelu dla zadania: ${task}`);
  const [provider, ...rest] = spec.split(':');
  return { provider, model: rest.join(':') };
}

async function completeAnthropic({ model, system, messages, maxTokens }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Brak ANTHROPIC_API_KEY w konfiguracji serwera');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${body.slice(0, 300)}`);
  const data = JSON.parse(body);
  if (data.stop_reason === 'refusal') throw new Error('Model odmówił odpowiedzi (refusal)');
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text: text.trim(), provider: 'anthropic', model };
}

async function completeOpenAI({ model, system, messages, maxTokens }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('Brak OPENAI_API_KEY w konfiguracji serwera');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_completion_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${body.slice(0, 300)}`);
  const data = JSON.parse(body);
  return { text: String(data.choices?.[0]?.message?.content || '').trim(), provider: 'openai', model };
}

// messages: [{role: 'user'|'assistant', content: string}]
async function complete({ task, system, messages, maxTokens = 1024 }) {
  const { provider, model } = taskConfig(task);
  if (provider === 'anthropic') return completeAnthropic({ model, system, messages, maxTokens });
  if (provider === 'openai') return completeOpenAI({ model, system, messages, maxTokens });
  throw new Error(`Nieznany dostawca LLM: ${provider}`);
}

module.exports = { complete, taskConfig };
