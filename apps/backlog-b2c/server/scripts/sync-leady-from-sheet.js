// Jednorazowa synchronizacja "Leady B2C" z eksportem arkusza Google
// ("CRM Lorenzzo LumLum - Leady B2C"). Arkusz bywa świeższy niż Supabase
// (Make dopisuje tam nowe leady i wpisy rozmów), więc CSV traktujemy jako
// źródło prawdy — ale wpisy rozmów NIE lądują w "Notes" (stary format
// zlepka), tylko wg nowego schematu:
//   - datowane wpisy z Notes ("DD.MM.YYYY[ HH:mm] - treść | ...") →
//     scalane do "Historia rozmów" (jeden wpis na linię, najnowsze na górze,
//     dedupe po treści — te same wpisy mogły już wpisać webhook/migracja),
//   - reszta Notes (ręczna notatka handlowca) → "Notes",
//   - "Link do formularza" czyszczony z artefaktów Make ('#', "''"),
//   - pozostałe pola: wartość z CSV wygrywa, gdy niepusta i inna niż w DB
//     (pustym CSV niczego nie kasujemy),
//   - "Facebook Leads ID" pomijamy gdy arkusz zepsuł go notacją naukową
//     ("1,4783E+15"),
//   - leady z CSV nieobecne w DB (po ID/telefonie) są wstawiane z kolejnym
//     "ID Leada".
//
// Mapowanie: kolumna CSV "ID Wyceny" (ostatnia) to w praktyce numer leada →
// DB "ID Leada"; wiersze bez niego (najnowsze) dopasowujemy po telefonie,
// duplikaty tego samego telefonu scalamy (najbogatszy wiersz wygrywa
// per-pole, historie z wszystkich wierszy sumujemy).
//
// Uruchomienie:  node scripts/sync-leady-from-sheet.js <plik.csv>          (dry-run)
//                node scripts/sync-leady-from-sheet.js <plik.csv> --apply
// Zapis w jednej transakcji z flagą app.bypass_log_zmian (jak w
// migrate-notes-to-historia.js) — bez fałszywych wpisów w Log zmian.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ENTRY_RE = /^\d{1,2}\.\d{1,2}\.\d{4}(?: +\d{1,2}:\d{2})? *[-–—]/;

// Bezpośredni host db.*.supabase.co jest IPv6-only — łączymy się przez pooler.
function pooledUrl() {
  const url = new URL(process.env.DATABASE_URL);
  const ref = url.hostname.match(/^db\.([^.]+)\.supabase\.co$/)?.[1];
  if (!ref) return process.env.DATABASE_URL;
  return `postgresql://postgres.${ref}:${url.password}@aws-0-eu-west-3.pooler.supabase.com:5432/postgres`;
}

// ── CSV (RFC 4180: pola w cudzysłowach, przecinki i \n w środku) ────────────
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function splitNotes(notes) {
  const segments = String(notes || '')
    .split(' | ')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    historia: segments.filter((s) => ENTRY_RE.test(s)),
    reszta: segments.filter((s) => !ENTRY_RE.test(s)),
  };
}

function entryDate(entry) {
  const m = String(entry).match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?: +(\d{1,2}):(\d{2}))?/);
  if (!m) return 0;
  return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0)).getTime();
}

// Klucz dedupe: dzień + treść (bez HH:mm — webhook zapisuje z godziną,
// arkusz bez; ta sama rozmowa nie może wylądować dwa razy).
function entryKey(entry) {
  const m = String(entry).match(/^(\d{1,2}\.\d{1,2}\.\d{4})(?: +\d{1,2}:\d{2})? *[-–—] *(.*)$/s);
  if (!m) return String(entry).replace(/\s+/g, ' ').trim();
  return `${m[1]}|${m[2].replace(/\s+/g, ' ').trim()}`;
}

// CSV (najnowsze na górze) jako baza; wpisy z DB, których nie ma w CSV,
// wstawiane wg daty tak, by całość została najnowsze-na-górze.
function mergeHistoria(csvEntries, dbHistoria) {
  const merged = [...csvEntries];
  const seen = new Set(merged.map(entryKey));
  const dbLines = String(dbHistoria || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const line of dbLines) {
    const key = entryKey(line);
    if (seen.has(key)) continue;
    seen.add(key);
    const d = entryDate(line);
    const idx = merged.findIndex((e) => entryDate(e) < d);
    if (idx === -1) merged.push(line);
    else merged.splice(idx, 0, line);
  }
  return merged;
}

function cleanLink(link) {
  const v = String(link || '').replace(/[#']/g, '').trim();
  return v || null;
}

const norm = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s === '' ? null : s;
};

// Pola przepisywane 1:1 (CSV wygrywa, gdy niepuste i inne).
const SCALAR_FIELDS = [
  'Name', 'Deal stage', 'Email', 'Temperatura', 'Ilość telefonów',
  'Produkty z wyceny', 'Ocena AI kontaktu', 'ID', 'ad_name', 'Treść rozmowy',
];

// Pola datowe: DB trzyma "2026-05-14 00:00:00", arkusz "14.5.2026" — to ta
// sama data, więc porównujemy po sparsowanym dniu (jak parseLeadDate w
// server.js), nie po tekście. Aktualizacja tylko gdy dzień faktycznie inny
// lub DB puste; zapisujemy wartość z CSV (parseLeadDate czyta oba formaty).
const DATE_FIELDS = ['Date', 'Data Feedbacku', 'Data wysłania wyceny', 'Ostatni kontakt'];

function parseDay(value) {
  if (!value) return null;
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(String(value).trim());
  if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  const asDate = new Date(value);
  if (Number.isNaN(asDate.getTime())) return null;
  // Lokalne komponenty, nie toISOString() — UTC cofnęłoby północ o dzień.
  return `${asDate.getFullYear()}-${String(asDate.getMonth() + 1).padStart(2, '0')}-${String(asDate.getDate()).padStart(2, '0')}`;
}

function csvRowToLead(header, row) {
  const o = {};
  header.forEach((h, i) => { o[h] = row[i] ?? ''; });
  return o;
}

// Ilość niepustych pól — do wyboru "najbogatszego" wiersza wśród duplikatów.
const richness = (lead) => Object.values(lead).filter((v) => norm(v)).length;

async function main() {
  const csvPath = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!csvPath) {
    console.error('Użycie: node scripts/sync-leady-from-sheet.js <plik.csv> [--apply]');
    process.exit(1);
  }

  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const header = rows[0];
  const leads = rows.slice(1).map((r) => csvRowToLead(header, r));

  // "ID Wyceny" w arkuszu to numer leada (etykieta została po starym Make).
  const byId = new Map();
  const idless = new Map(); // phone → [wiersze]
  for (const lead of leads) {
    const id = Number(norm(lead['ID Wyceny']));
    if (Number.isFinite(id) && norm(lead['ID Wyceny'])) {
      byId.set(id, lead); // przy duplikacie ID ostatni wygrywa (nie występuje)
    } else {
      const phone = String(lead['Phone number']).replace(/\D/g, '');
      if (!phone) continue;
      if (!idless.has(phone)) idless.set(phone, []);
      idless.get(phone).push(lead);
    }
  }

  // Duplikaty bez ID (ten sam telefon) → jeden lead: pola z najbogatszego,
  // braki uzupełniane z pozostałych, historie z wszystkich zsumowane.
  const idlessMerged = new Map();
  for (const [phone, group] of idless) {
    group.sort((a, b) => richness(b) - richness(a));
    const base = { ...group[0] };
    for (const other of group.slice(1)) {
      for (const key of header) if (!norm(base[key]) && norm(other[key])) base[key] = other[key];
    }
    const historie = group.flatMap((l) => splitNotes(l['Notes']).historia);
    const seen = new Set();
    base._historiaAll = historie.filter((h) => {
      const k = entryKey(h);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    idlessMerged.set(phone, base);
  }

  const client = new Client({ connectionString: pooledUrl() });
  await client.connect();
  const { rows: dbRows } = await client.query('select * from "Leady B2C"');
  const dbById = new Map(dbRows.map((r) => [Number(r['ID Leada']), r]));
  const dbByPhone = new Map(dbRows.map((r) => [String(r['Phone number']).replace(/\D/g, ''), r]));
  let maxId = Math.max(...dbRows.map((r) => Number(r['ID Leada'])).filter(Number.isFinite));

  const updates = []; // { id, patch, name }
  const inserts = []; // { record }

  function diffLead(dbRow, csvLead, historiaOverride) {
    const patch = {};
    const { historia, reszta } = splitNotes(csvLead['Notes']);
    const csvHistoria = historiaOverride || historia;

    // Historia rozmów — scalona, tylko gdy realnie coś dochodzi/zmienia się.
    const merged = mergeHistoria(csvHistoria, dbRow['Historia rozmów']).join('\n');
    if (merged && merged !== String(dbRow['Historia rozmów'] || '').trim()) {
      patch['Historia rozmów'] = merged;
    }

    // Notes = wyłącznie ręczna notatka. Pustym CSV nie kasujemy.
    const notes = reszta.length ? reszta.join(' | ') : null;
    if (notes && notes !== norm(dbRow['Notes'])) patch['Notes'] = notes;

    const link = cleanLink(csvLead['Link do formularza']);
    if (link && link !== norm(dbRow['Link do formularza'])) patch['Link do formularza'] = link;

    const kwota = Number(String(csvLead['Kwota wyceny']).replace(/\s/g, ''));
    if (norm(csvLead['Kwota wyceny']) && Number.isFinite(kwota) && kwota !== Number(dbRow['Kwota wyceny'])) {
      patch['Kwota wyceny'] = kwota;
    }

    const fb = norm(csvLead['Facebook Leads ID']);
    if (fb && !/[,eE]/.test(fb) && fb !== norm(dbRow['Facebook Leads ID'])) {
      patch['Facebook Leads ID'] = fb;
    }

    for (const f of SCALAR_FIELDS) {
      const v = norm(csvLead[f]);
      if (v && v !== norm(dbRow[f])) patch[f] = v;
    }

    for (const f of DATE_FIELDS) {
      const v = norm(csvLead[f]);
      if (!v) continue;
      const csvDay = parseDay(v);
      const dbDay = parseDay(norm(dbRow[f]));
      if (!dbDay && csvDay) patch[f] = v;
      else if (csvDay && dbDay && csvDay !== dbDay) patch[f] = v;
    }
    return patch;
  }

  // 1) Wiersze z ID.
  for (const [id, csvLead] of byId) {
    const dbRow = dbById.get(id);
    if (!dbRow) {
      inserts.push({ id, csvLead });
      continue;
    }
    const patch = diffLead(dbRow, csvLead);
    if (Object.keys(patch).length) updates.push({ id: Number(dbRow['ID Leada']), name: dbRow['Name'], patch });
  }

  // 2) Wiersze bez ID — po telefonie.
  for (const [phone, csvLead] of idlessMerged) {
    const dbRow = dbByPhone.get(phone);
    if (!dbRow) {
      inserts.push({ id: null, csvLead });
      continue;
    }
    const patch = diffLead(dbRow, csvLead, csvLead._historiaAll);
    if (Object.keys(patch).length) updates.push({ id: Number(dbRow['ID Leada']), name: dbRow['Name'], patch });
  }

  console.log(`CSV: ${leads.length} wierszy (${byId.size} z ID, ${idlessMerged.size} unikalnych bez ID). DB: ${dbRows.length} leadów.`);
  console.log(`Do aktualizacji: ${updates.length} leadów, do wstawienia: ${inserts.length}.`);
  const detailArg = process.argv.find((a) => a.startsWith('--detail='));
  const detailId = detailArg ? Number(detailArg.split('=')[1]) : null;
  for (const u of updates) {
    const fields = Object.keys(u.patch).join(', ');
    console.log(`  ~ [${u.id}] ${u.name}: ${fields}`);
    if (detailId === u.id) console.log(JSON.stringify(u.patch, null, 2));
  }
  for (const ins of inserts) {
    console.log(`  + [${ins.id ?? 'nowe ID'}] ${ins.csvLead['Name']} (${ins.csvLead['Phone number']})`);
  }

  if (!apply) {
    console.log('\nDry-run — nic nie zapisano. Uruchom z --apply, żeby zastosować.');
    await client.end();
    return;
  }

  await client.query('begin');
  try {
    await client.query(`select set_config('app.bypass_log_zmian', 'on', true)`);
    for (const u of updates) {
      const cols = Object.keys(u.patch);
      const sets = cols.map((c, i) => `"${c}" = $${i + 1}`).join(', ');
      await client.query(
        `update "Leady B2C" set ${sets} where "ID Leada" = $${cols.length + 1}`,
        [...cols.map((c) => u.patch[c]), u.id]
      );
    }
    for (const ins of inserts) {
      const l = ins.csvLead;
      const { historia, reszta } = splitNotes(l['Notes']);
      maxId += 1;
      const record = {
        'ID Leada': ins.id ?? maxId,
        'Date': norm(l['Date']),
        'Name': norm(l['Name']),
        'Phone number': Number(String(l['Phone number']).replace(/\D/g, '')) || null,
        'Deal stage': norm(l['Deal stage']),
        'Email': norm(l['Email']),
        'Notes': reszta.length ? reszta.join(' | ') : null,
        'Data Feedbacku': norm(l['Data Feedbacku']),
        'Temperatura': norm(l['Temperatura']),
        'Ostatni kontakt': norm(l['Ostatni kontakt']),
        'Ilość telefonów': norm(l['Ilość telefonów']),
        'Produkty z wyceny': norm(l['Produkty z wyceny']),
        'Ocena AI kontaktu': norm(l['Ocena AI kontaktu']),
        'Link do formularza': cleanLink(l['Link do formularza']),
        'Kwota wyceny': norm(l['Kwota wyceny']) ? Number(String(l['Kwota wyceny']).replace(/\s/g, '')) : null,
        'Data wysłania wyceny': norm(l['Data wysłania wyceny']),
        'ID': norm(l['ID']),
        'Facebook Leads ID': (() => { const v = norm(l['Facebook Leads ID']); return v && !/[,eE]/.test(v) ? v : null; })(),
        'ad_name': norm(l['ad_name']),
        'Treść rozmowy': norm(l['Treść rozmowy']),
        'Historia rozmów': (ins.csvLead._historiaAll || historia).join('\n') || null,
      };
      const cols = Object.keys(record);
      await client.query(
        `insert into "Leady B2C" (${cols.map((c) => `"${c}"`).join(', ')})
         values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
        cols.map((c) => record[c])
      );
    }
    await client.query('commit');
    console.log(`\nZapisano: ${updates.length} aktualizacji, ${inserts.length} insertów.`);
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
