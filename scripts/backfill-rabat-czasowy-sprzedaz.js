// Backfill: utrwalenie kwoty sprzedaży dla starych ZAMÓWIEŃ z rabatem czasowym.
// (decyzja Antoniego 2026-07-15, case #1809 Łukasz Mikoś: panel pokazywał 3200
// mimo rabatu do 2850). Od teraz formularz zamraża kwota_sprzedazy_brutto przy
// złożeniu, a panele/statystyki liczą "cenę realną" przez wyceny-cena.js
// (proponowana − rabat czasowy) nawet bez tej kolumny — więc backfill jest
// OPCJONALNY: robi tę samą liczbę TRWAŁĄ w bazie (odporność na późniejszą
// edycję rabatu, spójność faktur/eksportów).
//
// Ustawia kwota_sprzedazy_brutto = kwota_proponowana_brutto − rabat24h_kwota
// dla wierszy: typ ZAMÓWIENIE, rabat24h_kwota > 0, kwota_sprzedazy_brutto NULL,
// kwota_proponowana_brutto NOT NULL. Nie rusza wierszy z już zapisaną sprzedażą.
//
// Użycie:
//   node scripts/backfill-rabat-czasowy-sprzedaz.js            # DRY-RUN (podgląd)
//   node scripts/backfill-rabat-czasowy-sprzedaz.js --apply    # realny zapis
// Wzorzec połączenia jak scripts/backfill-wyceny-lead-id.js (pooler IPv6-only).
const path = require('path');
const KOM_SERVER = path.join(__dirname, '..', 'apps', 'komunikator', 'server');
require(path.join(KOM_SERVER, 'node_modules', 'dotenv')).config({ path: path.join(KOM_SERVER, '.env') });
const { Client } = require(path.join(KOM_SERVER, 'node_modules', 'pg'));

const APPLY = process.argv.includes('--apply');

function pooledUrl() {
  const url = new URL(process.env.DATABASE_URL);
  const projectRef = url.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/)?.[1];
  if (!projectRef) return process.env.DATABASE_URL;
  return `postgresql://postgres.${projectRef}:${url.password}@aws-0-eu-west-3.pooler.supabase.com:5432/postgres`;
}

async function main() {
  const client = new Client({ connectionString: pooledUrl() });
  await client.connect();
  try {
    const { rows } = await client.query(`
      select id, imie_nazwisko,
             kwota_proponowana_brutto,
             rabat24h_kwota,
             round((kwota_proponowana_brutto - rabat24h_kwota)::numeric, 2) as nowa_sprzedaz
      from wyceny
      where typ = 'ZAMÓWIENIE'
        and kwota_sprzedazy_brutto is null
        and rabat24h_kwota is not null and rabat24h_kwota > 0
        and kwota_proponowana_brutto is not null
      order by id
    `);

    console.log(`Znaleziono ${rows.length} zamówień z rabatem czasowym bez zapisanej kwoty sprzedaży:`);
    for (const r of rows) {
      console.log(`  #${r.id} ${r.imie_nazwisko || ''} — ${r.kwota_proponowana_brutto} − ${r.rabat24h_kwota} = ${r.nowa_sprzedaz} zł`);
    }

    if (!rows.length) { console.log('Nic do zrobienia.'); return; }

    if (!APPLY) {
      console.log('\nDRY-RUN — nic nie zapisano. Uruchom z --apply, aby utrwalić.');
      return;
    }

    let n = 0;
    for (const r of rows) {
      await client.query(
        'update wyceny set kwota_sprzedazy_brutto = $1, updated_at = now() where id = $2 and kwota_sprzedazy_brutto is null',
        [r.nowa_sprzedaz, r.id]
      );
      n += 1;
    }
    console.log(`\nZapisano kwotę sprzedaży dla ${n} zamówień.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
