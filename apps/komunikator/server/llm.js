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
  commitments: 'openai:gpt-5-mini',
  // Analiza załączników (zdjęcia, rzuty techniczne, PDF-y) — wizja. Najmocniejszy
  // model: wolumen to kilkanaście obrazów tygodniowo, a błędny odczyt wymiarów
  // z rzutu kosztuje więcej niż tokeny.
  media: 'anthropic:claude-opus-4-8',
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

async function completeOpenAI({ model, system, messages, maxTokens, json, reasoningEffort }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('Brak OPENAI_API_KEY w konfiguracji serwera');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_completion_tokens: maxTokens,
      // Modele reasoningowe (gpt-5-mini) bez ograniczenia wysiłku potrafią
      // zjeść cały budżet tokenów na myślenie i zwrócić pusty content —
      // taski ekstrakcyjne przekazują reasoningEffort: 'minimal'.
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${body.slice(0, 300)}`);
  const data = JSON.parse(body);
  return { text: String(data.choices?.[0]?.message?.content || '').trim(), provider: 'openai', model };
}

// Transkrypcja audio/wideo (OpenAI, multipart). Przyjmuje bezpośrednio kontenery
// wideo (mp4/webm) — model bierze ścieżkę dźwiękową, więc filmy z Messengera
// idą bez ekstrakcji audio. Limit API ~25 MB — wołający pilnuje rozmiaru.
async function transcribe({ buffer, filename, mime, language = 'pl' }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('Brak OPENAI_API_KEY w konfiguracji serwera');
  const model = process.env.TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), filename || 'media.mp4');
  form.append('model', model);
  form.append('language', language);
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`OpenAI transkrypcja ${res.status}: ${body.slice(0, 300)}`);
  const data = JSON.parse(body);
  return { text: String(data.text || '').trim(), model };
}

// messages: [{role: 'user'|'assistant', content: string}]
// content może też być tablicą bloków Anthropic (image/document) — completeAnthropic
// przekazuje messages bez zmian, więc zadania wizyjne (task: media) działają
// przez ten sam adapter. Dla OpenAI bloki nie są wspierane.
// json/reasoningEffort: tylko OpenAI (Anthropic je ignoruje — prompt i tak
// wymusza czysty JSON, a parse jest defensywny po stronie wołającego).
async function complete({ task, system, messages, maxTokens = 1024, json, reasoningEffort }) {
  const { provider, model } = taskConfig(task);
  if (provider === 'anthropic') return completeAnthropic({ model, system, messages, maxTokens });
  if (provider === 'openai') return completeOpenAI({ model, system, messages, maxTokens, json, reasoningEffort });
  throw new Error(`Nieznany dostawca LLM: ${provider}`);
}

module.exports = { complete, taskConfig, transcribe };
