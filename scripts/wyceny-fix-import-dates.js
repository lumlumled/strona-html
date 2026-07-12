// Naprawa dat historycznych importów. Część zamówień z arkusza miała pustą
// "Datę stworzenia", więc przy imporcie created_at wpadł na DB default now()
// (dzień importu 2026-07-11/12) — zawyżało to statystyki "ten miesiąc" w
// panelu Sprzedaże. Prawdziwa data siedzi na początku history_log
// ("DD.MM.RRRR | RAW | …"); fallback: paid_at.
//
// Bezpiecznie: DOMYŚLNIE dry-run. Zapis dopiero z --apply. Rusza WYŁĄCZNIE
// rekordy source='import' z created_at w dniu importu (te ewidentnie błędne).
//   node scripts/wyceny-fix-import-dates.js            # podgląd
//   node scripts/wyceny-fix-import-dates.js --apply     # zapis do prod
const path = require('path');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'node_modules', 'dotenv')).config({ path: path.join(ROOT, 'apps', 'formularz', 'server', '.env') });
const { createClient } = require(path.join(ROOT, 'node_modules', '@supabase/supabase-js'));

const APPLY = process.argv.includes('--apply');
const IMPORT_DAYS = new Set(['2026-07-11', '2026-07-12']); // dni, w które leciał import
const warsawDay = (d) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));

// "26.01.2026 | RAW | …" -> Date (południe, żeby nie przeskoczyć doby przy TZ).
function dateFromHistory(hist) {
  const m = String(hist || '').match(/^\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return null;
  const [, d, mo, y] = m.map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d, 10, 0, 0));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

async function main() {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data, error } = await db.from('wyceny')
    .select('id, typ, created_at, paid_at, history_log')
    .eq('source', 'import');
  if (error) throw error;

  const kandydaci = (data || []).filter((r) => r.created_at && IMPORT_DAYS.has(warsawDay(r.created_at)));
  const plan = [];
  let brakDaty = 0;
  for (const r of kandydaci) {
    const nowa = dateFromHistory(r.history_log) || (r.paid_at ? new Date(r.paid_at) : null);
    if (!nowa) { brakDaty += 1; continue; }
    if (warsawDay(nowa) === warsawDay(r.created_at)) continue; // już dobrze
    plan.push({ id: r.id, typ: r.typ, z: warsawDay(r.created_at), na: warsawDay(nowa), iso: nowa.toISOString(), src: dateFromHistory(r.history_log) ? 'history' : 'paid_at' });
  }

  console.log(`Rekordy import w dniu importu: ${kandydaci.length}`);
  console.log(`Do poprawienia daty: ${plan.length} (bez odzyskiwalnej daty: ${brakDaty})`);
  const byMonth = {};
  plan.forEach((p) => { const m = p.na.slice(0, 7); byMonth[m] = (byMonth[m] || 0) + 1; });
  console.log('Nowe daty po miesiącu:', byMonth);
  plan.slice(0, 12).forEach((p) => console.log(`  #${p.id} ${p.typ} ${p.z} -> ${p.na} (${p.src})`));

  if (!APPLY) { console.log('\n[dry-run] Nic nie zapisano. Uruchom z --apply.'); return; }

  let done = 0;
  for (const p of plan) {
    const { error: uErr } = await db.from('wyceny')
      .update({ created_at: p.iso, updated_at: new Date().toISOString() })
      .eq('id', p.id);
    if (uErr) throw uErr;
    done += 1;
  }
  console.log(`\n[apply] Poprawiono created_at w ${done} rekordach.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
