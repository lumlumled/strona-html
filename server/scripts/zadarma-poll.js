// Etap walidacji z planu migracji Zadarmy: NIE dotyka webhooka Zadarmy
// (ten zostaje wpięty w Make, Sheets nadal się aktualizuje jak dziś).
// Zamiast tego odpytuje REST API Zadarmy (/v1/statistics/) i niezależnie
// zasila Supabase, żeby oba źródła dało się porównać przed cutoverem.
// Uruchamiać ręcznie: `node scripts/zadarma-poll.js [minuty_wstecz]`
require('dotenv').config();
const { callZadarma } = require('../zadarma');
const { getClient } = require('../supabase');

const LEADY_TABLE = 'Leady B2C';
const WYCENY_TABLE = 'Wyceny B2C';
const LOG_TABLE = 'Log zmian';

function fmtZadarmaDate(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function normPhone(v) {
  return String(v || '').replace(/\D/g, '');
}

async function findLead(supabase, phoneDigits) {
  if (!phoneDigits) return null;
  const { data, error } = await supabase
    .from(LEADY_TABLE)
    .select('*')
    .eq('Phone number', Number(phoneDigits))
    .limit(1);
  if (error) throw error;
  return data[0] || null;
}

// Tylko do oznaczenia w Log zmian, że telefon należy do wyceny a nie do
// leada — Wyceny B2C nie ma kolumn do zapisu zwrotnego (patrz server.js).
async function findWycena(supabase, phoneDigits) {
  if (!phoneDigits) return null;
  const { data, error } = await supabase
    .from(WYCENY_TABLE)
    .select('*')
    .eq('Telefon', Number(phoneDigits))
    .limit(1);
  if (error) throw error;
  return data[0] || null;
}

async function run() {
  const minutesBack = Number(process.argv[2]) || 60 * 24; // domyślnie ostatnia doba
  const end = new Date();
  const start = new Date(end.getTime() - minutesBack * 60 * 1000);

  const supabase = getClient();
  const resp = await callZadarma('/v1/statistics/', {
    start: fmtZadarmaDate(start),
    end: fmtZadarmaDate(end),
  });
  const calls = resp.stats || [];
  console.log(`Zadarma zwróciła ${calls.length} połączeń w oknie ${fmtZadarmaDate(start)} — ${fmtZadarmaDate(end)}`);

  let logged = 0;
  let matched = 0;
  let matchedWycena = 0;
  let skipped = 0;

  for (const call of calls) {
    const { data: existing } = await supabase
      .from(LOG_TABLE)
      .select('id')
      .eq('pbx_call_id', call.id)
      .limit(1);
    if (existing && existing.length) {
      skipped += 1;
      continue;
    }

    const fromDigits = normPhone(call.from);
    const toDigits = normPhone(call.to);
    let lead = await findLead(supabase, fromDigits);
    let leadPhone = fromDigits;
    if (!lead) {
      lead = await findLead(supabase, toDigits);
      leadPhone = toDigits;
    }
    const wycena = lead ? null : (await findWycena(supabase, fromDigits)) || (await findWycena(supabase, toDigits));

    const statusBefore = lead ? lead['Deal stage'] : wycena ? wycena['Status'] : null;

    const { error: insertErr } = await supabase.from(LOG_TABLE).insert({
      zrodlo: 'zadarma_poll',
      telefon: lead ? leadPhone : (fromDigits || toDigits),
      status_przed: statusBefore,
      status_po: statusBefore,
      opis: `${call.disposition || '?'}, ${call.billseconds || 0}s (from ${call.from} to ${call.to})`,
      czas_trwania_s: call.billseconds || 0,
      disposition: call.disposition || null,
      pbx_call_id: call.id,
      dopasowano_tabela: lead ? LEADY_TABLE : wycena ? WYCENY_TABLE : null,
      dopasowano_id: lead ? String(lead['ID'] ?? '') : wycena ? wycena['ID'] : null,
    });
    if (insertErr) {
      console.error('Błąd zapisu Log zmian dla', call.id, insertErr.message);
      continue;
    }
    logged += 1;

    if (lead) {
      matched += 1;
      const { error: updateErr } = await supabase
        .from(LEADY_TABLE)
        .update({
          'Ilość telefonów': (Number(lead['Ilość telefonów']) || 0) + 1,
          'Ostatni kontakt': call.callstart,
        })
        .eq('Phone number', lead['Phone number']);
      if (updateErr) console.error('Błąd update Leady B2C dla', leadPhone, updateErr.message);
    } else if (wycena) {
      matchedWycena += 1;
    }
  }

  console.log(`Zalogowano: ${logged}, dopasowano do leada: ${matched}, dopasowano do wyceny: ${matchedWycena}, pominięto (już były): ${skipped}`);
}

run().catch((err) => {
  console.error('BŁĄD:', err.message);
  process.exit(1);
});
