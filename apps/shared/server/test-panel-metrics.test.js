const test = require('node:test');
const assert = require('node:assert');
const { computeKokpit, pickOdsluch, parseDataPL, last9, effectiveStartMs, warsaw } = require('./test-panel-metrics');

// Stały "teraz" dla wszystkich testów: 10.08.2026 12:00 czasu Warszawy (UTC+2).
const NOW = new Date('2026-08-10T10:00:00Z');
const START = '2026-08-05T00:00:00Z';

function lead({ id, phone, date = '06.08.2026', created = '2026-08-06T08:00:00Z', stage = 'Nowy', feedback = null, name = 'Klient' }) {
  return {
    'ID Leada': id, Name: name, 'Phone number': phone, 'Deal stage': stage,
    Date: date, 'Data Feedbacku': feedback,
    marketing_meta: created ? { date_created: created } : null,
  };
}

let logId = 0;
function call({ phone, at, disp = 'answered', kier = 'wychodzące', sek = 120, statusPo = null, feedbackPo = null, kto = 'Lorenzo' }) {
  return {
    id: String(++logId), telefon: `48${phone}`, data_zmiany: at, kierunek: kier,
    disposition: disp, czas_trwania_s: sek, status_po: statusPo,
    data_feedbacku_po: feedbackPo, handlowiec: kto,
  };
}

test('parseDataPL i last9', () => {
  assert.equal(parseDataPL('05.08.2026'), '2026-08-05');
  assert.equal(parseDataPL('zle'), null);
  assert.equal(last9('48511222333'), '511222333');
  assert.equal(last9(48511222333), '511222333');
  assert.equal(last9('511 222 333'), '511222333');
});

test('effectiveStartMs: lead z nocy startuje o 9:00 Warszawy (uzgodnienie 6.08)', () => {
  // 23:30 Warszawy (21:30Z latem) -> zegar rusza nazajutrz o 9:00 (07:00Z).
  const nocny = Date.parse('2026-08-05T21:30:00Z');
  assert.equal(new Date(effectiveStartMs(nocny)).toISOString(), '2026-08-06T07:00:00.000Z');
  // 12:00 Warszawy — bez klamry.
  const dzienny = Date.parse('2026-08-05T10:00:00Z');
  assert.equal(effectiveStartMs(dzienny), dzienny);
  // 5:00 Warszawy (03:00Z) -> ten sam dzień 9:00.
  const ranny = Date.parse('2026-08-05T03:00:00Z');
  assert.equal(new Date(effectiveStartMs(ranny)).toISOString(), '2026-08-05T07:00:00.000Z');
});

test('R1: SLA liczy minuty od wpadnięcia i łapie czekających', () => {
  const leads = [
    lead({ id: 1, phone: '511111111', created: '2026-08-06T08:00:00Z' }), // telefon po 10 min
    lead({ id: 2, phone: '522222222', created: '2026-08-06T08:00:00Z' }), // telefon po 4 h
    lead({ id: 3, phone: '533333333', created: '2026-08-10T06:30:00Z' }), // nikt nie zadzwonił (3,5 h temu)
    lead({ id: 4, phone: '544444444', created: '2026-07-01T08:00:00Z' }), // sprzed startu — poza testem
  ];
  const calls = [
    call({ phone: '511111111', at: '2026-08-06T08:10:00Z', disp: 'no_answer', sek: 0 }),
    call({ phone: '522222222', at: '2026-08-06T12:00:00Z' }),
  ];
  const k = computeKokpit({ leads, calls, wycenyPaid: [], wycenyOpen: [], scoresWeek: [], now: NOW, start: START });
  assert.equal(k.nowychLeadow, 3);
  assert.equal(k.sla.total.n, 2);
  assert.equal(k.sla.total.mediana, Math.round((10 + 240) / 2));
  assert.equal(k.sla.total.pct15, 50);
  assert.equal(k.sla.naruszenia.length, 1);
  assert.equal(k.sla.naruszenia[0].id, 2);
  assert.equal(k.sla.czekaja.length, 1);
  assert.equal(k.sla.czekaja[0].id, 3);
  // lead z 8:30 Warszawy: zegar od 9:00 (07:00Z), teraz 10:00Z -> 180 min
  assert.ok(k.sla.czekaja[0].min >= 175 && k.sla.czekaja[0].min <= 185);
  // doZadzwonienia = leady bez ani jednej próby (pod żywy licznik /moje); tu tylko
  // lead 3 (1,2 mają telefon, 4 sprzed startu) — z effStartMs do tykania.
  assert.equal(k.sla.doZadzwonienia.length, 1);
  assert.equal(k.sla.doZadzwonienia[0].id, 3);
  assert.equal(typeof k.sla.doZadzwonienia[0].effStartMs, 'number');
});

test('R2: cisza 3 dni przy <5 probach = lead umiera; umówiony termin ratuje', () => {
  const leads = [
    lead({ id: 1, phone: '511111111', created: '2026-08-05T08:00:00Z' }), // 2 próby, cisza 4 dni
    lead({ id: 2, phone: '522222222', created: '2026-08-05T08:00:00Z', feedback: '12.08.2026' }), // cisza, ale umówiony termin
    lead({ id: 3, phone: '533333333', created: '2026-08-05T08:00:00Z', stage: 'Stracony' }), // finalny — nie liczymy
  ];
  const calls = [
    call({ phone: '511111111', at: '2026-08-05T09:00:00Z', disp: 'no_answer', sek: 0 }),
    call({ phone: '511111111', at: '2026-08-06T09:00:00Z', disp: 'no_answer', sek: 0 }),
    call({ phone: '522222222', at: '2026-08-06T09:00:00Z' }),
  ];
  const k = computeKokpit({ leads, calls, wycenyPaid: [], wycenyOpen: [], scoresWeek: [], now: NOW, start: START });
  assert.equal(k.kadencja.umieraja.length, 1);
  assert.equal(k.kadencja.umieraja[0].id, 1);
  assert.equal(k.kadencja.umieraja[0].dniCiszy, 4);
  assert.equal(k.kadencja.rozklad['1-2'], 2);
});

test('R3: rozmowa bez daty next stepu = naruszenie, Stracony = wyjątek', () => {
  const calls = [
    call({ phone: '511111111', at: '2026-08-06T10:00:00Z', feedbackPo: '08.08.2026' }), // ok
    call({ phone: '522222222', at: '2026-08-06T11:00:00Z' }),                            // bez daty
    call({ phone: '533333333', at: '2026-08-06T12:00:00Z', statusPo: 'Stracony' }),      // wyjątek
    call({ phone: '544444444', at: '2026-08-06T13:00:00Z', sek: 10 }),                   // <20 s — nie rozmowa
    call({ phone: '555555555', at: '2026-08-01T13:00:00Z' }),                            // sprzed startu
  ];
  const k = computeKokpit({ leads: [], calls, wycenyPaid: [], wycenyOpen: [], scoresWeek: [], now: NOW, start: START });
  assert.equal(k.nextStep.total.n, 3);
  assert.equal(k.nextStep.total.ok, 2);
  assert.equal(k.nextStep.bezDaty.length, 1);
  assert.equal(k.nextStep.bezDaty[0].telefon, '522222222');
});

test('R4: pierwszy kontakt w zyciu po 19 Warszawy = naruszenie, kolejny nie', () => {
  const calls = [
    // 19:30 Warszawy = 17:30Z — PIERWSZY kontakt z tym numerem.
    call({ phone: '511111111', at: '2026-08-06T17:30:00Z', disp: 'no_answer', sek: 0 }),
    // stary klient: pierwszy kontakt przed startem o 12:00, follow-up po 19 — legalny.
    call({ phone: '522222222', at: '2026-07-01T10:00:00Z' }),
    call({ phone: '522222222', at: '2026-08-06T17:40:00Z' }),
  ];
  const k = computeKokpit({ leads: [], calls, wycenyPaid: [], wycenyOpen: [], scoresWeek: [], now: NOW, start: START });
  assert.equal(k.godziny.pierwszePo19.length, 1);
  assert.equal(k.godziny.pierwszePo19[0].telefon, '511111111');
});

test('R4: blok 13-17 akceptowalny, 13-15 sweet spot (uzgodnienie 6.08)', () => {
  const calls = [
    call({ phone: '511111111', at: '2026-08-06T12:00:00Z' }), // 14:00 Warszawy — sweet spot 13-15 (i blok 13-17)
    call({ phone: '522222222', at: '2026-08-06T14:00:00Z' }), // 16:00 Warszawy — blok 13-17, poza sweet spotem
    call({ phone: '533333333', at: '2026-08-06T07:00:00Z' }), // 09:00 Warszawy — okno 8-20, poza blokiem
  ];
  const k = computeKokpit({ leads: [], calls, wycenyPaid: [], wycenyOpen: [], scoresWeek: [], now: NOW, start: START });
  assert.equal(k.godziny.blok.wszystkie, 3);
  assert.equal(k.godziny.blok.proby, 2);      // 14:00 i 16:00
  assert.equal(k.godziny.blok.sweet, 1);      // tylko 14:00
  assert.equal(k.godziny.blok.pct, 67);       // 2/3
  assert.equal(k.godziny.blok.pctSweet, 33);  // 1/3
});

test('R5: obietnica dotrzymana proba w dniu terminu, zlamana bez proby', () => {
  const calls = [
    // obietnica na 07.08 — była próba 7.08 (nawet nieodebrana) = dotrzymana
    call({ phone: '511111111', at: '2026-08-05T10:00:00Z', feedbackPo: '07.08.2026' }),
    call({ phone: '511111111', at: '2026-08-07T15:00:00Z', disp: 'no_answer', sek: 0 }),
    // obietnica na 08.08 — zero prób tego dnia = złamana
    call({ phone: '522222222', at: '2026-08-05T10:00:00Z', feedbackPo: '08.08.2026' }),
    // obietnica przełożona nowszym wpisem przed terminem — nie oceniamy starej
    call({ phone: '533333333', at: '2026-08-05T10:00:00Z', feedbackPo: '09.08.2026' }),
    call({ phone: '533333333', at: '2026-08-06T10:00:00Z', feedbackPo: '20.08.2026' }),
    // termin w przyszłości — jeszcze nie oceniamy
    call({ phone: '544444444', at: '2026-08-09T10:00:00Z', feedbackPo: '15.08.2026' }),
  ];
  const k = computeKokpit({ leads: [], calls, wycenyPaid: [], wycenyOpen: [], scoresWeek: [], now: NOW, start: START });
  assert.equal(k.obietnice.n, 2);
  assert.equal(k.obietnice.dotrzymane, 1);
  assert.equal(k.obietnice.zlamane.length, 1);
  assert.equal(k.obietnice.zlamane[0].telefon, '522222222');
});

test('R7: uczciwy licznik — liczy sie tylko sprzedaz po odebranej rozmowie Lorenza', () => {
  const calls = [
    call({ phone: '511111111', at: '2026-08-06T10:00:00Z' }), // rozmowa przed opłaceniem
    call({ phone: '533333333', at: '2026-08-08T10:00:00Z', kto: 'Antoni' }), // rozmowa, ale Antoniego
  ];
  const wycenyPaid = [
    { id: 900, telefon_digits: '511111111', paid_at: '2026-08-07T10:00:00Z', kwota_sprzedazy_brutto: '1500', imie_nazwisko: 'Jan' },
    { id: 901, telefon_digits: '522222222', paid_at: '2026-08-07T11:00:00Z', kwota_sprzedazy_brutto: '900' },  // sklep sam
    { id: 902, telefon_digits: '533333333', paid_at: '2026-08-09T11:00:00Z', kwota_sprzedazy_brutto: '700' },  // dotknął Antoni, nie Lorenzo
    { id: 903, telefon_digits: '511111111', paid_at: '2026-08-01T10:00:00Z', kwota_sprzedazy_brutto: '500' },  // sprzed startu
  ];
  const k = computeKokpit({ leads: [], calls, wycenyPaid, wycenyOpen: [], scoresWeek: [], now: NOW, start: START });
  assert.equal(k.cel.domkniete.length, 1);
  assert.equal(k.cel.domkniete[0].wycenaId, 900);
  assert.equal(k.cel.sklepSam, 2);
});

test('Wyceny do domkniecia: tylko otwarte wyceny handlowca, suma + sort', () => {
  const calls = [
    call({ phone: '511111111', at: '2026-08-06T10:00:00Z' }), // dotknięta rozmowa Lorenza
  ];
  const wycenyOpen = [
    { id: 1, telefon_digits: '511111111', status: 'Open', owner: 'Lorenzo', imie_nazwisko: 'Anna', kwota_proponowana_brutto: '2000', created_at: '2026-08-01T10:00:00Z' },   // dotknięta
    { id: 2, telefon_digits: '522222222', status: 'Open', owner: 'Lorenzo', imie_nazwisko: 'Bartek', kwota_proponowana_brutto: '3000', created_at: '2026-07-20T10:00:00Z' },  // nietknięta, starsza
    { id: 3, telefon_digits: '533333333', status: 'Open', owner: 'Antoni', kwota_proponowana_brutto: '9000', created_at: '2026-08-01T10:00:00Z' },                            // nie jego — pomijamy
  ];
  const k = computeKokpit({ leads: [], calls, wycenyPaid: [], wycenyOpen, scoresWeek: [], now: NOW, start: START });
  assert.equal(k.wyceny.n, 2);                 // tylko Lorenzo
  assert.equal(k.wyceny.sumaKwota, 5000);      // 2000 + 3000
  assert.equal(k.wyceny.dotknietych, 1);
  assert.equal(k.wyceny.lista[0].id, 1);       // dotknięta na górze
  assert.equal(k.wyceny.lista[0].dotkniete, true);
  assert.equal(k.wyceny.lista[1].id, 2);       // nietknięta niżej
  assert.equal(k.wyceny.lista[1].dotkniete, false);
});

test('Aktywnosc dzis: telefony/rozmowy/umowienia z dzisiejszego dnia Lorenza', () => {
  const calls = [
    call({ phone: '511111111', at: '2026-08-10T09:00:00Z' }),                              // dziś, rozmowa (120s)
    call({ phone: '511111111', at: '2026-08-10T10:00:00Z', disp: 'no_answer', sek: 0 }),   // dziś, telefon nieodebrany
    call({ phone: '522222222', at: '2026-08-10T08:00:00Z', feedbackPo: '12.08.2026' }),    // dziś, rozmowa + umówienie
    call({ phone: '533333333', at: '2026-08-09T09:00:00Z' }),                              // wczoraj — nie liczy
    call({ phone: '544444444', at: '2026-08-10T09:00:00Z', kto: 'Antoni' }),               // dziś, ale Antoni
  ];
  const k = computeKokpit({ leads: [], calls, wycenyPaid: [], wycenyOpen: [], scoresWeek: [], now: NOW, start: START });
  assert.equal(k.dzisiaj.telefony, 3);
  assert.equal(k.dzisiaj.rozmowy, 2);
  assert.equal(k.dzisiaj.umowienia, 1);
});

test('pickOdsluch: 1 wzorcowa + problemowe z roznymi dominujacymi wadami', () => {
  const mk = (log_id, scores) => ({ log_id, scores, flagi: {}, pominieta: false });
  const wynik = pickOdsluch([
    mk('a', { otwarcie: 5, potrzeba: 5, wartosc: 4, obiekcje: 5, next_step: 5 }), // wzorcowa
    mk('b', { otwarcie: 1, potrzeba: 3, wartosc: 3, obiekcje: 3, next_step: 3 }), // wada: otwarcie
    mk('c', { otwarcie: 3, potrzeba: 1, wartosc: 3, obiekcje: 3, next_step: 3 }), // wada: potrzeba
    mk('d', { otwarcie: 3, potrzeba: 3, wartosc: 1, obiekcje: 3, next_step: 3 }), // wada: wartość
    mk('e', { otwarcie: 2, potrzeba: 3, wartosc: 3, obiekcje: 3, next_step: 3 }), // wada: otwarcie (dubel)
    mk('f', { otwarcie: 3, potrzeba: 3, wartosc: 3, obiekcje: 3, next_step: 1 }), // wada: next_step
  ]);
  assert.equal(wynik.wzorcowa.log_id, 'a');
  assert.equal(wynik.problemowe.length, 4);
  const dominujace = wynik.problemowe.map((p) => p.dominujacy);
  assert.deepEqual([...new Set(dominujace)].sort(), ['next_step', 'otwarcie', 'potrzeba', 'wartosc']);
});

test('pickOdsluch: brak wzorcowej gdy wszystko slabe', () => {
  const wynik = pickOdsluch([
    { log_id: 'x', scores: { otwarcie: 1, potrzeba: 2, wartosc: 1, obiekcje: 2, next_step: 1 }, flagi: {}, pominieta: false },
  ]);
  assert.equal(wynik.wzorcowa, null);
  assert.equal(wynik.problemowe.length, 1);
});
