// Testy modułu fb-csv-ingest (parsowanie eksportów Business Suite + multipart).
// Uruchamianie: node --test apps/shared/server/fb-csv-ingest.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { parseCsvBuffer, analyzeFiles, ingest, parseMultipart } = require('./fb-csv-ingest');

// Eksport FB = UTF-16LE z BOM, "sep=,", tytuł metryki w 2. linii, wiersze "ISO","liczba".
function fbCsv(title, rows) {
  const lines = ['sep=,', `"${title}"`, '"Data","Wartość"', ...rows.map(([d, v]) => `"${d}T00:00:00","${v}"`)];
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(lines.join('\r\n'), 'utf16le')]);
}

test('parseCsvBuffer: UTF-16LE z BOM, tytuł z 2. linii, daty z wierszy', () => {
  const buf = fbCsv('Wyświetlenia', [['2026-08-01', '123'], ['2026-08-02', '456']]);
  const { title, data } = parseCsvBuffer(buf);
  assert.equal(title, 'Wyświetlenia');
  assert.equal(data.get('2026-08-01'), 123);
  assert.equal(data.get('2026-08-02'), 456);
});

test('analyzeFiles: klasyfikacja po nagłówku, pomijanie Instagrama i nierozpoznanych', () => {
  const files = [
    { name: 'a.csv', buffer: fbCsv('Wyświetlenia', [['2026-08-01', '10']]) },
    { name: 'b.csv', buffer: fbCsv('Widzowie', [['2026-08-01', '7']]) },
    { name: 'c.csv', buffer: fbCsv('Interakcje z zawartością', [['2026-08-01', '3']]) },
    { name: 'd.csv', buffer: fbCsv('Kliknięcia linku na Facebooku', [['2026-08-01', '2']]) },
    { name: 'e.csv', buffer: fbCsv('Kliknięcia linku na Instagramie', [['2026-08-01', '9']]) },
    { name: 'f.csv', buffer: fbCsv('Coś zupełnie innego', [['2026-08-01', '1']]) },
  ];
  const { perMetric, raporty } = analyzeFiles(files);
  assert.deepEqual(Object.keys(perMetric).sort(), ['interactions', 'link_clicks', 'reach', 'views']);
  assert.equal(raporty.find((r) => r.plik === 'e.csv').status, 'instagram');
  assert.equal(raporty.find((r) => r.plik === 'f.csv').status, 'nierozpoznany');
  const ok = raporty.find((r) => r.plik === 'a.csv');
  assert.equal(ok.metryka, 'views');
  assert.equal(ok.dni, 1);
});

test('ingest: MERGE po dacie — dokłada klucze CSV, nie rusza visits/new_followers z API', async () => {
  const upserted = [];
  const db = {
    from: () => ({
      select: () => ({ eq: async () => ({ data: [{ date: '2026-08-01', metrics: { visits: 55, new_followers: 4, views: 999 } }], error: null }) }),
      upsert: async (rows) => { upserted.push(...rows); return { error: null }; },
    }),
  };
  const wynik = await ingest(db, [
    { name: 'w.csv', buffer: fbCsv('Wyświetlenia', [['2026-08-01', '100'], ['2026-08-02', '200']]) },
    { name: 'r.csv', buffer: fbCsv('Widzowie', [['2026-08-01', '70']]) },
  ]);
  assert.equal(wynik.dni, 2);
  assert.deepEqual(wynik.zakres, { od: '2026-08-01', do: '2026-08-02' });
  const d1 = upserted.find((r) => r.date === '2026-08-01');
  assert.equal(d1.metrics.views, 100);        // nadpisane z CSV
  assert.equal(d1.metrics.reach, 70);         // dołożone z CSV
  assert.equal(d1.metrics.visits, 55);        // z API — nietknięte
  assert.equal(d1.metrics.new_followers, 4);  // z API — nietknięte
  const d2 = upserted.find((r) => r.date === '2026-08-02');
  assert.equal(d2.metrics.views, 200);
  assert.equal(d2.metrics.reach, undefined);
});

test('parseMultipart: wyciąga pliki z surowego body (boundary, filename, binarnie)', () => {
  const boundary = '----testXYZ';
  const fileBuf = fbCsv('Widzowie', [['2026-08-03', '11']]);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="Widzowie (3).csv"\r\nContent-Type: text/csv\r\n\r\n`),
    fileBuf,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="pole"\r\n\r\nwartość\r\n--${boundary}--\r\n`),
  ]);
  const files = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
  assert.equal(files.length, 1); // pole tekstowe pominięte
  assert.equal(files[0].name, 'Widzowie (3).csv');
  const { title, data } = parseCsvBuffer(files[0].buffer);
  assert.equal(title, 'Widzowie');
  assert.equal(data.get('2026-08-03'), 11); // bufor binarnie nienaruszony (BOM UTF-16 przeżył)
});
