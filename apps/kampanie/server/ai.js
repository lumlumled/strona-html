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

// Publiczny link formularza wyceny — celowo krótki ?id= bez tokenu
// (ta sama reguła co formularzLink w wyceny-endpoints.js).
function linkFormularza(wycenaId) {
  const base = process.env.FORMULARZ_URL || 'https://lumlum.co/pages/formularz';
  return `${base}?id=${wycenaId}`;
}

const MIESIACE = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];

function dataPolska(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${d.getUTCDate()} ${MIESIACE[d.getUTCMonth()]}`;
}

// Rabat kampanii przeliczony dla konkretnego odbiorcy (procent → złotówki od
// kwoty jego wyceny). Zwraca null gdy rabat nieskonfigurowany/nieaktualny/
// nie da się policzyć (brak kwoty przy rabacie procentowym).
function rabatDlaOdbiorcy(rabat, kwota) {
  if (!rabat || !rabat.wazny_do || !Number(rabat.wartosc)) return null;
  if (Date.parse(`${rabat.wazny_do}T23:59:59`) < Date.now()) return null;
  const k = Number(kwota);
  let zl = null;
  if (rabat.typ === 'kwota') zl = Math.round(Number(rabat.wartosc));
  else if (Number.isFinite(k) && k > 0) zl = Math.round(k * Number(rabat.wartosc) / 100);
  if (!zl || zl <= 0) return null;
  if (Number.isFinite(k) && k > 0 && zl >= k) return null; // rabat nie może zjeść całej ceny
  return {
    zl,
    procent: rabat.typ === 'procent' ? Number(rabat.wartosc) : null,
    wazny_do: rabat.wazny_do,
    wazny_do_slownie: dataPolska(rabat.wazny_do),
    po_rabacie: Number.isFinite(k) && k > 0 ? Math.round(k - zl) : null,
  };
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
  const maKwote = Number.isFinite(kwota) && kwota > 0;
  const slowa = slowaKluczoweItems(kontekst && kontekst.items);
  // odbiorca bez wyceny (ręcznie dodany numer/lead) — nie ma konkretu,
  // którego można wymagać; personalizację niesie brief/imię
  if (!maKwote && !slowa.length) return true;
  if (maKwote) {
    const calo = String(Math.round(kwota));
    if (norm.includes(calo)) return true;
    // kwoty pisane z separatorem: "3 200" / "3200 zl"
    if (calo.length > 3 && norm.replace(/[\s.,]/g, '').includes(calo)) return true;
  }
  return slowa.some((w) => norm.includes(w));
}

// Walidacja wygenerowanej/edytowanej treści. Zwraca { ok, tresc, bledy, segmenty }.
// Przy bezPolskich najpierw transliteracja (AI czasem przemyci diakrytyk) —
// dopiero potem twarde odrzuty.
function walidujTresc(surowa, { kontekst, bezPolskich, maxSegmenty, kanal, limitZnakow = null }) {
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
  const limit = limitZnakow ?? maxDlugosc({ bezPolskich, maxSegmenty, kanal });
  const seg = policzSegmenty(tresc);
  const dlugosc = kanal === 'email' ? tresc.length : seg.znaki;
  if (dlugosc > limit) bledy.push(`za długa: ${dlugosc} > ${limit} znaków`);
  if (kontekst && !zawieraKonkret(tresc, kontekst)) bledy.push('generyczna treść - brak konkretu z wyceny (produkt/kwota)');
  return { ok: !bledy.length, tresc, bledy, segmenty: seg.segmenty };
}

// ── Prompty ──────────────────────────────────────────────────────────────────

function promptGeneracji(kampania, { followup = null, rezerwaZnakow = 0, rabatInfo = null } = {}) {
  const kanal = kampania.kanal === 'email' ? 'e-mail' : 'SMS';
  const nadawcaLabel = String(kampania.nadawca || 'lorenzo');
  const podpis = `${nadawcaLabel.charAt(0).toUpperCase()}${nadawcaLabel.slice(1)} z LumLum`;
  const maxLen = maxDlugosc({ bezPolskich: kampania.bez_polskich_znakow, maxSegmenty: kampania.max_segmenty, kanal: kampania.kanal }) - (rezerwaZnakow || 0);
  const korekty = kampania.korekty || { pary: [], reguly: [] };
  const instrukcje = (kampania.interpretacja && kampania.interpretacja.instrukcje) || '';

  let s = `Jesteś asystentem sprzedaży sklepu LumLum (oświetlenie LED na wymiar). Piszesz KRÓTKĄ wiadomość ${kanal} po polsku w imieniu handlowca (${podpis}) do klienta, który jakiś czas temu dostał wycenę oświetlenia i nie odpowiedział.

CEL KAMPANII (opis właściciela):
${kampania.brief}
${instrukcje ? `\nDOPRECYZOWANIE:\n${instrukcje}\n` : ''}`;

  if (followup) {
    s += `\nTO JEST FOLLOW-UP: klient dostał już wiadomość ${followup.poDniach} dni temu i NIE odpowiedział. Napisz KRÓTSZE, lekkie przypomnienie nawiązujące do tamtej wiadomości (bez powtarzania jej w całości), z wyraźną furtką "jeśli temat nieaktualny, proszę o krótkie 'nie' i nie będę więcej pisać".${followup.brief ? `\nWytyczne właściciela do follow-upu: ${followup.brief}` : ''}\nPOPRZEDNIA WIADOMOŚĆ DO TEGO KLIENTA:\n"""\n${followup.poprzedniaTresc}\n"""\n`;
  }

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
- KONSEKWENTNIE forma grzecznościowa Pan/Pani w całej wiadomości ("wysłaliśmy Panu", "ma Pani rabat") - nigdy na "ty" ("wysłaliśmy Ci", "masz").
- Produkty opisuj naturalnie, krótko, BEZ kodów katalogowych i SKU (np. "taśmy LED z profilami" zamiast pełnej nazwy technicznej).
- Jeśli znasz datę wysłania wyceny, użyj jej ("wycenę wysłaliśmy 5 maja") zamiast ogólników.
- PISZ JAK CZŁOWIEK, NIE JAK MARKETING. Zakazane frazy typu: "skorzystaj z okazji", "oferta specjalna", "nie przegap", "zapraszamy serdecznie", "wykorzystaj szansę", entuzjastyczne wykrzykniki. Handlowiec pisze zwyczajnie, rzeczowo.
- Zakończenie: proste pytanie, czy temat jest jeszcze aktualny, plus furtka w stylu "jeśli nie, proszę o krótką wiadomość - zamkniemy temat i nie będziemy się odzywać bez powodu".
- Maksymalnie ${maxLen} znaków ŁĄCZNIE.`;
  if (kampania.bez_polskich_znakow && kampania.kanal !== 'email') {
    s += `\n- NIE używaj polskich znaków (ą,ć,ę,ł,ń,ó,ś,ź,ż) - pisz a,c,e,l,n,o,s,z. Dotyczy też imienia w wołaczu.`;
  }
  s += `\n- Podpisz: "${podpis}".`;

  if (rabatInfo) {
    s += `\n\nRABAT CZASOWY (dane w opisie klienta): klient dostaje dodatkowy rabat na swoją wycenę, naliczony i widoczny w jego formularzu wyceny. Wspomnij o nim ZWYCZAJNIE, jednym zdaniem, z kwotą po rabacie i terminem ważności (np. "przy zamówieniu do ${rabatInfo.wazny_do_slownie || 'podanego dnia'} cena wyjdzie X zl zamiast Y zl"). Bez marketingowego tonu.`;
    if (rezerwaZnakow > 0) {
      s += ` Na końcu wiadomości zostanie automatycznie doklejony link do formularza - NIE wypisuj żadnego linku samodzielnie.`;
    } else {
      // Zadarma blokuje jakiekolwiek linki w SMS-ach na Polskę - zero URL-i
      s += ` NIE wypisuj żadnych linków ani adresów stron (operator blokuje SMS-y z linkami) - zamiast tego zaproś do odpowiedzi na tę wiadomość lub telefonu.`;
    }
  }

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

function opisOdbiorcy(kontekst, rabatInfo = null) {
  const k = kontekst || {};
  const linie = [
    `Imię klienta: ${k.imie || 'BRAK (pisz bezosobowo)'}`,
    `Produkty z wyceny: ${opiszItems(k.items) || 'brak listy produktów'}`,
    `Kwota wyceny: ${Number.isFinite(Number(k.kwota)) && Number(k.kwota) > 0 ? `${Math.round(Number(k.kwota))} zł` : 'brak'}`,
  ];
  const dataWyslania = k.wycena_created_at ? dataPolska(k.wycena_created_at) : null;
  if (dataWyslania) linie.push(`Data wysłania wyceny: ${dataWyslania}`);
  if (k.komentarz) linie.push(`Notatka handlowca: ${String(k.komentarz).slice(0, 300)}`);
  if (k.opis) linie.push(`Opis zamówienia: ${String(k.opis).slice(0, 300)}`);
  if (k.wiek_dni) linie.push(`Wycena sprzed ${k.wiek_dni} dni`);
  if (Number(k.liczba_wycen) > 1) linie.push(`Uwaga: klient ma ${k.liczba_wycen} otwarte wyceny (kwota dotyczy najnowszej)`);
  if (rabatInfo) {
    linie.push(`Rabat czasowy: ${rabatInfo.zl} zł${rabatInfo.procent ? ` (${rabatInfo.procent}%)` : ''}, ważny do ${rabatInfo.wazny_do_slownie || rabatInfo.wazny_do}${rabatInfo.po_rabacie ? `, cena po rabacie: ${rabatInfo.po_rabacie} zł` : ''}`);
  }
  return linie.join('\n');
}

// Generuje treść dla jednego odbiorcy. Retry z komunikatem walidatora w prompcie
// (do 3 prób), potem rzuca — worker/endpoint decyduje o statusie failed.
// Przy rabacie kampanii: AI dostaje wyliczony rabat/cenę po rabacie w opisie
// klienta, a link do formularza doklejamy MECHANICZNIE po walidacji (AI nie
// wolno pisać URL-i) — budżet znaków AI jest pomniejszony o rezerwę na link.
async function generujTresc(kampania, kontekst, { maxProby = 3, followup = null, wycenaId = null } = {}) {
  const rabatInfo = kontekst && kontekst.ma_rabat ? null : rabatDlaOdbiorcy(kampania.rabat, kontekst && kontekst.kwota);
  // link do formularza TYLKO w mailu — Zadarma blokuje wszystkie linki
  // w SMS-ach na Polskę (sprawdzone na żywo: "Linki w wiadomości SMS na ten
  // kierunek są zabronione", również goła domena bez https)
  const link = rabatInfo && wycenaId && kampania.kanal === 'email' ? linkFormularza(wycenaId) : null;
  const rezerwaZnakow = link ? link.length + 1 : 0;
  const system = promptGeneracji(kampania, { followup, rezerwaZnakow, rabatInfo });
  let opis = opisOdbiorcy(kontekst, rabatInfo);
  if (kampania.rabat && !rabatInfo) {
    // kampania ma rabat, ale TEN klient go nie dostaje (ma już wcześniejszy
    // rabat w cenie / brak kwoty) — AI nie może mu niczego obiecać
    opis += '\nUWAGA: ten klient NIE dostaje rabatu kampanii (cena w danych jest już po wcześniejszym rabacie). NIE wspominaj o żadnym rabacie ani promocji.';
  }
  const limit = maxDlugosc({ bezPolskich: kampania.bez_polskich_znakow, maxSegmenty: kampania.max_segmenty, kanal: kampania.kanal }) - rezerwaZnakow;
  let userMsg = `Napisz wiadomość dla tego klienta:\n\n${opis}`;
  let ostatnieBledy = [];
  for (let proba = 1; proba <= maxProby; proba++) {
    const out = await anthropicJson({ system, user: userMsg, maxTokens: kampania.kanal === 'email' ? 900 : 400 });
    const wynik = walidujTresc(out.tresc, {
      kontekst,
      bezPolskich: kampania.bez_polskich_znakow,
      maxSegmenty: kampania.max_segmenty,
      kanal: kampania.kanal,
      limitZnakow: limit,
    });
    // twardy bezpiecznik: żadnych URL-i w SMS-ach (Zadarma je odrzuca)
    if (kampania.kanal !== 'email' && /https?:\/\/|www\.|lumlum\.(co|dev)/i.test(out.tresc || '')) {
      wynik.ok = false;
      wynik.bledy = [...(wynik.bledy || []), 'link/adres strony w SMS (operator blokuje takie wiadomości)'];
    }
    if (wynik.ok) {
      const tresc = link ? `${wynik.tresc}\n${link}` : wynik.tresc;
      return { tresc, temat: out.temat ? String(out.temat).trim() : null, segmenty: policzSegmenty(tresc).segmenty };
    }
    ostatnieBledy = wynik.bledy;
    userMsg = `Napisz wiadomość dla tego klienta:\n\n${opis}\n\nPOPRZEDNIA PRÓBA ODRZUCONA: ${wynik.bledy.join('; ')}. Popraw i zwróć JSON jeszcze raz.`;
  }
  throw new Error(`walidacja: ${ostatnieBledy.join('; ')}`);
}

// ── Interpretacja swobodnego opisu kampanii ─────────────────────────────────
function promptInterpretacji(dzisiaj) {
  return `Jesteś asystentem panelu kampanii SMS/mail sklepu LumLum. Właściciel opisuje głosowo (tekst może być chaotyczny - dyktowany), jaką kampanię chce zrobić do klientów ze starymi wycenami. Dzisiaj jest ${dzisiaj}. Wyciągnij z opisu ustawienia.

Zwróć WYŁĄCZNIE JSON:
{
  "nazwa": "krótka nazwa kampanii (2-5 słów)",
  "kanal": "sms" | "email",
  "min_wiek_dni": liczba (ile dni musi mieć wycena; domyślnie 30 gdy nie podano),
  "limit_dzienny": liczba lub null (ile wiadomości dziennie, gdy podał),
  "instrukcje": "zwięzłe wytyczne treści wyciągnięte z opisu: co powiedzieć, jaki ton, o co zapytać - dla generatora wiadomości",
  "sekwencja": {"po_dniach": liczba, "brief": "wytyczne treści przypomnienia"} lub null (TYLKO gdy właściciel opisał follow-up/przypomnienie po X dniach bez odpowiedzi),
  "rabat": {"typ": "procent" | "kwota", "wartosc": liczba, "wazny_do": "YYYY-MM-DD"} lub null (TYLKO gdy właściciel mówił o rabacie/zniżce; "do końca tygodnia" = najbliższa niedziela, "przez 5 dni" = dzisiaj + 5 dni),
  "uwagi": "wątpliwości/rzeczy niejasne w opisie lub null"
}

Zasady: nie wymyślaj ustawień, których nie podał (poza domyślnym min_wiek_dni). Kanał domyślnie "sms". Instrukcje po polsku, konkretne. Bez markdown, sam JSON.`;
}

async function interpretujBrief(opis, szablon) {
  const dzisiaj = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', dateStyle: 'full' }).format(new Date());
  const user = `Opis kampanii od właściciela:\n"""\n${opis}\n"""${szablon ? `\n\nWkleił też przykładową wiadomość/szablon:\n"""\n${szablon}\n"""` : ''}`;
  return anthropicJson({ system: promptInterpretacji(dzisiaj), user, maxTokens: 600 });
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
  rabatDlaOdbiorcy,
  linkFormularza,
  dataPolska,
};
