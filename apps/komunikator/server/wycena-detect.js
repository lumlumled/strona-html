// ── Wykrycie wyceny z wątku tekstowego (WhatsApp/Messenger/IG) ───────────────
// Odpowiednik ścieżki telefonicznej dla kanału PISANEGO: składa ostatnie
// wiadomości wątku + analizy AI załączników w tekst "rozmowy" i przepuszcza go
// przez DOKŁADNIE tę samą ekstrakcję produktów co telefon (call-analysis
// .analyzeCall). Dzięki temu mapowanie nazw/ilości (twarde ZASADY POLA produkty)
// jest jednym źródłem prawdy - taśmy jako "10m …", sterowniki/zasilacze bez
// jednostki, żadnych placeholderów "? m". Zwrócone `pozycje` idą wprost do
// szkicu wyceny; `produkty`/`cena` służą draftowi odpowiedzi i karcie.
//
// Uwaga projektowa: analyzeCall zwraca też status/feedback (pola telefoniczne) -
// tutaj celowo bierzemy TYLKO produkty i cenę; reszty nie używamy, bo wątek
// pisany nie ma "dispozycji" połączenia.

const { analyzeCall } = require('../../shared/server/call-analysis');
const { parseProduktyToItems } = require('../../backlog-b2c/server/rozmowy');
const media = require('./media');

// Ile ostatnich wiadomości bierzemy pod uwagę - tyle samo co kontekst sugestii
// (suggest.buildTurns), żeby "rozmowa" widziana przez ekstraktor pokrywała się
// z tym, co widzi handlowiec.
const MAX_MESSAGES = 15;

function warsawDateStr(d = new Date()) {
  // "YYYY-MM-DD" w strefie Europe/Warsaw - dzień wystarcza; analyzeCall używa go
  // tylko do (ignorowanej tu) daty feedbacku, ale trzymamy poprawną strefę.
  const f = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(d);
}

// Składa tekst "rozmowy" z wątku: każda wiadomość jako KLIENT/LUMLUM/NOTATKA,
// z doklejoną notką AI o załączniku (np. wykryty metraż LED z rzutu). To ten
// sam materiał, który dostaje sugestia - spójność wejścia = spójność wyników.
async function buildThreadTranscript(db, messages) {
  const attNotes = await media.notesByMessage(db, messages.map((m) => m.id)).catch(() => new Map());
  return messages.map((m) => {
    const who = m.direction === 'in' ? 'KLIENT' : (m.direction === 'internal' ? 'NOTATKA' : 'LUMLUM');
    const notes = attNotes.get(m.id);
    const extra = notes && notes.length ? `\n${notes.join('\n')}` : '';
    return `${who}: ${String(m.body || '').slice(0, 500)}${extra}`;
  }).join('\n');
}

// Główne wejście: threadId -> { pozycje, produkty, cena }. Pozycje puste = brak
// KONKRETNYCH produktów w rozmowie (ekstraktor z definicji nie zgaduje) -> nic
// się nie dzieje. Nie rzuca: awaria AI zwraca pusty wynik (orchestrator to
// potraktuje jak "brak wyceny do zrobienia").
async function detectWycenaFromThread(db, threadId, { poprzedniOpis = null } = {}) {
  const { data: rows, error } = await db.from('kom_messages')
    .select('id,direction,body,created_at')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: false })
    .limit(MAX_MESSAGES);
  if (error) throw error;
  const messages = (rows || []).reverse();
  if (!messages.length) return { pozycje: [], produkty: null, cena: null, analysis: null };

  const transcript = await buildThreadTranscript(db, messages);
  const analysis = await analyzeCall(transcript, {
    kierunek: null,
    dzisiaj: warsawDateStr(),
    poprzedniOpis,
    poprzedniaAkcja: null,
  });
  const pozycje = parseProduktyToItems(analysis?.produkty);
  return {
    pozycje,
    produkty: analysis?.produkty || null,
    cena: analysis?.cena_zaproponowana || null,
    analysis,
  };
}

module.exports = { detectWycenaFromThread, buildThreadTranscript };
