// Jednorazowa naprawa: Umowy wygenerowane/edytowane PRZED poprawką w
// mapLeadRow (id_wyceny/id_lida/ma_wycene liczone na podstawie obecności
// linku do wyceny) mają w zapisanym JSON-ie stare, błędne wartości tych pól
// (np. id_wyceny pokazujące wewnętrzny numer leada zamiast być puste, gdy nie
// ma linku). Ten skrypt przelicza je na nowo dla wszystkich case'ów we
// wszystkich zapisanych Umowach (draft/poprawka/final), z aktualnych danych
// Leady B2C / Wyceny B2C — i podmienia tylko to, co faktycznie się zmieniło.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function normalizePhoneDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

async function main() {
  const [{ data: leady }, { data: wyceny }] = await Promise.all([
    supabase.from('Leady B2C').select('"Phone number", "Link do formularza", "ID Leada"'),
    supabase.from('Wyceny B2C').select('Telefon, ID, "Link do formularza"'),
  ]);

  const leadyByPhone = new Map();
  (leady || []).forEach((r) => {
    const digits = normalizePhoneDigits(r['Phone number']);
    if (digits) leadyByPhone.set(digits, r);
  });
  const wycenaByPhone = new Map();
  (wyceny || []).forEach((r) => {
    const digits = normalizePhoneDigits(r['Telefon']);
    if (digits && !wycenaByPhone.has(digits)) wycenaByPhone.set(digits, r);
  });

  // Ten sam wzorzec co w jednorazowym czyszczeniu Leady B2C wcześniej — case'y
  // zapisane w Umowach PRZED tamtym czyszczeniem mają go nadal w JSON-ie
  // (Umowa to zamrożona migawka z dnia wygenerowania, nie odziedziczyła
  // późniejszej poprawki źródła).
  function cleanProdukty(raw) {
    if (!raw) return raw;
    let text = String(raw).replace(/^\s*tel\.\s*\+?\d+\s*/i, '');
    const m = text.match(/\s*Cena za całość:\s*[\s\S]*$/i);
    if (m) text = text.slice(0, m.index);
    return text.trim();
  }

  function recompute(item) {
    const digits = normalizePhoneDigits(item.telefon);
    if (!digits) return false;
    const lead = leadyByPhone.get(digits);
    const wycena = wycenaByPhone.get(digits);
    const linkFormularz = (lead && lead['Link do formularza']) || (wycena && wycena['Link do formularza']) || '';
    const maWycene = Boolean(linkFormularz);
    const newIdWyceny = maWycene ? ((wycena && wycena['ID']) || '') : '';
    const newIdLida = (lead && lead['ID Leada']) || '';
    let changed = false;
    if ((item.id_wyceny || '') !== newIdWyceny) { item.id_wyceny = newIdWyceny; changed = true; }
    if ((item.id_lida || '') !== newIdLida) { item.id_lida = newIdLida; changed = true; }
    if (Boolean(item.ma_wycene) !== maWycene) { item.ma_wycene = maWycene; changed = true; }
    if (item.produkty) {
      const cleaned = cleanProdukty(item.produkty);
      if (cleaned !== item.produkty) { item.produkty = cleaned; changed = true; }
    }
    return changed;
  }

  const { data: rows } = await supabase.from('Standup Log Lorenzo').select('*');
  let totalPatched = 0;

  for (const row of rows || []) {
    const patch = {};
    for (const col of ['Umowa - draft - JSON', 'Umowa - draft poprawka AI - JSON', 'Umowa - final - JSON']) {
      const doc = row[col];
      if (!doc) continue;
      let docChanged = false;
      (doc.priorytet_dzis || []).forEach((item) => { if (item && recompute(item)) docChanged = true; });
      Object.values(doc.kategorie || {}).forEach((arr) => {
        (arr || []).forEach((item) => { if (item && recompute(item)) docChanged = true; });
      });
      if (docChanged) patch[col] = doc;
    }
    if (Object.keys(patch).length) {
      const { error } = await supabase.from('Standup Log Lorenzo').update(patch).eq('Data', row['Data']);
      if (error) console.error(`Błąd zapisu dla ${row['Data']}:`, error.message);
      else {
        console.log(`Naprawiono ${row['Data']}:`, Object.keys(patch).join(', '));
        totalPatched++;
      }
    }
  }

  console.log(`Gotowe. Zaktualizowano wierszy: ${totalPatched}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
