// Backfill do reguły "lead stracony → jego wycena też stracona" (decyzja
// Antoniego 2026-07-23, na przykładzie leada 467 Kamil Marciniec: temat
// zamknięty jako Stracony po rozmowie "za drogo", a wycena na 6027,50 zł dalej
// wisiała w Backlogu jako 'Open'). Od tej pory automat robi to sam w chwili
// zmiany statusu (apps/shared/server/wyceny-sync.js) — ten skrypt sprząta
// przypadki SPRZED wdrożenia reguły.
//
// Domyka WYŁĄCZNIE wyceny (typ='WYCENA') ze statusem 'Open', których lead ma
// dziś "Deal stage" = 'Stracony'. Zamówienia i płatności w toku ('Waiting for
// payment') zostają nietknięte — patrz komentarz w wyceny-sync.js. Dopasowanie
// lead↔wycena po lead_id ORAZ po telefonie (większość wycen nie ma lead_id).
//
// Bezpieczeństwo: DOMYŚLNIE dry-run. Zapis dopiero z flagą --apply.
const path = require('path');
const BACKLOG_SERVER = path.join(__dirname, '..', 'apps', 'backlog-b2c', 'server');
require(path.join(__dirname, '..', 'node_modules', 'dotenv')).config({ path: path.join(BACKLOG_SERVER, '.env') });
const { createClient } = require(path.join(__dirname, '..', 'node_modules', '@supabase/supabase-js'));
const { zamknijWycenyStraconego } = require(path.join(__dirname, '..', 'apps', 'shared', 'server', 'wyceny-sync'));

const APPLY = process.argv.includes('--apply');
const nine = (v) => String(v || '').replace(/\D/g, '').replace(/^48/, '');

async function main() {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const [{ data: wyceny, error: wErr }, { data: leady, error: lErr }] = await Promise.all([
    db.from('wyceny').select('id,status,typ,telefon_digits,lead_id,imie_nazwisko,kwota_proponowana_brutto')
      .eq('typ', 'WYCENA').eq('status', 'Open'),
    db.from('Leady B2C').select('"ID Leada","Phone number","Name","Deal stage"'),
  ]);
  if (wErr) throw wErr;
  if (lErr) throw lErr;

  const leadById = new Map();
  const leadByPhone = new Map();
  leady.forEach((l) => {
    if (l['ID Leada'] != null) leadById.set(Number(l['ID Leada']), l);
    if (l['Phone number']) leadByPhone.set(nine(l['Phone number']), l);
  });

  // Grupujemy po leadzie: helper i tak domyka wszystkie wyceny danego klienta
  // naraz, więc wołanie go raz na lead trzyma backfill i automat w tej samej
  // ścieżce kodu (żadnej drugiej definicji "co znaczy stracona wycena").
  const perLead = new Map();
  wyceny.forEach((w) => {
    const lead = (w.lead_id != null && leadById.get(Number(w.lead_id))) || leadByPhone.get(nine(w.telefon_digits));
    if (!lead || lead['Deal stage'] !== 'Stracony') return;
    const key = lead['ID Leada'] != null ? `id:${lead['ID Leada']}` : `tel:${nine(w.telefon_digits)}`;
    if (!perLead.has(key)) perLead.set(key, { lead, wyceny: [] });
    perLead.get(key).wyceny.push(w);
  });

  if (!perLead.size) {
    console.log('Brak otwartych wycen pod straconymi leadami — nie ma czego domykać.');
    return;
  }

  let suma = 0;
  console.log(`Otwarte wyceny pod leadem "Stracony": ${[...perLead.values()].reduce((n, g) => n + g.wyceny.length, 0)}\n`);
  for (const { lead, wyceny: ws } of perLead.values()) {
    for (const w of ws) {
      suma += Number(w.kwota_proponowana_brutto) || 0;
      console.log(`  wycena ${w.id} | ${String(w.kwota_proponowana_brutto || 0).padStart(8)} zł | ${w.imie_nazwisko || lead['Name'] || '?'} | lead ${lead['ID Leada'] ?? '-'}`);
    }
  }
  console.log(`\nŁącznie: ${suma.toFixed(2)} zł`);

  if (!APPLY) {
    console.log('\nDRY-RUN — uruchom z --apply, żeby zapisać.');
    return;
  }

  let zamkniete = 0;
  for (const { lead, wyceny: ws } of perLead.values()) {
    const { ids, error } = await zamknijWycenyStraconego(db, {
      leadId: lead['ID Leada'],
      telefon: lead['Phone number'] || ws[0].telefon_digits,
    });
    if (error) console.error(`  BŁĄD dla leada ${lead['ID Leada']}: ${error}`);
    zamkniete += ids.length;
  }
  console.log(`\nZAPISANE — domknięto ${zamkniete} wycen.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
