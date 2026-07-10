// Jednorazowa migracja: przenosi wpisy rozmów doklejone historycznie do
// "Notes" (format arkuszowo-Make'owy: "DD.MM.YYYY[ HH:mm] - treść | ...",
// najnowsze na początku) do nowej kolumny "Historia rozmów" (jeden wpis na
// linię, ta sama kolejność najnowsze-na-górze). W "Notes" zostaje wyłącznie
// tekst NIE będący datowanym wpisem rozmowy (np. "Komentarz od nas - ...")
// — opis wraca do roli ręcznej notatki handlowca.
//
// Idempotentny: drugi przebieg nie znajdzie już datowanych wpisów w Notes i
// niczego nie zmieni. Jeśli lead ma już coś w "Historia rozmów" (webhook
// zdążył dopisać nowe rozmowy), wpisy z Notes są doklejane NA KOŃCU — są
// z definicji starsze niż cokolwiek, co webhook wpisał po tej migracji.
//
// Bezpieczeństwo: pełny backup (ID Leada, Notes, Historia rozmów) do pliku
// JSON PRZED jakimkolwiek zapisem + cała migracja w jednej transakcji z
// flagą app.bypass_log_zmian (inaczej trigger trg_log_zmian_from_leady
// dopisałby ~setki fałszywych wierszy "manual_crm" do Log zmian i zaśmiecił
// jutrzejsze Podsumowanie dnia).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// "03.07.2026 - ..." / "08.07.2026 19:02 - ..." — datowany wpis rozmowy.
const ENTRY_RE = /^\d{1,2}\.\d{1,2}\.\d{4}(?: +\d{1,2}:\d{2})? *[-–—]/;

function splitNotes(notes) {
  const segments = String(notes)
    .split(' | ')
    .map((s) => s.trim())
    .filter(Boolean);
  const historia = segments.filter((s) => ENTRY_RE.test(s));
  const reszta = segments.filter((s) => !ENTRY_RE.test(s));
  return { historia, reszta };
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const { rows } = await client.query(
    `select "ID Leada", "Notes", "Historia rozmów" from "Leady B2C" where "Notes" is not null`
  );

  const backupPath = path.join(__dirname, `backup-notes-${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(rows, null, 2));
  console.log(`Backup ${rows.length} wierszy: ${backupPath}`);

  let migrated = 0;
  await client.query('begin');
  try {
    await client.query(`select set_config('app.bypass_log_zmian', 'on', true)`);
    for (const row of rows) {
      const { historia, reszta } = splitNotes(row['Notes']);
      if (!historia.length) continue;
      const existing = row['Historia rozmów'] ? String(row['Historia rozmów']).trim() : '';
      const merged = existing ? `${existing}\n${historia.join('\n')}` : historia.join('\n');
      await client.query(
        `update "Leady B2C" set "Historia rozmów" = $1, "Notes" = $2 where "ID Leada" = $3`,
        [merged, reszta.length ? reszta.join(' | ') : null, row['ID Leada']]
      );
      migrated += 1;
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  }

  console.log(`Zmigrowano ${migrated} leadów (wpisy rozmów: Notes → Historia rozmów).`);
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
