// ── Szybkie dodanie wyceny: parser GPT + deterministyczny MERGE ──────────────
// Prompt parsera przeniesiony 1:1 z Make (scenariusz "#1 B2B Dodanie casów",
// moduł 3, model gpt-5-mini) z dwiema uzgodnionymi zmianami: bez wymogu
// słowa-klucza "wycena" i bez telegram-izmów. Plik obok:
// wyceny-parser-prompt.txt (z TABELĄ KANONICZNĄ SKU — przy zmianie cennika
// zaktualizować też tabelę w prompcie).
//
// MERGE z Make (moduł 44) to czysto deterministyczne reguły — implementujemy
// w JS zamiast wołać GPT: FULL_REPLACE tylko przy quote_mode=REPLACE_EXISTING
// i niepustych nowych items; inaczej KEEP_OLD. W panelu i tak jest PODGLĄD
// przed zapisem (przewaga nad Telegramem), więc użytkownik ostatecznie
// decyduje: podmień istniejącą / utwórz nową.

const fs = require('fs');
const path = require('path');

const PARSER_PROMPT = fs.readFileSync(path.join(__dirname, 'wyceny-parser-prompt.txt'), 'utf8');
const PARSER_MODEL = process.env.WYCENY_PARSER_MODEL || 'gpt-5-mini';

function warsawNow() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Warsaw', dateStyle: 'short', timeStyle: 'short',
  }).format(new Date());
}

function warsawDateStr() {
  return new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw' }).format(new Date()); // DD.MM.YYYY
}

async function parseWycenaText(tekst) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Brak OPENAI_API_KEY w konfiguracji serwera');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: PARSER_MODEL,
      messages: [
        { role: 'system', content: PARSER_PROMPT },
        // Ten sam kształt wejścia co w Make (timestamp + text), tylko bez
        // pól Telegrama.
        { role: 'user', content: `timestamp: ${warsawNow()}\ntext: ${String(tekst)}` },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Parser nie zwrócił poprawnego JSON-a');
  return JSON.parse(content.slice(start, end + 1));
}

// Deterministyczny MERGE (reguły 1:1 z promptu MERGE w Make):
// FULL_REPLACE = pełna podmiana items + kwoty; nigdy nie rusza kontaktu.
function mergeWycena(oldWycena, parsed) {
  const newItems = Array.isArray(parsed.items) ? parsed.items : [];
  if (parsed.quote_mode === 'REPLACE_EXISTING' && newItems.length) {
    return {
      mode: 'FULL_REPLACE',
      items: newItems,
      kwota_proponowana_brutto: parsed.price_offered ?? oldWycena.kwota_proponowana_brutto,
    };
  }
  return { mode: 'KEEP_OLD', items: oldWycena.items, kwota_proponowana_brutto: oldWycena.kwota_proponowana_brutto };
}

// Wiersz wyceny z wyniku parsera — mapowanie kolumn 1:1 z addRow w Make
// (price_offered -> kwota_proponowana_brutto itd.).
function parsedToRow(parsed, tekst) {
  const digits = String(parsed.phone_digits || '').replace(/\D/g, '');
  const logLine = `${warsawDateStr()} | RAW | ${String(tekst).split('\n').map((l) => l.trim()).filter(Boolean).join('" "')}`;
  return {
    typ: ['WYCENA', 'ZAMÓWIENIE', 'NOTATKA'].includes(parsed.type) ? parsed.type : 'NOTATKA',
    status: 'Open',
    imie_nazwisko: parsed.customer_name || null,
    telefon_e164: parsed.phone_e164 ? String(parsed.phone_e164).replace(/^\+/, '') : null,
    telefon_digits: digits || null,
    email: parsed.email_full ? String(parsed.email_full).toLowerCase().trim() : null,
    opis_zamowienia: parsed.project_description || null,
    items: Array.isArray(parsed.items) ? parsed.items : [],
    kwota_proponowana_brutto: parsed.price_offered ?? parsed.price_final ?? null,
    partner: parsed.partner || null,
    prowizja_status: parsed.prowizja_status || null,
    dane_do_faktury: parsed.dane_do_faktury || null,
    rabat24h_kwota: parsed.rabat24h_kwota ?? null,
    // Rabat czasowy: parser zwraca też długość ważności w godzinach
    // (rabat_godziny) — "24h"→24, "72h"→72, "7 dni"→168. Brak → 24h (domyślnie
    // jak w Make). Ważny "do" liczymy od teraz w JS (jedno źródło czasu).
    rabat24h_wazny_do: parsed.rabat24h_kwota
      ? new Date(Date.now() + (Number(parsed.rabat_godziny) > 0 ? Number(parsed.rabat_godziny) : 24) * 60 * 60 * 1000).toISOString()
      : null,
    history_log: logLine,
  };
}

// Dopasowanie istniejącej wyceny po telefonie (potem e-mailu) — najnowsza,
// jak filterRows w Make (sort po dacie malejąco, limit 1).
async function findMatch(supabase, parsed) {
  const digits = String(parsed.phone_digits || '').replace(/\D/g, '');
  const email = String(parsed.email_full || '').toLowerCase().trim();
  if (digits) {
    const { data, error } = await supabase.from('wyceny')
      .select('id,imie_nazwisko,typ,status,items,kwota_proponowana_brutto,telefon_e164,email,created_at')
      .eq('telefon_digits', digits).order('id', { ascending: false }).limit(1);
    if (error) throw error;
    if (data && data.length) return data[0];
  }
  if (email) {
    const { data, error } = await supabase.from('wyceny')
      .select('id,imie_nazwisko,typ,status,items,kwota_proponowana_brutto,telefon_e164,email,created_at')
      .ilike('email', email).order('id', { ascending: false }).limit(1);
    if (error) throw error;
    if (data && data.length) return data[0];
  }
  return null;
}

module.exports = { parseWycenaText, mergeWycena, parsedToRow, findMatch, PARSER_MODEL };
