// Backfill wyceny.lead_id + wyrównanie ownera do ownera leada.
// (decyzja Antoniego 2026-07-12: wycena podpięta pod leada = jeden właściciel
// tematu; feedback wyceny wchodzi na leada — patrz propagateFeedbackToLead
// w apps/shared/server/wyceny-endpoints.js).
//
// Kroki:
//  1) lead_id z legacy kolumny "Leady B2C"."ID" ('#<id wyceny>' z Make) —
//     najpewniejsze źródło, powiązanie istniało już w arkuszu.
//  2) lead_id po telefonie/e-mailu — TYLKO gdy pasuje dokładnie jeden lead
//     (niejednoznaczne wypisujemy, nie zgadujemy).
//  3) owner = owner leada dla wycen z lead_id — TYLKO typ WYCENA i status
//     Open. Zamówień/zamkniętych celowo nie ruszamy: owner sprzedaży zasila
//     statystyki i widoczność (sprzedaże są prywatne per owner).
//
// Użycie: node scripts/backfill-wyceny-lead-id.js [--dry-run]
// Wzorzec połączenia jak scripts/run-sql.js (pooler — db.* jest IPv6-only).
const path = require('path');
const KOM_SERVER = path.join(__dirname, '..', 'apps', 'komunikator', 'server');
require(path.join(KOM_SERVER, 'node_modules', 'dotenv')).config({ path: path.join(KOM_SERVER, '.env') });
const { Client } = require(path.join(KOM_SERVER, 'node_modules', 'pg'));

const DRY = process.argv.includes('--dry-run');

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
    // Mapa dopasowań po tel/mailu — używana też jako bezpiecznik kroku 1:
    // gdy legacy "ID" wskazuje INNEGO leada niż telefon/e-mail wyceny,
    // nie zgadujemy (przykład: wycena 1868 — "ID" u Mroza, telefon Kurzacza).
    const contactRows = await client.query(`
      select w.id as wycena_id, array_agg(distinct l."ID Leada") as lead_ids
      from wyceny w
      join "Leady B2C" l on (
        (w.telefon_digits is not null and w.telefon_digits <> ''
          and l."Phone number"::text in (w.telefon_digits, '48' || w.telefon_digits))
        or (w.email is not null and w.email <> '' and lower(l."Email") = lower(w.email))
      )
      where w.lead_id is null
      group by w.id
    `);
    // "ID Leada" to numeric i potrafi przyjść jako "314.0" — kanoniczny format
    // lead_id w wycenach to liczba całkowita jako tekst ("314").
    const normId = (v) => String(Math.trunc(Number(v)));
    const contactMap = new Map(contactRows.rows.map((r) => [r.wycena_id, r.lead_ids.map(normId)]));

    // 1) Po kolumnie "ID" ('#1695' itd.) — pomijamy '#', które pasuje do >1 leada.
    const byId = await client.query(`
      select w.id as wycena_id, l."ID Leada" as lead_id, l."Name" as name
      from wyceny w
      join "Leady B2C" l on l."ID" = '#' || w.id::text
      where w.lead_id is null
        and (select count(*) from "Leady B2C" l2 where l2."ID" = l."ID") = 1
    `);
    console.log(`[1] po kolumnie "ID": ${byId.rows.length} wycen do spięcia`);
    const assigned = new Set();
    for (const r of byId.rows) {
      const contactLeads = contactMap.get(r.wycena_id);
      if (contactLeads && !contactLeads.includes(normId(r.lead_id))) {
        console.log(`    KONFLIKT (do ręcznej decyzji): wycena ${r.wycena_id} — "ID" u leada ${r.lead_id} (${r.name}), tel/mail pasuje do ${contactLeads.join(', ')}`);
        assigned.add(r.wycena_id); // blokujemy też krok 2 — sporny przypadek
        continue;
      }
      console.log(`    wycena ${r.wycena_id} -> lead ${r.lead_id} (${r.name})`);
      assigned.add(r.wycena_id);
      if (!DRY) {
        await client.query('update wyceny set lead_id=$1 where id=$2 and lead_id is null', [normId(r.lead_id), r.wycena_id]);
      }
    }

    // 2) Po telefonie/e-mailu — tylko jednoznaczne (dokładnie 1 lead).
    const byContact = await client.query(`
      select w.id as wycena_id,
             array_agg(distinct l."ID Leada") as lead_ids,
             min(l."Name") as name
      from wyceny w
      join "Leady B2C" l on (
        (w.telefon_digits is not null and w.telefon_digits <> ''
          and l."Phone number"::text in (w.telefon_digits, '48' || w.telefon_digits))
        or (w.email is not null and w.email <> '' and lower(l."Email") = lower(w.email))
      )
      where w.lead_id is null
      group by w.id
      order by w.id
    `);
    const fresh = byContact.rows.filter((r) => !assigned.has(r.wycena_id));
    const unique = fresh.filter((r) => r.lead_ids.length === 1);
    const ambiguous = fresh.filter((r) => r.lead_ids.length > 1);
    console.log(`[2] po tel/mailu: ${unique.length} jednoznacznych, ${ambiguous.length} niejednoznacznych (pominięte)`);
    for (const r of unique) {
      console.log(`    wycena ${r.wycena_id} -> lead ${normId(r.lead_ids[0])} (${r.name})`);
      if (!DRY) {
        await client.query('update wyceny set lead_id=$1 where id=$2 and lead_id is null', [normId(r.lead_ids[0]), r.wycena_id]);
      }
    }
    ambiguous.forEach((r) => console.log(`    POMINIĘTE (${r.lead_ids.length} leadów): wycena ${r.wycena_id} -> leady ${r.lead_ids.join(', ')}`));

    // 3) Owner wyceny = owner leada (tylko otwarte WYCENY — patrz nagłówek).
    const owners = await client.query(`
      select w.id as wycena_id, w.owner as stary, l."Owner" as nowy, w.typ, w.status
      from wyceny w
      join "Leady B2C" l on l."ID Leada" = (w.lead_id)::numeric
      where w.lead_id is not null
        and l."Owner" is not null and l."Owner" <> ''
        and (w.owner is distinct from l."Owner")
    `);
    const toSync = owners.rows.filter((r) => r.typ === 'WYCENA' && r.status === 'Open');
    const skipped = owners.rows.filter((r) => !(r.typ === 'WYCENA' && r.status === 'Open'));
    console.log(`[3] owner z leada: ${toSync.length} do zmiany, ${skipped.length} pominiętych (zamówienia/zamknięte)`);
    for (const r of toSync) {
      console.log(`    wycena ${r.wycena_id}: ${r.stary} -> ${r.nowy}`);
      if (!DRY) {
        await client.query('update wyceny set owner=$1 where id=$2', [r.nowy, r.wycena_id]);
      }
    }
    skipped.forEach((r) => console.log(`    POMINIĘTE (${r.typ}/${r.status}): wycena ${r.wycena_id} owner ${r.stary}, lead ma ${r.nowy}`));

    console.log(DRY ? 'DRY-RUN — nic nie zapisano.' : 'GOTOWE.');
  } finally {
    await client.end();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
