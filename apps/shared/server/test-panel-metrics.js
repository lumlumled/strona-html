// Czysta logika panelu Test (kokpit umowy 30 dni handlowca) — zero dostępu do
// bazy, wszystko liczone z surowych wierszy, testowalne node --test.
//
// Źródła danych (patrz test-panel-endpoints.js):
//   leads  — "Leady B2C" (Date = DD.MM.YYYY bez godziny; dokładny timestamp
//            wpadnięcia leada żyje w marketing_meta.date_created, ISO/UTC)
//   calls  — "Log zmian" z kierunek IS NOT NULL (telefony Zadarmy; telefon to
//            '48XXXXXXXXX', data_zmiany ISO/UTC, data_feedbacku_po DD.MM.YYYY)
//   wyceny — kanoniczna tabela wyceny (telefon_digits BEZ prefiksu 48)
//
// Panel liczy TYLKO leady, które wpadły od startu testu (decyzja Antoniego:
// "nie patrzmy wstecznie") — reguły o ZACHOWANIU w rozmowach (R3-R6) liczą
// wszystkie rozmowy wykonane od startu, także do starych leadów, bo umowa
// dotyczy każdej rozmowy, nie tylko nowych leadów.

const HANDLOWIEC = 'Lorenzo';
const FINAL_STATUSY = ['Stracony', 'Sprzedane', 'Błędne dane'];
const DZIEN_MS = 24 * 60 * 60 * 1000;

// Treść umowy wprost w kodzie — panel ma PRZYPOMINAĆ zasady, nie tylko liczyć.
const REGULY = [
  { key: 'sla', nr: 1, tytul: 'Telefon w 15 minut', tresc: 'Nowy lead = pierwsza próba telefonu w 15 minut (w godzinach 8:00-20:00; lead z nocy startuje o 8:00).' },
  { key: 'kadencja', nr: 2, tytul: 'Min. 5 prób, zanim lead umrze', tresc: 'Lead nie umiera przed 5 próbami w 14 dni, próby w różnych porach dnia. Cisza 3 dni bez umówionego terminu = lead umiera po cichu.' },
  { key: 'next_step', nr: 3, tytul: 'Każda rozmowa kończy się datą', tresc: 'Rozmowa bez zapisanej daty i godziny następnego kroku ("jesteśmy w kontakcie") = rozmowa niedokończona. Wyjątek: klient definitywnie stracony.' },
  { key: 'godziny', nr: 4, tytul: 'Blok 13-15, zakaz po 19', tresc: 'Blok obdzwonkowy 13:00-15:00 (najlepsza dodzwanialność: 91%). Zakaz PIERWSZYCH kontaktów po 19:00.' },
  { key: 'obietnice', nr: 5, tytul: 'Obietnica jest święta', tresc: '"Zadzwonię jutro o 9" wykonane o 19:11 = złamane. Umówiony termin = telefon tego dnia.' },
  { key: 'styl', nr: 6, tytul: 'Rabat za zobowiązanie, zero odsyłania', tresc: 'Rabat/gratis tylko w zamian za zobowiązanie klienta. Nie odsyłamy klienta "niech pan poszuka na rynku". (Liczone z karty ocen AI.)' },
  { key: 'cel', nr: 7, tytul: 'Cel: 2 wyceny domknięte telefonem', tresc: 'Uczciwy licznik: sprzedaż liczy się tylko, gdy przed opłaceniem była odebrana rozmowa handlowca z tym numerem.' },
];

// ── Pomocnicze ───────────────────────────────────────────────────────────────

// 'DD.MM.YYYY' -> 'YYYY-MM-DD' (formaty dat w Leady B2C / Log zmian).
function parseDataPL(s) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(s || '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// Klucz łączenia telefonów między tabelami: ostatnie 9 cyfr (Log zmian ma
// prefiks 48, wyceny.telefon_digits nie ma, w leadach trafiają się śmieci).
function last9(x) {
  return String(x == null ? '' : x).replace(/\D/g, '').slice(-9);
}

const WARSAW_FMT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

// UTC -> części daty w strefie Warszawy. 'sv-SE' daje 'YYYY-MM-DD HH:mm'.
function warsaw(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  const s = WARSAW_FMT.format(d); // 'YYYY-MM-DD HH:mm'
  return { ymd: s.slice(0, 10), h: Number(s.slice(11, 13)), min: Number(s.slice(14, 16)) };
}

// SLA liczymy od momentu, w którym WOLNO było dzwonić: lead z 20:00-8:00
// startuje zegar o 8:00 rano (Warszawa). Zwraca timestamp (ms).
function effectiveStartMs(createdMs) {
  const { ymd, h } = warsaw(new Date(createdMs));
  if (h >= 8 && h < 20) return createdMs;
  // 8:00 czasu warszawskiego danego dnia: różnica UTC-Warszawa zmienna (DST),
  // więc liczymy ją z samego formatu — createdMs cofnięte do godziny h daje offset.
  const base = new Date(createdMs);
  const warsawMinutes = h * 60 + warsaw(base).min;
  const utcMinutes = base.getUTCHours() * 60 + base.getUTCMinutes();
  const offsetMin = ((warsawMinutes - utcMinutes) % (24 * 60) + 24 * 60) % (24 * 60);
  const dayStartUtc = Date.parse(`${ymd}T00:00:00Z`) - offsetMin * 60 * 1000;
  const at8 = dayStartUtc + 8 * 60 * 60 * 1000;
  return h < 8 ? at8 : at8 + DZIEN_MS; // po 20:00 -> jutro 8:00
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function pct(part, total) {
  return total > 0 ? Math.round((part / total) * 100) : null;
}

// ── Kokpit ───────────────────────────────────────────────────────────────────

function computeKokpit({ leads, calls, wycenyPaid, wycenyOpen, scoresWeek, now = new Date(), start }) {
  const nowMs = now.getTime();
  const startMs = new Date(start).getTime();
  const weekMs = nowMs - 7 * DZIEN_MS;
  const todayYmd = warsaw(now).ymd;

  // Telefony -> posortowane połączenia (cała historia, nie tylko od startu:
  // "dotknięcie przed sprzedażą" i "pierwszy kontakt w życiu" tego wymagają).
  const callsSorted = [...calls].sort((a, b) => new Date(a.data_zmiany) - new Date(b.data_zmiany));
  const byPhone = new Map();
  for (const c of callsSorted) {
    const key = last9(c.telefon);
    if (!key) continue;
    if (!byPhone.has(key)) byPhone.set(key, []);
    byPhone.get(key).push(c);
  }
  const phoneCalls = (phone) => byPhone.get(last9(phone)) || [];
  const wychodzace = (list) => list.filter((c) => c.kierunek === 'wychodzące');

  // Nazwa klienta do list ostrzeżeń.
  const nameByPhone = new Map();
  for (const l of leads) {
    const key = last9(l['Phone number']);
    if (key && !nameByPhone.has(key)) nameByPhone.set(key, l.Name || null);
  }

  // ── Nowe leady (od startu testu) ──────────────────────────────────────────
  const noweLeady = [];
  for (const l of leads) {
    const meta = l.marketing_meta || {};
    const createdIso = meta.date_created || null;
    const dateYmd = parseDataPL(l.Date);
    let createdMs = createdIso ? Date.parse(createdIso) : (dateYmd ? Date.parse(`${dateYmd}T06:00:00Z`) : null);
    if (createdMs == null || Number.isNaN(createdMs) || createdMs < startMs) continue;
    noweLeady.push({
      lead: l,
      id: l['ID Leada'],
      name: l.Name || '(bez imienia)',
      phone: last9(l['Phone number']),
      status: l['Deal stage'] || 'Nowy',
      createdMs,
      dokladnyCzas: Boolean(createdIso), // bez date_created znamy tylko dzień
      feedbackYmd: parseDataPL(l['Data Feedbacku']),
    });
  }

  // ── R1: SLA 15 minut ──────────────────────────────────────────────────────
  const sla = { tydzien: { probki: [], pct15: null, mediana: null }, total: { probki: [], pct15: null, mediana: null }, naruszenia: [], czekaja: [] };
  for (const nl of noweLeady) {
    const out = wychodzace(phoneCalls(nl.phone)).filter((c) => new Date(c.data_zmiany).getTime() >= nl.createdMs - 5 * 60 * 1000);
    const effStart = effectiveStartMs(nl.createdMs);
    if (!out.length) {
      const czekaMin = Math.max(0, Math.round((nowMs - effStart) / 60000));
      if (czekaMin > 15) sla.czekaja.push({ id: nl.id, name: nl.name, telefon: nl.phone, min: czekaMin, dokladnyCzas: nl.dokladnyCzas });
      continue;
    }
    if (!nl.dokladnyCzas) continue; // znamy tylko dzień — minuty byłyby zmyślone
    const firstMs = new Date(out[0].data_zmiany).getTime();
    const min = Math.max(0, Math.round((firstMs - effStart) / 60000));
    sla.total.probki.push(min);
    if (nl.createdMs >= weekMs) sla.tydzien.probki.push(min);
    if (min > 15) sla.naruszenia.push({ id: nl.id, name: nl.name, telefon: nl.phone, min });
  }
  for (const w of [sla.tydzien, sla.total]) {
    w.mediana = median(w.probki);
    w.pct15 = pct(w.probki.filter((m) => m <= 15).length, w.probki.length);
    w.n = w.probki.length;
    delete w.probki;
  }
  sla.naruszenia.sort((a, b) => b.min - a.min);
  sla.czekaja.sort((a, b) => b.min - a.min);

  // ── R2: kadencja + umierające leady ───────────────────────────────────────
  const kadencja = { rozklad: { 0: 0, '1-2': 0, '3-4': 0, '5+': 0 }, umieraja: [], srednioProb: null };
  const probyList = [];
  for (const nl of noweLeady) {
    if (FINAL_STATUSY.includes(nl.status)) continue;
    const out = wychodzace(phoneCalls(nl.phone));
    const proby = out.length;
    probyList.push(proby);
    kadencja.rozklad[proby === 0 ? 0 : proby <= 2 ? '1-2' : proby <= 4 ? '3-4' : '5+'] += 1;
    const odebrane = out.filter((c) => c.disposition === 'answered').length;
    const lastTouchMs = out.length ? new Date(out[out.length - 1].data_zmiany).getTime() : null;
    const dniCiszy = lastTouchMs ? Math.floor((nowMs - lastTouchMs) / DZIEN_MS) : null;
    const maUmowionyTermin = nl.feedbackYmd && nl.feedbackYmd >= todayYmd;
    if (proby === 0) continue; // to łapie R1 (czekają na 1. kontakt)
    if (proby < 5 && dniCiszy >= 3 && !maUmowionyTermin) {
      kadencja.umieraja.push({ id: nl.id, name: nl.name, telefon: nl.phone, proby, odebrane, dniCiszy, status: nl.status });
    }
  }
  kadencja.srednioProb = probyList.length ? Math.round((probyList.reduce((a, b) => a + b, 0) / probyList.length) * 10) / 10 : null;
  kadencja.umieraja.sort((a, b) => b.dniCiszy - a.dniCiszy);
  kadencja.n = probyList.length;

  // ── Rozmowy od startu (zachowanie w KAŻDEJ rozmowie, też do starych leadów) ─
  const rozmowyOdStartu = callsSorted.filter((c) =>
    c.handlowiec === HANDLOWIEC && c.kierunek === 'wychodzące' &&
    new Date(c.data_zmiany).getTime() >= startMs);
  const realneRozmowy = rozmowyOdStartu.filter((c) => c.disposition === 'answered' && (c.czas_trwania_s || 0) >= 20);

  // ── R3: data po każdej rozmowie ───────────────────────────────────────────
  const nextStep = { tydzien: { ok: 0, n: 0 }, total: { ok: 0, n: 0 }, bezDaty: [] };
  for (const c of realneRozmowy) {
    const ok = Boolean(c.data_feedbacku_po) || FINAL_STATUSY.includes(c.status_po);
    const inWeek = new Date(c.data_zmiany).getTime() >= weekMs;
    nextStep.total.n += 1; if (ok) nextStep.total.ok += 1;
    if (inWeek) { nextStep.tydzien.n += 1; if (ok) nextStep.tydzien.ok += 1; }
    if (!ok) nextStep.bezDaty.push({ logId: c.id, telefon: last9(c.telefon), name: nameByPhone.get(last9(c.telefon)) || null, data: c.data_zmiany, sekundy: c.czas_trwania_s });
  }
  for (const w of [nextStep.tydzien, nextStep.total]) w.pct = pct(w.ok, w.n);
  nextStep.bezDaty.sort((a, b) => new Date(b.data) - new Date(a.data));

  // ── R4: godziny dzwonienia ────────────────────────────────────────────────
  const godziny = { hist: Array.from({ length: 24 }, (_, h) => ({ h, proby: 0 })), blok1315: { proby: 0, wszystkie: 0 }, pierwszePo19: [] };
  for (const c of rozmowyOdStartu) {
    const { h } = warsaw(c.data_zmiany);
    godziny.hist[h].proby += 1;
    if (h >= 8 && h < 20) {
      godziny.blok1315.wszystkie += 1;
      if (h >= 13 && h < 15) godziny.blok1315.proby += 1;
    }
    // Pierwszy kontakt W ŻYCIU z tym numerem po 19:00 = naruszenie.
    const wszystkieDoNumeru = wychodzace(phoneCalls(c.telefon));
    if (wszystkieDoNumeru.length && wszystkieDoNumeru[0].id === c.id && h >= 19) {
      godziny.pierwszePo19.push({ logId: c.id, telefon: last9(c.telefon), name: nameByPhone.get(last9(c.telefon)) || null, data: c.data_zmiany, godzina: h });
    }
  }
  godziny.blok1315.pct = pct(godziny.blok1315.proby, godziny.blok1315.wszystkie);
  godziny.hist = godziny.hist.filter((x) => x.proby > 0);

  // ── R5: obietnice (data_feedbacku_po ustawiona od startu) ────────────────
  const obietnicePerKlucz = new Map(); // telefon|due -> najwcześniejszy zapis
  const obietniceRaw = callsSorted.filter((c) => c.data_feedbacku_po && new Date(c.data_zmiany).getTime() >= startMs);
  for (const c of obietniceRaw) {
    const due = parseDataPL(c.data_feedbacku_po);
    const phone = last9(c.telefon);
    if (!due || !phone) continue;
    const key = `${phone}|${due}`;
    if (!obietnicePerKlucz.has(key)) obietnicePerKlucz.set(key, { phone, due, setAt: c.data_zmiany });
  }
  const obietniceAll = [...obietnicePerKlucz.values()];
  const obietnice = { dotrzymane: 0, zlamane: [], naDzis: [], n: 0 };
  for (const p of obietniceAll) {
    // Obietnica przełożona nowszym wpisem przed swoim terminem — nie oceniamy.
    const przelozona = obietniceAll.some((q) => q.phone === p.phone && q.due !== p.due &&
      new Date(q.setAt) > new Date(p.setAt) && warsaw(q.setAt).ymd <= p.due);
    if (przelozona) continue;
    if (p.due === todayYmd) { obietnice.naDzis.push({ telefon: p.phone, name: nameByPhone.get(p.phone) || null, due: p.due }); continue; }
    if (p.due > todayYmd) continue;
    obietnice.n += 1;
    const byl = phoneCalls(p.phone).some((c) => warsaw(c.data_zmiany).ymd === p.due);
    if (byl) obietnice.dotrzymane += 1;
    else obietnice.zlamane.push({ telefon: p.phone, name: nameByPhone.get(p.phone) || null, due: p.due, setAt: p.setAt });
  }
  obietnice.pct = pct(obietnice.dotrzymane, obietnice.n);
  obietnice.zlamane.sort((a, b) => (a.due < b.due ? 1 : -1));

  // ── R6: styl z karty ocen (flagi AI, ostatnie 7 dni) ─────────────────────
  const styl = { ocenionych: (scoresWeek || []).length, flagi: {} };
  for (const s of scoresWeek || []) {
    const f = s.flagi || {};
    for (const k of Object.keys(f)) if (f[k] === true) styl.flagi[k] = (styl.flagi[k] || 0) + 1;
  }

  // ── R7: uczciwy licznik — domknięte z dotkniętych ────────────────────────
  const cel = { target: 2, domkniete: [], sklepSam: 0 };
  for (const w of wycenyPaid || []) {
    const phone = last9(w.telefon_digits);
    const paidMs = w.paid_at ? new Date(w.paid_at).getTime() : null;
    if (!paidMs || paidMs < startMs) continue;
    const rozmowyPrzed = phone ? phoneCalls(phone).filter((c) =>
      c.kierunek === 'wychodzące' && c.disposition === 'answered' &&
      c.handlowiec === HANDLOWIEC && new Date(c.data_zmiany).getTime() < paidMs) : [];
    if (rozmowyPrzed.length > 0) {
      cel.domkniete.push({ wycenaId: w.id, kwota: Number(w.kwota_sprzedazy_brutto) || null, paidAt: w.paid_at, rozmow: rozmowyPrzed.length, name: w.imie_nazwisko || nameByPhone.get(phone) || null });
    } else {
      cel.sklepSam += 1;
    }
  }
  // Kontekst: nad iloma otwartymi wycenami realnie pracuje (rozmowa <7 dni).
  cel.wPracy = (wycenyOpen || []).filter((w) => {
    const phone = last9(w.telefon_digits);
    return phone && phoneCalls(phone).some((c) => c.disposition === 'answered' &&
      c.handlowiec === HANDLOWIEC && new Date(c.data_zmiany).getTime() >= weekMs);
  }).length;

  // ── Umierające leady (zbiorcza lista ostrzeżeń na górę panelu) ────────────
  const umierajace = [
    ...sla.czekaja.map((x) => ({ waga: 3, typ: 'PALI SIĘ', opis: `nowy lead bez ŻADNEJ próby od ${x.min >= 60 ? `${Math.round(x.min / 60)} h` : `${x.min} min`}`, ...x })),
    ...obietnice.zlamane.slice(0, 10).map((x) => ({ waga: 2, typ: 'ZŁAMANA OBIETNICA', opis: `umówiony kontakt ${x.due.slice(8, 10)}.${x.due.slice(5, 7)} — telefonu nie było`, ...x })),
    ...kadencja.umieraja.map((x) => ({ waga: 1, typ: 'CISZA', opis: `${x.proby} ${x.proby === 1 ? 'próba' : 'próby'}, cisza od ${x.dniCiszy} dni, bez umówionego terminu`, ...x })),
  ].sort((a, b) => b.waga - a.waga);

  // ── Statusy reguł (kolory na kafelkach) ──────────────────────────────────
  function statusReguly(key) {
    switch (key) {
      case 'sla': {
        const w = sla.tydzien; if (w.n === 0 && !sla.czekaja.length) return 'brak';
        if (sla.czekaja.length) return 'zle';
        return w.pct15 >= 80 ? 'ok' : w.pct15 >= 50 ? 'uwaga' : 'zle';
      }
      case 'kadencja':
        if (!kadencja.n) return 'brak';
        return kadencja.umieraja.length === 0 ? 'ok' : kadencja.umieraja.length <= 3 ? 'uwaga' : 'zle';
      case 'next_step': {
        const w = nextStep.tydzien; if (!w.n) return 'brak';
        return w.pct >= 90 ? 'ok' : w.pct >= 70 ? 'uwaga' : 'zle';
      }
      case 'godziny': {
        if (!godziny.blok1315.wszystkie) return 'brak';
        if (godziny.pierwszePo19.length > 3) return 'zle';
        if (godziny.pierwszePo19.length > 0 || (godziny.blok1315.pct ?? 0) < 25) return 'uwaga';
        return 'ok';
      }
      case 'obietnice':
        if (!obietnice.n) return 'brak';
        return obietnice.pct >= 90 ? 'ok' : obietnice.pct >= 70 ? 'uwaga' : 'zle';
      case 'styl': {
        if (!styl.ocenionych) return 'brak';
        const twarde = (styl.flagi.rabat_bez_zobowiazania || 0) + (styl.flagi.odeslanie_do_konkurencji || 0);
        return twarde === 0 ? 'ok' : twarde <= 2 ? 'uwaga' : 'zle';
      }
      case 'cel': {
        const dzien = Math.max(1, Math.floor((nowMs - startMs) / DZIEN_MS) + 1);
        if (cel.domkniete.length >= cel.target) return 'ok';
        if (dzien <= 10) return 'brak';
        return cel.domkniete.length >= 1 ? 'uwaga' : dzien > 15 ? 'zle' : 'uwaga';
      }
      default: return 'brak';
    }
  }

  const dzien = Math.max(1, Math.floor((nowMs - startMs) / DZIEN_MS) + 1);
  return {
    start, dzien, dniTestu: 30, todayYmd,
    nowychLeadow: noweLeady.length,
    reguly: REGULY.map((r) => ({ ...r, status: statusReguly(r.key) })),
    sla, kadencja, nextStep, godziny, obietnice, styl, cel, umierajace,
  };
}

// ── Wybór 5 rozmów na poniedziałkowy odsłuch ─────────────────────────────────
// 1 wzorcowa (najwyższa suma ocen) + 4 problemowe: najniższe sumy, ale każda
// z INNYM dominującym problemem, żeby odsłuch pokrywał różne wady, nie jedną.
function pickOdsluch(scores) {
  const KRYTERIA = ['otwarcie', 'potrzeba', 'wartosc', 'obiekcje', 'next_step'];
  const scored = (scores || []).filter((s) => !s.pominieta).map((s) => {
    const vals = KRYTERIA.map((k) => s.scores?.[k]).filter((v) => typeof v === 'number');
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    let dominujacy = null, minV = Infinity;
    for (const k of KRYTERIA) {
      const v = s.scores?.[k];
      if (typeof v === 'number' && v < minV) { minV = v; dominujacy = k; }
    }
    return { ...s, avg, dominujacy };
  }).filter((s) => s.avg != null);
  if (!scored.length) return { wzorcowa: null, problemowe: [] };

  const sorted = [...scored].sort((a, b) => b.avg - a.avg);
  const wzorcowa = sorted[0].avg >= 3 ? sorted[0] : null;
  const problemowe = [];
  const uzyte = new Set();
  for (const s of [...scored].sort((a, b) => a.avg - b.avg)) {
    if (wzorcowa && s.log_id === wzorcowa.log_id) continue;
    if (problemowe.length >= 4) break;
    if (uzyte.has(s.dominujacy) && problemowe.length < 3) continue; // preferuj różnorodność
    uzyte.add(s.dominujacy);
    problemowe.push(s);
  }
  // Dobicie do 4, jeśli różnorodność zjadła kandydatów.
  for (const s of [...scored].sort((a, b) => a.avg - b.avg)) {
    if (problemowe.length >= 4) break;
    if ((wzorcowa && s.log_id === wzorcowa.log_id) || problemowe.some((p) => p.log_id === s.log_id)) continue;
    problemowe.push(s);
  }
  return { wzorcowa, problemowe };
}

module.exports = { computeKokpit, pickOdsluch, parseDataPL, last9, warsaw, effectiveStartMs, REGULY, FINAL_STATUSY, HANDLOWIEC };
