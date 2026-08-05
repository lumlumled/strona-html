// Test regresyjny buga z panelu Feedbacki (2026-08-05): "Phone number" w
// Leady B2C to bigint przeważnie Z prefiksem 48, a panel podawał 9 cyfr —
// .eq() nie trafiał w NIC i szuflada mówiła "Nie znaleziono leada o tym
// numerze" dla leadów, które istnieją. Lookup musi trafiać z obu stron.
//   node --test  (z katalogu apps/shared/server)
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { findLeadByPhone, phoneVariants } = require('./leady-endpoints');

function fakeSupabase(rows) {
  const calls = { variants: null };
  return {
    calls,
    from() {
      return {
        select() { return this; },
        in(col, vals) { calls.variants = vals; return this; },
        limit() {
          const hit = rows.filter((r) => calls.variants.includes(Number(String(r['Phone number']))));
          return Promise.resolve({ data: hit, error: null });
        },
      };
    },
  };
}

const LEAD_Z_48 = { 'ID Leada': 400, 'Phone number': 48501043583 };
const LEAD_BEZ_48 = { 'ID Leada': 401, 'Phone number': 512345678 };

test('9 cyfr z Feedbacków znajduje leada zapisanego z prefiksem 48', async () => {
  const sb = fakeSupabase([LEAD_Z_48]);
  assert.equal(await findLeadByPhone(sb, '501043583'), LEAD_Z_48);
  assert.deepEqual(sb.calls.variants, [501043583, 48501043583]);
});

test('48+9 cyfr z CRM dalej znajduje (stara ścieżka bez regresji)', async () => {
  const sb = fakeSupabase([LEAD_Z_48]);
  assert.equal(await findLeadByPhone(sb, '48501043583'), LEAD_Z_48);
});

test('lead zapisany BEZ prefiksu też znajdowany z obu stron', async () => {
  assert.equal(await findLeadByPhone(fakeSupabase([LEAD_BEZ_48]), '512345678'), LEAD_BEZ_48);
  assert.equal(await findLeadByPhone(fakeSupabase([LEAD_BEZ_48]), '48512345678'), LEAD_BEZ_48);
});

test('pusty/śmieciowy numer nie strzela do bazy', async () => {
  const sb = fakeSupabase([LEAD_Z_48]);
  assert.equal(await findLeadByPhone(sb, ''), null);
  assert.equal(await findLeadByPhone(sb, null), null);
  assert.equal(sb.calls.variants, null);
});

test('phoneVariants: warianty bez dubli, w obu kierunkach', () => {
  assert.deepEqual(phoneVariants('501043583'), ['501043583', '48501043583']);
  assert.deepEqual(phoneVariants('48501043583'), ['48501043583', '501043583']);
});
