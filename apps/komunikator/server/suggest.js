// ── Sugestie odpowiedzi + korpus korekt ─────────────────────────────────────
// Faza 1 (docs/plan-komunikator.md §6): sugestia generuje się LAZY, w momencie
// otwarcia wątku w panelu — zawsze świeży kontekst, zero kosztu za wątki,
// które Antoni zignoruje. Każda decyzja Antoniego wraca do kom_suggestions,
// a edycja dodatkowo do kom_examples (rosnący korpus wzorców; embeddingi
// dociągnie Etap 7 — kolumna na razie zostaje NULL).

const llm = require('./llm');

const PROMPT_VERSION = 'suggest-v1';
const CONTACT_PHONE = '604 650 590';

const SYSTEM_PROMPT = `Jesteś asystentem Antoniego, właściciela LumLum — polskiej firmy sprzedającej
zestawy oświetlenia LED schodów (cyfrowe taśmy LED + autorski sterownik LumControl, lumlum.co).
Piszesz PROPOZYCJĘ odpowiedzi na wiadomość klienta w social mediach. Antoni przeczyta ją,
ewentualnie poprawi i dopiero wtedy wyśle — nie wysyłasz nic sam.

Zasady:
- Piszesz po polsku, naturalnie i po ludzku, jak Antoni: konkretnie, ciepło, bez korporacyjnych
  formułek, bez "Szanowny Panie", bez podpisu na końcu. Krótko — to czat, nie e-mail.
- Zwracasz się per "Pan/Pani", chyba że klient pisze na luzie — wtedy dopasuj ton.
- Nie zmyślaj cen ani terminów. Jeśli klient pyta o wycenę, powiedz, że najłatwiej ustalić
  szczegóły telefonicznie i poproś o numer telefonu ALBO podaj numer LumLum: ${CONTACT_PHONE}.
- Jeśli w rozmowie nie znamy jeszcze numeru telefonu klienta, przy naturalnej okazji poproś o niego
  (telefon = najszybsza droga do wyceny). Nie wymuszaj tego w każdej wiadomości.
- Jeśli klient zadał proste pytanie (np. jak się skontaktować) — odpowiedz wprost, jednym-dwoma zdaniami.
- Notatki oznaczone [notatka Antoniego] to wewnętrzny kontekst — nie odnoś się do nich wprost.

Poniżej przykłady wcześniejszych odpowiedzi Antoniego (jeśli są) — trzymaj się ich stylu i sposobu
prowadzenia rozmowy. Odpowiedz WYŁĄCZNIE treścią wiadomości do klienta, bez komentarzy.`;

// Historia wątku → naprzemienne tury dla modelu. Kolejne wiadomości z tej
// samej strony sklejamy w jedną turę (API wymaga naprzemienności user/assistant).
function buildTurns(messages) {
  const turns = [];
  for (const m of messages.slice(-15)) {
    const role = m.direction === 'out' ? 'assistant' : 'user';
    const text = m.direction === 'internal' ? `[notatka Antoniego] ${m.body}` : m.body;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += `\n${text}`;
    else turns.push({ role, content: text });
  }
  // Pierwsza tura musi być user — utnij ewentualny prefiks asystenta.
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns;
}

function buildContextHeader(customer, thread, examples) {
  const parts = [];
  const known = (customer.identities || []).map((i) => i.type);
  parts.push(
    `Klient: ${customer.display_name || '(imię nieznane)'} [${customer.public_id}], kanał: ${thread.channel}.`
  );
  parts.push(known.includes('phone') ? 'Numer telefonu klienta: ZNANY.' : 'Numer telefonu klienta: NIEZNANY.');
  if (examples.length) {
    parts.push('\nPrzykłady odpowiedzi Antoniego w podobnych sytuacjach:');
    examples.forEach((ex, i) => {
      parts.push(`--- przykład ${i + 1} ---\nSytuacja: ${ex.context}\nOdpowiedź Antoniego: ${ex.final}`);
    });
  }
  return parts.join('\n');
}

// Kontekst zapisywany przy korekcie do kom_examples: ostatnie wiadomości
// klienta, żeby przyszła selekcja (wektorowa, Etap 7) miała po czym szukać.
function correctionContext(messages) {
  return messages
    .filter((m) => m.direction === 'in')
    .slice(-3)
    .map((m) => m.body)
    .join('\n')
    .slice(0, 1500);
}

// Generuje sugestię dla wątku i zapisuje ją w kom_suggestions.
// Zwraca { id, text, provider, model }.
async function generateSuggestion(db, thread, customer, messages) {
  // Na razie: 4 najnowsze przykłady z korpusu (selekcja wektorowa po
  // podobieństwie kontekstu wejdzie z Etapem 7 razem z embeddingami).
  const { data: examples, error: exErr } = await db
    .from('kom_examples')
    .select('context,final')
    .order('created_at', { ascending: false })
    .limit(4);
  if (exErr) throw exErr;

  const turns = buildTurns(messages);
  if (!turns.length) throw new Error('Brak wiadomości klienta do zasugerowania odpowiedzi');
  const header = buildContextHeader(customer, thread, examples || []);
  turns[0] = { role: 'user', content: `${header}\n\n=== ROZMOWA ===\n${turns[0].content}` };

  const result = await llm.complete({ task: 'suggest', system: SYSTEM_PROMPT, messages: turns, maxTokens: 600 });
  if (!result.text) throw new Error('Model zwrócił pustą sugestię');

  const { data, error } = await db
    .from('kom_suggestions')
    .insert({
      thread_id: thread.id,
      provider: result.provider,
      model: result.model,
      prompt_version: PROMPT_VERSION,
      suggested_text: result.text,
    })
    .select('id');
  if (error) throw error;
  return { id: data[0].id, text: result.text, provider: result.provider, model: result.model };
}

// Rozlicza sugestię po wysyłce: bez zmian → sent_as_is; poprawiona → edited
// + wiersz w korpusie kom_examples (para: sugestia → wersja Antoniego).
async function resolveSuggestionAfterSend(db, suggestionId, finalText, messages) {
  const { data, error } = await db
    .from('kom_suggestions')
    .select('*')
    .eq('id', suggestionId)
    .limit(1);
  if (error) throw error;
  const suggestion = data && data[0];
  if (!suggestion || suggestion.status !== 'pending') return;

  const edited = suggestion.suggested_text.trim() !== String(finalText).trim();
  const { error: updErr } = await db
    .from('kom_suggestions')
    .update({
      status: edited ? 'edited' : 'sent_as_is',
      final_text: finalText,
      decided_at: new Date().toISOString(),
    })
    .eq('id', suggestionId);
  if (updErr) throw updErr;

  if (edited) {
    const { error: exErr } = await db.from('kom_examples').insert({
      source: 'correction',
      context: correctionContext(messages),
      suggested: suggestion.suggested_text,
      final: finalText,
      suggestion_id: suggestionId,
    });
    if (exErr) throw exErr;
  }
}

// Wątek zignorowany/zamknięty → wiszące sugestie oznacz jako ignored.
async function ignorePendingSuggestions(db, threadId) {
  await db
    .from('kom_suggestions')
    .update({ status: 'ignored', decided_at: new Date().toISOString() })
    .eq('thread_id', threadId)
    .eq('status', 'pending');
}

module.exports = { generateSuggestion, resolveSuggestionAfterSend, ignorePendingSuggestions, PROMPT_VERSION };
