// Jednorazowe czyszczenie "Produkty z wyceny" w Leady B2C ze śmieci po
// starej automatyzacji (stary prompt webhooka / Make), która pakowała do
// jednej kolumny telefon, produkty z placeholderami i cenę:
//   "tel. +48507576305 ? m - Analogowa taśma COB IP20 Cena za całość: 75 zł"
//
// Zasada Antoniego: ta kolumna to TWARDY DOWÓD pod wycenę — zostają
// wyłącznie produkty z konkretną, znaną ilością. Czyli:
//   - prefiks "tel. +48..." → out (telefon ma swoją kolumnę),
//   - "Cena za całość: N zł" → out; jeśli padła kwota, a "Kwota wyceny"
//     jest pusta, kwota ląduje w "Kwota wyceny" (cena ma osobną kolumnę),
//   - linie z niepewną ilością ("? m", "? szt", "? zes") → out,
//   - pewne linie normalizowane do formatu nowego promptu (patrz ZASADY
//     POLA produkty w buildCallAnalysisPrompt): "10m Nazwa" dla taśm,
//     "2 Nazwa" dla reszty (bez myślnika, bez "szt"/"zes"),
//   - jeśli nic nie zostaje → NULL.
// Wiersze bez wzorca tel/Cena za całość zostają nietknięte.
//
// Idempotentny (wyczyszczona wartość nie zawiera już wzorców). Zapis w
// transakcji z app.bypass_log_zmian — bez fałszywych wpisów w Log zmian.
//
// Uruchomienie:  node scripts/clean-produkty-z-wyceny.js          (dry-run)
//                node scripts/clean-produkty-z-wyceny.js --apply
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

// Bezpośredni host db.*.supabase.co jest IPv6-only — łączymy się przez pooler.
function pooledUrl() {
  const url = new URL(process.env.DATABASE_URL);
  const ref = url.hostname.match(/^db\.([^.]+)\.supabase\.co$/)?.[1];
  if (!ref) return process.env.DATABASE_URL;
  return `postgresql://postgres.${ref}:${url.password}@aws-0-eu-west-3.pooler.supabase.com:5432/postgres`;
}

// Zwraca { produkty: string|null, kwota: number|null } albo null, gdy wartość
// nie pasuje do śmieciowego wzorca (wtedy zostawiamy wiersz w spokoju).
function cleanValue(raw) {
  const s = String(raw || '').trim();
  if (!/tel\. *\+?\d+/.test(s) && !/Cena za całość:/.test(s)) return null;

  let kwota = null;
  const kwotaMatch = s.match(/Cena za całość:\s*(\d[\d\s]*)\s*zł?/);
  if (kwotaMatch) {
    const n = Number(kwotaMatch[1].replace(/\s/g, ''));
    if (Number.isFinite(n) && n > 0) kwota = n;
  }

  const middle = s
    .replace(/tel\. *\+?\d+/g, '')
    .replace(/Cena za całość:.*$/s, '')
    .trim();

  const lines = middle
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    // Niepewna ilość ("? m - ...") = nie produkt z wyceny, tylko szum.
    .filter((l) => !l.startsWith('?'))
    .map((l) => {
      const m = /^(\d+(?:[.,]\d+)?) *(m|szt|zes)? *[-–—]? *(.+)$/.exec(l);
      if (!m) return l;
      const [, qty, unit, name] = m;
      return unit === 'm' ? `${qty}m ${name.trim()}` : `${qty} ${name.trim()}`;
    });

  return { produkty: lines.length ? lines.join('\n') : null, kwota };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const client = new Client({ connectionString: pooledUrl() });
  await client.connect();

  const { rows } = await client.query(
    `select "ID Leada", "Name", "Produkty z wyceny", "Kwota wyceny"
     from "Leady B2C"
     where "Produkty z wyceny" is not null and "Produkty z wyceny" <> ''`
  );

  const changes = [];
  for (const row of rows) {
    const cleaned = cleanValue(row['Produkty z wyceny']);
    if (!cleaned) continue;
    const patch = {};
    if (cleaned.produkty !== row['Produkty z wyceny']) patch['Produkty z wyceny'] = cleaned.produkty;
    if (cleaned.kwota !== null && row['Kwota wyceny'] == null) patch['Kwota wyceny'] = cleaned.kwota;
    if (Object.keys(patch).length) changes.push({ id: Number(row['ID Leada']), name: row['Name'], patch });
  }

  console.log(`Wierszy z produktami: ${rows.length}, do wyczyszczenia: ${changes.length}.`);
  for (const ch of changes) {
    const p = ch.patch['Produkty z wyceny'];
    const k = ch.patch['Kwota wyceny'];
    console.log(`  ~ [${ch.id}] ${ch.name}: produkty → ${p === null ? 'NULL' : JSON.stringify(p)}${k !== undefined ? ` | Kwota wyceny → ${k}` : ''}`);
  }

  if (!apply) {
    console.log('\nDry-run — nic nie zapisano. Uruchom z --apply, żeby zastosować.');
    await client.end();
    return;
  }

  await client.query('begin');
  try {
    await client.query(`select set_config('app.bypass_log_zmian', 'on', true)`);
    for (const ch of changes) {
      const cols = Object.keys(ch.patch);
      const sets = cols.map((c, i) => `"${c}" = $${i + 1}`).join(', ');
      await client.query(
        `update "Leady B2C" set ${sets} where "ID Leada" = $${cols.length + 1}`,
        [...cols.map((c) => ch.patch[c]), ch.id]
      );
    }
    await client.query('commit');
    console.log(`\nZapisano ${changes.length} wierszy.`);
  } catch (err) {
    await client.query('rollback');
    throw err;
  }
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
