// ── AI kampanii: interpretacja briefu + generacja spersonalizowanych treści ──
// Wzorzec anthropicJson z apps/doradca/server/pamiec.js (tani model, batch,
// JSON, bez streamingu). Model z env LLM_KAMPANIE_GEN.
//
// TWARDE ZASADY firmowe (patrz Baza Wiedzy): nigdy em dash „—", zawsze „-";
// zero generycznych wiadomości — każda MUSI zawierać konkret z wyceny.

const MODEL_DEFAULT = 'claude-haiku-4-5-20251001';

function pickModel() {
  const spec = process.env.LLM_KAMPANIE_GEN || `anthropic:${MODEL_DEFAULT}`;
  return spec.includes(':') ? spec.split(':').slice(1).join(':') : spec;
}

async function anthropicJson({ system, user, maxTokens = 600 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Brak ANTHROPIC_API_KEY');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: pickModel(), max_tokens: maxTokens, system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json().catch(() => null);
  const text = data && data.content ? data.content.filter((b) => b.type === 'text').map((b) => b.text).join('') : '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI nie zwróciło JSON-a');
  return JSON.parse(m[0]);
}

// ── Segmenty SMS ─────────────────────────────────────────────────────────────
// GSM-7: 160 znaków / 1 segment (153 przy sklejanych); JAKIKOLWIEK znak spoza
// zestawu (każdy polski diakrytyk, w tym „ó") przełącza CAŁĄ wiadomość na
// UCS-2: 70 / 67. Znaki rozszerzenia GSM (€ [ ] { } \ ~ ^ |) liczą się za 2.

const GSM7_BASIC = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-.\/0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\\[\]~|€]*$/;
const GSM7_EXT = /[\^{}\\\[\]~|€]/g;

function policzSegmenty(tresc) {
  const s = String(tresc || '');
  if (!s) return { kodowanie: 'GSM-7', znaki: 0, segmenty: 0 };
  if (GSM7_BASIC.test(s)) {
    const len = s.length + (s.match(GSM7_EXT) || []).length;
    return { kodowanie: 'GSM-7', znaki: len, segmenty: len <= 160 ? 1 : Math.ceil(len / 153) };
  }
  const len = [...s].length;
  return { kodowanie: 'UCS-2', znaki: len, segmenty: len <= 70 ? 1 : Math.ceil(len / 67) };
}

function maxDlugosc({ bezPolskich, maxSegmenty, kanal }) {
  if (kanal === 'email') return 4000;
  const n = Math.max(1, Number(maxSegmenty) || 1);
  if (bezPolskich) return n === 1 ? 160 : n * 153;
  return n === 1 ? 70 : n * 67;
}

const TRANSLIT = {
  'ą': 'a', 'ć': 'c', 'ę': 'e', 'ł': 'l', 'ń': 'n', 'ó': 'o', 'ś': 's', 'ź': 'z', 'ż': 'z',
  'Ą': 'A', 'Ć': 'C', 'Ę': 'E', 'Ł': 'L', 'Ń': 'N', 'Ó': 'O', 'Ś': 'S', 'Ź': 'Z', 'Ż': 'Z',
};

function transliteruj(tresc) {
  return String(tresc || '').replace(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, (ch) => TRANSLIT[ch] || ch);
}

// Naturalny, krótki opis pozycji wyceny do promptu ("3x Cyfrowa taśma COB…").
function opiszItems(items) {
  if (!Array.isArray(items) || !items.length) return '';
  return items
    .map((it) => `${it.quantity || 1}${it.unit === 'm' ? ' m' : 'x'} ${String(it.name || '').trim()}`)
    .filter((s) => s.length > 3)
    .join(', ');
}

// ── Anty-generyczność ────────────────────────────────────────────────────────
// Wiadomość musi zawierać KONKRET ze snapshotu: kwotę wyceny albo słowo
// z nazwy produktu (porównanie po transliteracji, bez wielkości liter).
const STOPWORDS = new Set(['oraz', 'plus', 'oswietlenie', 'oswietlenia', 'zestaw', 'sztuk', 'metr', 'metry', 'kolor']);

function slowaKluczoweItems(items) {
  const out = new Set();
  (Array.isArray(items) ? items : []).forEach((it) => {
    transliteruj(String(it.name || '')).toLowerCase().split(/[^a-z0-9]+/).forEach((w) => {
      if (w.length >= 4 && !STOPWORDS.has(w)) out.add(w);
    });
  });
  return [...out];
}

function zawieraKonkret(tresc, kontekst) {
  const norm = transliteruj(String(tresc || '')).toLowerCase();
  const kwota = Number(kontekst && kontekst.kwota);
  if (Number.isFinite(kwota) && kwota > 0) {
    const calo = String(Math.round(kwota));
    if (norm.includes(calo)) return true;
    // kwoty pisane z separatorem: "3 200" / "3200 zl"
    if (calo.length > 3 && norm.replace(/[\s.,]/g, '').includes(calo)) return true;
  }
  const slowa = slowaKluczoweItems(kontekst && kontekst.items);
  return slowa.some((w) => norm.includes(w));
}

// Walidacja wygenerowanej/edytowanej treści. Zwraca { ok, tresc, bledy, segmenty }.
// Przy bezPolskich najpierw transliteracja (AI czasem przemyci diakrytyk) —
// dopiero potem twarde odrzuty.
function walidujTresc(surowa, { kontekst, bezPolskich, maxSegmenty, kanal }) {
  const bledy = [];
  let tresc = String(surowa || '').replace(/\s+$/g, '').trim();
  if (!tresc) return { ok: false, tresc, bledy: ['pusta treść'], segmenty: 0 };
  if (/[—–]/.test(tresc)) bledy.push('zakazany myślnik — / – (używamy "-")');
  if (/\{|\}/.test(tresc)) bledy.push('niewypełniony placeholder {…}');
  if (/\bSKU\b/i.test(tresc)) bledy.push('kod SKU w treści');
  if (bezPolskich && kanal !== 'email') {
    tresc = transliteruj(tresc);
    if (/[^\x00-\x7F]/.test(tresc.replace(/[€£¥§¿¡]/g, ''))) bledy.push('znaki spoza GSM-7 mimo trybu bez polskich znaków');
  }
  const limit = maxDlugosc({ bezPolskich, maxSegmenty, kanal });
  const seg = policzSegmenty(tresc);
  const dlugosc = kanal === 'email' ? tresc.length : seg.znaki;
  if (dlugosc > limit) bledy.push(`za długa: ${dlugosc} > ${limit} znaków`);
  if (kontekst && !zawieraKonkret(tresc, kontekst)) bledy.push('generyczna treść - brak konkretu z wyceny (produkt/kwota)');
  return { ok: !bledy.length, tresc, bledy, segmenty: seg.segmenty };
}

// ── Prompty ──────────────────────────────────────────────────────────────────

function promptGeneracji(kampania) {
  const kanal = kampania.kanal === 'email' ? 'e-mail' : 'SMS';
  const nadawcaLabel = String(kampania.nadawca || 'lorenzo');
  const podpis = `${nadawcaLabel.charAt(0).toUpperCase()}${nadawcaLabel.slice(1)} z LumLum`;
  const maxLen = maxDlugosc({ bezPolskich: kampania.bez_polskich_znakow, maxSegmenty: kampania.max_segmenty, kanal: kampania.kanal });
  const korekty = kampania.korekty || { pary: [], reguly: [] };
  const instrukcje = (kampania.interpretacja && kampania.interpretacja.instrukcje) || '';

  let s = `Jesteś asystentem sprzedaży sklepu LumLum (oświetlenie LED na wymiar). Piszesz KRÓTKĄ wiadomość ${kanal} po polsku w imieniu handlowca (${podpis}) do klienta, który jakiś czas temu dostał wycenę oświetlenia i nie odpowiedział.

CEL KAMPANII (opis właściciela):
${kampania.brief}
${instrukcje ? `\nDOPRECYZOWANIE:\n${instrukcje}\n` : ''}`;

  if (kampania.szablon) {
    s += `\nSZABLON WŁAŚCICIELA - trzymaj się jego struktury i tonu, tylko personalizuj pod klienta:
"""
${kampania.szablon}
"""\n`;
  }

  s += `
ZASADY TWARDE:
- Wiadomość MUSI zawierać konkret z wyceny tego klienta: co było wyceniane (produkty własnymi słowami) lub kwotę. Generyczna wiadomość bez konkretu = błąd.
- NIGDY nie używaj myślnika "—" ani "–". Zawsze zwykły łącznik "-".
- Jeśli znasz imię: zwróć się grzecznościowo z POPRAWNYM polskim wołaczem ("Panie Michale" / "Pani Anno"), forma męska/żeńska dobrana po imieniu. Jeśli imienia brak: zacznij od "Dzień dobry" i pisz formami bezosobowymi (nie zgaduj płci).
- Produkty opisuj naturalnie, krótko, BEZ kodów katalogowych i SKU (np. "taśmy LED z profilami" zamiast pełnej nazwy technicznej).
- Ton: uprzejmy, konkretny, nienachalny - jak człowiek, nie marketing. Jedno pytanie na końcu.
- Maksymalnie ${maxLen} znaków ŁĄCZNIE.`;
  if (kampania.bez_polskich_znakow && kampania.kanal !== 'email') {
    s += `\n- NIE używaj polskich znaków (ą,ć,ę,ł,ń,ó,ś,ź,ż) - pisz a,c,e,l,n,o,s,z. Dotyczy też imienia w wołaczu.`;
  }
  s += `\n- Podpisz: "${podpis}".`;

  if ((korekty.reguly || []).length) {
    s += `\n\nKOREKTY WŁAŚCICIELA - reguły z jego poprawek, stosuj bezwzględnie:\n${korekty.reguly.map((r) => `- ${r}`).join('\n')}`;
  }
  if ((korekty.pary || []).length) {
    const pary = korekty.pary.slice(-5);
    s += `\n\nPRZYKŁADY POPRAWEK (przed → po). Ucz się z nich, nie powtarzaj tych samych błędów:\n${pary
      .map((p) => `PRZED: ${p.przed}\nPO: ${p.po}`)
      .join('\n---\n')}`;
  }

  if (kampania.kanal === 'email') {
    s += `\n\nZwróć WYŁĄCZNIE JSON: {"temat": "krótki temat maila", "tresc": "...", "imie_wolacz": "... lub null"}`;
  } else {
    s += `\n\nZwróć WYŁĄCZNIE JSON: {"tresc": "...", "imie_wolacz": "... lub null"}`;
  }
  return s;
}

function opisOdbiorcy(kontekst) {
  const k = kontekst || {};
  const linie = [
    `Imię klienta: ${k.imie || 'BRAK (pisz bezosobowo)'}`,
    `Produkty z wyceny: ${opiszItems(k.items) || 'brak listy produktów'}`,
    `Kwota wyceny: ${Number.isFinite(Number(k.kwota)) && Number(k.kwota) > 0 ? `${Math.round(Number(k.kwota))} zł` : 'brak'}`,
  ];
  if (k.komentarz) linie.push(`Notatka handlowca: ${String(k.komentarz).slice(0, 300)}`);
  if (k.opis) linie.push(`Opis zamówienia: ${String(k.opis).slice(0, 300)}`);
  if (k.wiek_dni) linie.push(`Wycena sprzed ${k.wiek_dni} dni`);
  if (Number(k.liczba_wycen) > 1) linie.push(`Uwaga: klient ma ${k.liczba_wycen} otwarte wyceny (kwota dotyczy najnowszej)`);
  return linie.join('\n');
}

// Generuje treść dla jednego odbiorcy. Retry z komunikatem walidatora w prompcie
// (do 3 prób), potem rzuca — worker/endpoint decyduje o statusie failed.
async function generujTresc(kampania, kontekst, { maxProby = 3 } = {}) {
  const system = promptGeneracji(kampania);
  let userMsg = `Napisz wiadomość dla tego klienta:\n\n${opisOdbiorcy(kontekst)}`;
  let ostatnieBledy = [];
  for (let proba = 1; proba <= maxProby; proba++) {
    const out = await anthropicJson({ system, user: userMsg, maxTokens: kampania.kanal === 'email' ? 900 : 400 });
    const wynik = walidujTresc(out.tresc, {
      kontekst,
      bezPolskich: kampania.bez_polskich_znakow,
      maxSegmenty: kampania.max_segmenty,
      kanal: kampania.kanal,
    });
    if (wynik.ok) {
      return { tresc: wynik.tresc, temat: out.temat ? String(out.temat).trim() : null, segmenty: wynik.segmenty };
    }
    ostatnieBledy = wynik.bledy;
    userMsg = `Napisz wiadomość dla tego klienta:\n\n${opisOdbiorcy(kontekst)}\n\nPOPRZEDNIA PRÓBA ODRZUCONA: ${wynik.bledy.join('; ')}. Popraw i zwróć JSON jeszcze raz.`;
  }
  throw new Error(`walidacja: ${ostatnieBledy.join('; ')}`);
}

// ── Interpretacja swobodnego opisu kampanii ─────────────────────────────────
const PROMPT_INTERPRETACJI = `Jesteś asystentem panelu kampanii SMS/mail sklepu LumLum. Właściciel opisuje głosowo (tekst może być chaotyczny - dyktowany), jaką kampanię chce zrobić do klientów ze starymi wycenami. Wyciągnij z opisu ustawienia.

Zwróć WYŁĄCZNIE JSON:
{
  "nazwa": "krótka nazwa kampanii (2-5 słów)",
  "kanal": "sms" | "email",
  "min_wiek_dni": liczba (ile dni musi mieć wycena; domyślnie 30 gdy nie podano),
  "limit_dzienny": liczba lub null (ile wiadomości dziennie, gdy podał),
  "instrukcje": "zwięzłe wytyczne treści wyciągnięte z opisu: co powiedzieć, jaki ton, o co zapytać - dla generatora wiadomości",
  "uwagi": "wątpliwości/rzeczy niejasne w opisie lub null"
}

Zasady: nie wymyślaj ustawień, których nie podał (poza domyślnym min_wiek_dni). Kanał domyślnie "sms". Instrukcje po polsku, konkretne. Bez markdown, sam JSON.`;

async function interpretujBrief(opis, szablon) {
  const user = `Opis kampanii od właściciela:\n"""\n${opis}\n"""${szablon ? `\n\nWkleił też przykładową wiadomość/szablon:\n"""\n${szablon}\n"""` : ''}`;
  return anthropicJson({ system: PROMPT_INTERPRETACJI, user, maxTokens: 500 });
}

// ── Reguła z korekty ─────────────────────────────────────────────────────────
const PROMPT_REGULY = `Właściciel poprawił wygenerowaną wiadomość kampanii. Porównaj wersje i wyciągnij JEDNĄ krótką, ogólną regułę pisania (max 15 słów, po polsku), którą generator ma stosować w kolejnych wiadomościach. Skup się na tym CO ZMIENIŁ (ton, długość, słownictwo, struktura), nie na danych konkretnego klienta.

Zwróć WYŁĄCZNIE JSON: {"regula": "..." lub null gdy zmiana czysto kosmetyczna/personalna}`;

async function regulaZKorekty(przed, po) {
  try {
    const out = await anthropicJson({
      system: PROMPT_REGULY,
      user: `PRZED:\n${przed}\n\nPO:\n${po}`,
      maxTokens: 200,
    });
    const r = out && typeof out.regula === 'string' ? out.regula.trim() : '';
    return r && r.toLowerCase() !== 'null' ? r : null;
  } catch (err) {
    console.warn('kampanie: reguła z korekty nie powstała:', err.message);
    return null;
  }
}

module.exports = {
  anthropicJson,
  policzSegmenty,
  maxDlugosc,
  transliteruj,
  walidujTresc,
  zawieraKonkret,
  opiszItems,
  generujTresc,
  interpretujBrief,
  regulaZKorekty,
  promptGeneracji,
};
