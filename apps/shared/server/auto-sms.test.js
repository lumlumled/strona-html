// Testy auto-SMS-a po nieodebranym (docs/plan-auto-sms-nieodebrane.md).
// To ścieżka pisząca DO KLIENTA — treści porównujemy CAŁE (zatwierdzone przez
// Antoniego, każda literówka składania ma tu poleć), bramkę reguła po regule,
// a wszystkie 18 kombinacji (2 scenariusze × 3 próby × 3 tory) przepuszczamy
// przez asercje anty-śmieciowe (null/undefined/podwójne spacje/em dash/emoji).
//   node --test  (z katalogu apps/shared/server)
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  dopasujZwrot, plDataSlownie, policzSegmenty, zbudujTrescAutoSms,
  ocenBramke, autoSmsPoNieodebranym, warsawDateStr,
} = require('./auto-sms');

// Lipiec = UTC+2 w Warszawie: godzina warszawska H == H-2 UTC.
function warsawNoon() { return new Date('2026-07-23T10:00:00Z'); } // 12:00 WAW

// ── Wołacz i płeć ────────────────────────────────────────────────────────────

test('dopasujZwrot: pełne imię i nazwisko, wielkość liter bez znaczenia', () => {
  assert.deepEqual(dopasujZwrot('Grzegorz Kowalski'), { tor: 'pan', wolacz: 'Grzegorzu' });
  assert.deepEqual(dopasujZwrot('zofia'), { tor: 'pani', wolacz: 'Zofio' });
  assert.deepEqual(dopasujZwrot('MICHAŁ nowak'), { tor: 'pan', wolacz: 'Michale' });
});

test('dopasujZwrot: imiona męskie na -a nie są zgadywane jako kobiece', () => {
  assert.deepEqual(dopasujZwrot('Kuba'), { tor: 'pan', wolacz: 'Kubo' });
});

test('dopasujZwrot: śmieciowe Name → tor Państwo, zero zgadywania', () => {
  for (const junk of ['Firma XYZ', '', null, undefined, 'G', 'Xavier', '123', 'lumlum.co']) {
    assert.equal(dopasujZwrot(junk).tor, 'panstwo', `junk: ${JSON.stringify(junk)}`);
    assert.equal(dopasujZwrot(junk).wolacz, null);
  }
});

// ── Data słownie ─────────────────────────────────────────────────────────────

test('plDataSlownie: dopełniacz, rok tylko gdy inny niż bieżący', () => {
  const now = warsawNoon(); // 2026
  assert.equal(plDataSlownie('2026-07-03T08:00:00Z', now), '3 lipca');
  assert.equal(plDataSlownie('2025-07-03T08:00:00Z', now), '3 lipca 2025');
  assert.equal(plDataSlownie('nie-data', now), null);
  // Północ UTC to już następny dzień w Warszawie (UTC+2 latem).
  assert.equal(plDataSlownie('2026-07-03T23:30:00Z', now), '4 lipca');
});

// ── Segmenty ─────────────────────────────────────────────────────────────────

test('policzSegmenty: GSM-7 vs UCS-2', () => {
  assert.equal(policzSegmenty('a'.repeat(160)), 1);
  assert.equal(policzSegmenty('a'.repeat(161)), 2);
  assert.equal(policzSegmenty('ą' + 'a'.repeat(69)), 1); // 70 znaków UCS-2
  assert.equal(policzSegmenty('ą' + 'a'.repeat(70)), 2); // 71 → 2 segmenty
});

// ── Treści: pełne stringi zatwierdzone przez Antoniego ───────────────────────

test('FORMULARZ próba 1, tor Pan — pełna treść', () => {
  const { tresc, tor } = zbudujTrescAutoSms({ scenariusz: 'formularz', proba: 1, name: 'Grzegorz Kowalski' });
  assert.equal(tor, 'pan');
  assert.equal(tresc,
    'Dzień dobry Panie Grzegorzu, z tej strony Lorenzo z LumLum. '
    + 'Zostawił Pan u nas kontakt w formularzu w sprawie oświetlenia LED. '
    + 'Próbowałem się z Panem skontaktować telefonicznie, ale nie udało się nam połączyć. '
    + 'Proszę o informację, jaki dzień i godzina będą dla Pana dogodne - wtedy zadzwonię. '
    + 'Może Pan również oddzwonić na ten numer w dowolnym momencie. Jeśli nie, zadzwonię jutro ponownie.');
});

test('FORMULARZ próba 1, tor Państwo (brak imienia) — pełna treść', () => {
  const { tresc, tor } = zbudujTrescAutoSms({ scenariusz: 'formularz', proba: 1, name: 'Firma XYZ' });
  assert.equal(tor, 'panstwo');
  assert.equal(tresc,
    'Dzień dobry, z tej strony Lorenzo z LumLum. '
    + 'Zostawili Państwo u nas kontakt w formularzu w sprawie oświetlenia LED. '
    + 'Próbowałem się skontaktować telefonicznie, ale nie udało się nam połączyć. '
    + 'Proszę o informację, jaki dzień i godzina będą dogodne - wtedy zadzwonię. '
    + 'Można również oddzwonić na ten numer w dowolnym momencie. Jeśli nie, zadzwonię jutro ponownie.');
});

test('FORMULARZ próba 2, tor Pani — pełna treść', () => {
  const { tresc } = zbudujTrescAutoSms({ scenariusz: 'formularz', proba: 2, name: 'Zofia' });
  assert.equal(tresc,
    'Dzień dobry Pani Zofio, tu ponownie Lorenzo z LumLum. '
    + 'Dzwoniłem w sprawie oświetlenia LED, ale nie udało się nam połączyć. '
    + 'Proszę o informację, kiedy będzie dla Pani dogodny moment na rozmowę - zadzwonię w tym terminie. '
    + 'Można też oddzwonić na ten numer.');
});

test('FORMULARZ próba 3 — pożegnanie z ":)" (dokładnie ASCII, nie emoji)', () => {
  const { tresc } = zbudujTrescAutoSms({ scenariusz: 'formularz', proba: 3, name: 'Grzegorz' });
  assert.equal(tresc,
    'Dzień dobry Panie Grzegorzu, tu Lorenzo z LumLum. '
    + 'Nie chciałbym zostawić sprawy oświetlenia LED bez odpowiedzi, a nie udaje się nam połączyć. '
    + 'Jeśli temat jest nadal aktualny, proszę o wiadomość lub telefon na ten numer. '
    + 'Jeśli nie, proszę o krótką informację - wtedy nie będę już wracał do tematu :)');
  assert.ok(tresc.endsWith(':)'));
  assert.ok(!tresc.includes('😊'));
});

test('WYCENA próba 1, tor Pan, z datą i umówionym terminem na dziś', () => {
  const { tresc } = zbudujTrescAutoSms({
    scenariusz: 'wycena', proba: 1, name: 'Grzegorz',
    wycenaCreatedAt: '2026-07-03T08:00:00Z', umowioneDzis: true, now: warsawNoon(),
  });
  assert.equal(tresc,
    'Dzień dobry Panie Grzegorzu, z tej strony Lorenzo z LumLum. '
    + '3 lipca wysłaliśmy Panu wycenę oświetlenia LED. '
    + 'Umawialiśmy się, że odezwę się dzisiaj, ale nie udało się nam połączyć. '
    + 'Proszę o informację, kiedy mogę zadzwonić, lub o telefon na ten numer w dogodnym dla Pana momencie.');
});

test('WYCENA próba 1: bez daty i bez terminu — zdania degradują się bez śladu', () => {
  const { tresc } = zbudujTrescAutoSms({ scenariusz: 'wycena', proba: 1, name: '', now: warsawNoon() });
  assert.equal(tresc,
    'Dzień dobry, z tej strony Lorenzo z LumLum. '
    + 'Wysłaliśmy Państwu wycenę oświetlenia LED. '
    + 'Próbowałem się skontaktować telefonicznie, ale nie udało się nam połączyć. '
    + 'Proszę o informację, kiedy mogę zadzwonić, lub o telefon na ten numer w dogodnym momencie.');
});

test('WYCENA próba 2: stara wycena dostaje rok w dacie', () => {
  const { tresc } = zbudujTrescAutoSms({
    scenariusz: 'wycena', proba: 2, name: 'Zofia',
    wycenaCreatedAt: '2025-07-03T08:00:00Z', now: warsawNoon(),
  });
  assert.equal(tresc,
    'Dzień dobry Pani Zofio, tu Lorenzo z LumLum. '
    + 'Wracam do wyceny oświetlenia LED z 3 lipca 2025. '
    + 'Próbowałem się z Panią skontaktować telefonicznie, ale nie udało się nam połączyć. '
    + 'Proszę o informację, kiedy będzie dla Pani dogodny moment na rozmowę.');
});

test('wszystkie 18 kombinacji: bez null/undefined/podwójnych spacji/em dash, rozsądna długość', () => {
  const wyniki = [];
  for (const scenariusz of ['formularz', 'wycena']) {
    for (const proba of [1, 2, 3]) {
      for (const name of ['Włodzimierz Brzęczyszczykiewicz', 'Zofia', 'Firma XYZ']) {
        const { tresc, segmenty, tor } = zbudujTrescAutoSms({
          scenariusz, proba, name,
          wycenaCreatedAt: scenariusz === 'wycena' ? '2026-07-03T08:00:00Z' : null,
          umowioneDzis: false, now: warsawNoon(),
        });
        assert.ok(!/null|undefined/.test(tresc), `${scenariusz}/${proba}/${tor}: śmieć w treści`);
        assert.ok(!tresc.includes('  '), `${scenariusz}/${proba}/${tor}: podwójna spacja`);
        assert.ok(!tresc.includes('—'), `${scenariusz}/${proba}/${tor}: em dash`);
        assert.ok(!tresc.includes('😊'), `${scenariusz}/${proba}/${tor}: emoji zamiast :)`);
        assert.ok(tresc.startsWith('Dzień dobry'), `${scenariusz}/${proba}/${tor}: złe otwarcie`);
        assert.ok(segmenty <= 6, `${scenariusz}/${proba}/${tor}: ${segmenty} segmentów (za drogo)`);
        wyniki.push(`${scenariusz} p${proba} ${tor}: ${tresc.length} zn., ${segmenty} seg.`);
      }
    }
  }
  console.log('\n' + wyniki.join('\n'));
});

// ── Bramka ───────────────────────────────────────────────────────────────────

const BAZOWA = {
  wlaczone: true, label: 'no_answer', kierunek: 'wychodzące', digits: '48604650590',
  leadClosed: false, maLeada: true, leadZrodlo: null, maWycene: false,
  hh: 12, mm: 0, dzisOut: 0, autoCount: 0, pierwszyAutoAt: null,
  nowMs: Date.parse('2026-07-23T10:00:00Z'),
};

test('bramka: happy path → formularz, próba 1', () => {
  assert.deepEqual(ocenBramke(BAZOWA), { wysylac: true, scenariusz: 'formularz', proba: 1 });
});

test('bramka: wycena wygrywa nad formularzem, próba = liczba auto+1', () => {
  const r = ocenBramke({ ...BAZOWA, maWycene: true, autoCount: 1, pierwszyAutoAt: '2026-07-22T10:00:00Z' });
  assert.deepEqual(r, { wysylac: true, scenariusz: 'wycena', proba: 2 });
});

test('bramka: każda reguła odmawia z własnym powodem', () => {
  const przypadki = [
    [{ wlaczone: false }, 'wylaczone_env'],
    [{ label: 'answered' }, 'odebrane'],
    [{ kierunek: 'przychodzące' }, 'kierunek_nie_wychodzace'],
    [{ digits: '12345' }, 'brak_numeru'],
    [{ leadClosed: true }, 'lead_zamkniety'],
    [{ maLeada: false, maWycene: false }, 'brak_dopasowania'],
    [{ leadZrodlo: 'Zadarma — rozmowa bez dopasowania w bazie' }, 'lead_spoza_formularza'],
    [{ hh: 7, mm: 59 }, 'poza_godzinami'],
    [{ hh: 20, mm: 31 }, 'poza_godzinami'],
    [{ dzisOut: 1 }, 'sms_dzis_juz_byl'],
    [{ autoCount: 3, pierwszyAutoAt: '2026-07-22T10:00:00Z' }, 'limit_3_wyczerpany'],
    [{ autoCount: 1, pierwszyAutoAt: '2026-07-10T10:00:00Z' }, 'okno_7_dni_minelo'],
  ];
  for (const [zmiana, powod] of przypadki) {
    const r = ocenBramke({ ...BAZOWA, ...zmiana });
    assert.equal(r.wysylac, false, JSON.stringify(zmiana));
    assert.equal(r.powod, powod, JSON.stringify(zmiana));
  }
});

test('bramka: granice okna godzin (8:00 i 20:30 włącznie)', () => {
  assert.equal(ocenBramke({ ...BAZOWA, hh: 8, mm: 0 }).wysylac, true);
  assert.equal(ocenBramke({ ...BAZOWA, hh: 20, mm: 30 }).wysylac, true);
});

test('bramka: lead spoza formularza Z wyceną dostaje scenariusz wycena', () => {
  const r = ocenBramke({ ...BAZOWA, leadZrodlo: 'Zadarma — rozmowa bez dopasowania w bazie', maWycene: true });
  assert.deepEqual(r, { wysylac: true, scenariusz: 'wycena', proba: 1 });
});

// ── Orkiestrator (deps wstrzykiwane — bez bazy i bez Zadarmy) ────────────────

function leadFixture(extra = {}) {
  return {
    'ID Leada': 500, Name: 'Grzegorz Kowalski', 'Phone number': 48604650590,
    'Historia rozmów': 'stare wpisy', Źródło: null, ...extra,
  };
}

function zerowaHistoria() {
  return async () => ({ dzisOut: 0, autoCount: 0, pierwszyAutoAt: null });
}

test('orkiestrator: wysyłka formularz p1 — send dostaje auto_sms i świeżego leada', async () => {
  process.env.AUTO_SMS_NIEODEBRANE = '1';
  try {
    const wyslane = [];
    const freshLead = leadFixture({ 'Historia rozmów': 'świeże wpisy po RPC' });
    const wynik = await autoSmsPoNieodebranym({}, {
      digits: '48604650590', kierunek: 'wychodzące', lead: leadFixture(),
      leadClosed: false, feedbackBefore: null, senderName: 'Lorenzo',
      pbxCallId: 'out_test1', now: warsawNoon(),
      refetchLead: async () => freshLead,
      deps: {
        historiaSmsNumeru: zerowaHistoria(),
        znajdzOtwartaWycene: async () => null,
        send: async (db, args) => { wyslane.push(args); return { ok: true, koszt: 0.35 }; },
      },
    });
    assert.equal(wynik.status, 'sent');
    assert.equal(wynik.scenariusz, 'formularz');
    assert.equal(wynik.proba, 1);
    assert.ok(wynik.tresc.startsWith('Dzień dobry Panie Grzegorzu'));
    assert.equal(wyslane.length, 1);
    assert.equal(wyslane[0].zrodlo, 'auto_sms');
    assert.equal(wyslane[0].senderName, 'Lorenzo');
    assert.equal(wyslane[0].lead, freshLead); // świeży, nie stary — [SMS→] nie zgubi wpisu rozmowy
    assert.equal(wyslane[0].metaExtra.auto_sms.pbx_call_id, 'out_test1');
  } finally { delete process.env.AUTO_SMS_NIEODEBRANE; }
});

test('orkiestrator: wycena → scenariusz wycena z datą i terminem dziś', async () => {
  process.env.AUTO_SMS_NIEODEBRANE = '1';
  try {
    const wynik = await autoSmsPoNieodebranym({}, {
      digits: '48604650590', kierunek: 'wychodzące', lead: leadFixture(),
      feedbackBefore: warsawDateStr(warsawNoon()), now: warsawNoon(),
      deps: {
        historiaSmsNumeru: zerowaHistoria(),
        znajdzOtwartaWycene: async () => ({ id: 1975, created_at: '2026-07-03T08:00:00Z', imie_nazwisko: 'Grzegorz Kowalski' }),
        send: async () => ({ ok: true }),
      },
    });
    assert.equal(wynik.status, 'sent');
    assert.equal(wynik.scenariusz, 'wycena');
    assert.ok(wynik.tresc.includes('3 lipca wysłaliśmy Panu'));
    assert.ok(wynik.tresc.includes('Umawialiśmy się, że odezwę się dzisiaj'));
  } finally { delete process.env.AUTO_SMS_NIEODEBRANE; }
});

test('orkiestrator: kill switch wyłączony → skip bez żadnych odczytów', async () => {
  delete process.env.AUTO_SMS_NIEODEBRANE;
  const wynik = await autoSmsPoNieodebranym({}, {
    digits: '48604650590', kierunek: 'wychodzące', lead: leadFixture(), now: warsawNoon(),
    deps: {
      historiaSmsNumeru: async () => { throw new Error('nie powinno się wydarzyć'); },
      znajdzOtwartaWycene: async () => { throw new Error('nie powinno się wydarzyć'); },
      send: async () => { throw new Error('nie powinno się wydarzyć'); },
    },
  });
  assert.deepEqual(wynik, { status: 'skip', powod: 'wylaczone_env' });
});

test('orkiestrator: SMS dziś już był → skip, send nietknięty', async () => {
  process.env.AUTO_SMS_NIEODEBRANE = '1';
  try {
    let sendCalls = 0;
    const wynik = await autoSmsPoNieodebranym({}, {
      digits: '48604650590', kierunek: 'wychodzące', lead: leadFixture(), now: warsawNoon(),
      deps: {
        historiaSmsNumeru: async () => ({ dzisOut: 1, autoCount: 1, pierwszyAutoAt: '2026-07-23T06:00:00Z' }),
        znajdzOtwartaWycene: async () => null,
        send: async () => { sendCalls += 1; return { ok: true }; },
      },
    });
    assert.deepEqual(wynik, { status: 'skip', powod: 'sms_dzis_juz_byl' });
    assert.equal(sendCalls, 0);
  } finally { delete process.env.AUTO_SMS_NIEODEBRANE; }
});

test('orkiestrator: błąd odczytu liczników → fail-closed skip', async () => {
  process.env.AUTO_SMS_NIEODEBRANE = '1';
  try {
    const wynik = await autoSmsPoNieodebranym({}, {
      digits: '48604650590', kierunek: 'wychodzące', lead: leadFixture(), now: warsawNoon(),
      deps: {
        historiaSmsNumeru: async () => { throw new Error('baza padła'); },
        znajdzOtwartaWycene: async () => null,
        send: async () => { throw new Error('nie powinno się wydarzyć'); },
      },
    });
    assert.equal(wynik.status, 'skip');
    assert.ok(wynik.powod.startsWith('blad_odczytu'));
  } finally { delete process.env.AUTO_SMS_NIEODEBRANE; }
});

test('orkiestrator: błąd wysyłki → status error z treścią (do sms_wyslany "BŁĄD: …")', async () => {
  process.env.AUTO_SMS_NIEODEBRANE = '1';
  try {
    const wynik = await autoSmsPoNieodebranym({}, {
      digits: '48604650590', kierunek: 'wychodzące', lead: leadFixture(), now: warsawNoon(),
      deps: {
        historiaSmsNumeru: zerowaHistoria(),
        znajdzOtwartaWycene: async () => null,
        send: async () => { throw new Error('Zadarma SMS: not enough money'); },
      },
    });
    assert.equal(wynik.status, 'error');
    assert.equal(wynik.blad, 'Zadarma SMS: not enough money');
    assert.ok(wynik.tresc.length > 0);
  } finally { delete process.env.AUTO_SMS_NIEODEBRANE; }
});

test('orkiestrator: poza godzinami (21:00 Warszawa) → skip', async () => {
  process.env.AUTO_SMS_NIEODEBRANE = '1';
  try {
    const wynik = await autoSmsPoNieodebranym({}, {
      digits: '48604650590', kierunek: 'wychodzące', lead: leadFixture(),
      now: new Date('2026-07-23T19:00:00Z'), // 21:00 WAW
      deps: {
        historiaSmsNumeru: zerowaHistoria(),
        znajdzOtwartaWycene: async () => null,
        send: async () => { throw new Error('nie powinno się wydarzyć'); },
      },
    });
    assert.deepEqual(wynik, { status: 'skip', powod: 'poza_godzinami' });
  } finally { delete process.env.AUTO_SMS_NIEODEBRANE; }
});

test('orkiestrator: kierunek przychodzące → skip zanim dotkniemy bazy', async () => {
  process.env.AUTO_SMS_NIEODEBRANE = '1';
  try {
    const wynik = await autoSmsPoNieodebranym({}, {
      digits: '48604650590', kierunek: 'przychodzące', lead: leadFixture(), now: warsawNoon(),
      deps: {
        historiaSmsNumeru: async () => { throw new Error('nie powinno się wydarzyć'); },
        znajdzOtwartaWycene: async () => { throw new Error('nie powinno się wydarzyć'); },
        send: async () => { throw new Error('nie powinno się wydarzyć'); },
      },
    });
    assert.deepEqual(wynik, { status: 'skip', powod: 'kierunek_nie_wychodzace' });
  } finally { delete process.env.AUTO_SMS_NIEODEBRANE; }
});

test('orkiestrator: kontakt bez leada i bez wyceny → skip brak_dopasowania', async () => {
  process.env.AUTO_SMS_NIEODEBRANE = '1';
  try {
    const wynik = await autoSmsPoNieodebranym({}, {
      digits: '48604650590', kierunek: 'wychodzące', lead: null, now: warsawNoon(),
      deps: {
        historiaSmsNumeru: zerowaHistoria(),
        znajdzOtwartaWycene: async () => null,
        send: async () => { throw new Error('nie powinno się wydarzyć'); },
      },
    });
    assert.deepEqual(wynik, { status: 'skip', powod: 'brak_dopasowania' });
  } finally { delete process.env.AUTO_SMS_NIEODEBRANE; }
});

test('orkiestrator: wycena-sierota (bez leada) → scenariusz wycena, imię z wyceny', async () => {
  process.env.AUTO_SMS_NIEODEBRANE = '1';
  try {
    const wynik = await autoSmsPoNieodebranym({}, {
      digits: '48604650590', kierunek: 'wychodzące', lead: null, now: warsawNoon(),
      deps: {
        historiaSmsNumeru: zerowaHistoria(),
        znajdzOtwartaWycene: async () => ({ id: 2001, created_at: '2026-07-20T08:00:00Z', imie_nazwisko: 'Zofia Nowak' }),
        send: async () => ({ ok: true }),
      },
    });
    assert.equal(wynik.status, 'sent');
    assert.equal(wynik.scenariusz, 'wycena');
    assert.ok(wynik.tresc.startsWith('Dzień dobry Pani Zofio'));
  } finally { delete process.env.AUTO_SMS_NIEODEBRANE; }
});
