// ── Pamięć / uczenie AI-doradcy ──────────────────────────────────────────────
// "Doradca ma się uczyć na podstawie odpowiedzi" (wymóg Antoniego). Tabela
// doradca_memory (005 + 007). Cykl:
//   1. getOpen()+formatujDoPromptu() → wstrzykiwane do system promptu co turę.
//   2. po każdej odpowiedzi: uczSie() — tani model wyciąga z rozmowy TRWAŁE
//      rzeczy (ustalenia/obietnice/odkładane/wiedza) i zapisuje (dedupe:
//      duplikat = bump potwierdzenia+last_seen zamiast nowego wiersza).
const { parseSpec } = require('./fable');

const KINDS = ['ustalenie', 'obietnica', 'odkladane', 'wiedza'];
const TYTUL = {
  wiedza: 'Wiedza / preferencje (trwałe)',
  ustalenie: 'Ustalenia',
  obietnica: 'Obietnice Antoniego',
  odkladane: 'Świadomie odkładane',
};

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

async function getOpen(db, owner) {
  let q = db.from('doradca_memory')
    .select('id,kind,tekst,due_at,potwierdzenia,created_at')
    .eq('status', 'open');
  if (owner) q = q.eq('owner', owner);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// Ładny blok do system promptu (grupowany po rodzaju; obietnice z terminem).
function formatujDoPromptu(rows) {
  if (!rows || !rows.length) return '';
  const grup = { wiedza: [], ustalenie: [], obietnica: [], odkladane: [] };
  rows.forEach((r) => { (grup[r.kind] || (grup[r.kind] = [])).push(r); });
  const out = [];
  for (const kind of ['wiedza', 'ustalenie', 'obietnica', 'odkladane']) {
    const arr = grup[kind];
    if (!arr || !arr.length) continue;
    out.push(`**${TYTUL[kind]}:**`);
    arr.forEach((r) => {
      let line = `- ${r.tekst}`;
      if (kind === 'obietnica' && r.due_at) {
        const d = new Date(r.due_at);
        const minal = d.getTime() < Date.now();
        line += ` (termin: ${d.toLocaleDateString('pl-PL')}${minal ? ' — MINĄŁ, dopytaj' : ''})`;
      }
      out.push(line);
    });
  }
  return out.join('\n');
}

// ── Ekstrakcja: tani, nie-strumieniowy call, zwraca JSON ─────────────────────
function pickEkstraktModel() {
  const spec = process.env.LLM_DORADCA_EKSTRAKT || 'anthropic:claude-haiku-4-5-20251001';
  return parseSpec(spec);
}

const EKSTRAKT_PROMPT = `Jesteś ekstraktorem pamięci AI-doradcy biznesowego Antoniego (firma LumLum). Z FRAGMENTU rozmowy wyodrębnij TYLKO rzeczy TRWAŁE, warte zapamiętania na przyszłe rozmowy. Ignoruj chit-chat i jednorazowe liczby (te doradca i tak bierze ze snapshotu).

Zwróć WYŁĄCZNIE JSON:
{
  "wiedza":     ["trwały fakt/preferencja o Antonim lub firmie, np. 'nie chce podnosić cen', 'handlowiec = Lorenzo', 'woli ruchy asymetryczne'"],
  "ustalenie":  ["decyzja/kierunek uzgodniony w tej rozmowie"],
  "obietnica":  [{"tekst":"co Antoni obiecał zrobić", "termin":"DD.MM.YYYY lub null"}],
  "odkladane":  ["rzecz, którą Antoni świadomie odłożył na później"]
}

Zasady: krótko (max ~12 słów/wpis), konkretnie, w 3. osobie o Antonim. Puste tablice gdy nic nie ma. NIE wymyślaj — tylko to, co realnie padło. Bez markdown, sam JSON.`;

async function anthropicJson(model, transcript) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: 700, system: EKSTRAKT_PROMPT,
      messages: [{ role: 'user', content: `Fragment rozmowy:\n\n${transcript}` }],
    }),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const text = data && data.content ? data.content.filter((b) => b.type === 'text').map((b) => b.text).join('') : '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function parseTermin(t) {
  if (!t || typeof t !== 'string') return null;
  const m = t.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return null;
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Z ostatnich tur rozmowy + odpowiedzi wyciąga i zapisuje trwałe wpisy.
// Zwraca { inserted:[{kind,tekst}], bumped:n } (do pokazania w UI „nauczyłem się").
async function uczSie(db, owner, { messages, answer }) {
  if (!process.env.ANTHROPIC_API_KEY) return { inserted: [], bumped: 0, skipped: 'no-key' };
  const turns = (messages || []).slice(-6)
    .map((m) => `${m.role === 'assistant' ? 'Doradca' : 'Antoni'}: ${typeof m.content === 'string' ? m.content : ''}`)
    .filter((l) => l.length > 8);
  if (answer) turns.push(`Doradca: ${answer}`);
  const transcript = turns.join('\n').slice(0, 6000);
  if (transcript.length < 20) return { inserted: [], bumped: 0 };

  const { model } = pickEkstraktModel();
  const out = await anthropicJson(model, transcript);
  if (!out) return { inserted: [], bumped: 0 };

  const existing = await getOpen(db, owner);
  const byNorm = new Map(existing.map((r) => [r.kind + '|' + norm(r.tekst), r]));

  const inserted = [];
  let bumped = 0;
  for (const kind of KINDS) {
    const items = Array.isArray(out[kind]) ? out[kind] : [];
    for (const item of items) {
      const tekst = (typeof item === 'string' ? item : item && item.tekst || '').trim();
      if (!tekst) continue;
      const dup = byNorm.get(kind + '|' + norm(tekst));
      if (dup) {
        await db.from('doradca_memory').update({
          potwierdzenia: (dup.potwierdzenia || 1) + 1,
          last_seen_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', dup.id);
        bumped += 1;
        continue;
      }
      const due_at = kind === 'obietnica' ? parseTermin(item && item.termin) : null;
      const { error } = await db.from('doradca_memory').insert({
        owner, kind, tekst, due_at, status: 'open', source: 'czat', last_seen_at: new Date().toISOString(),
      });
      if (!error) inserted.push({ kind, tekst });
      byNorm.set(kind + '|' + norm(tekst), { id: null, kind, tekst, potwierdzenia: 1 });
    }
  }
  return { inserted, bumped };
}

async function rozwiaz(db, id, status) {
  const st = ['done', 'dropped', 'superseded'].includes(status) ? status : 'done';
  const { error } = await db.from('doradca_memory')
    .update({ status: st, resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
  return { ok: true };
}

module.exports = { getOpen, formatujDoPromptu, uczSie, rozwiaz, norm, parseTermin, TYTUL };
