// Test: adresaci push „Nowa wiadomość" — admin dostaje, nie-admin spoza
// KOM_NOTIFY nie; env KOM_NOTIFY dokłada po nazwie. To dokładnie ta logika,
// której cichy błąd (zły user_id → zero urządzeń) powodował „nie działają".
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Stub współdzielonego modułu push PRZED załadowaniem notify-push (require leniwy).
const pushPath = require.resolve(path.join(__dirname, '..', '..', 'shared', 'server', 'push.js'));
const calls = [];
require.cache[pushPath] = {
  id: pushPath, filename: pushPath, loaded: true,
  exports: { notifyUser: async (_gc, userId, payload) => { calls.push({ userId, payload }); } },
};
const { notifyNewMessage } = require('./notify-push');

// Minimalny chainable mock supabase: .from().select().eq()/.limit() → {data}.
function mockDb({ users, customer }) {
  return {
    from(tabela) {
      const res = tabela === 'app_users' ? { data: users } : { data: customer ? [customer] : [] };
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        limit() { return Promise.resolve(res); },
        then(resolve) { return Promise.resolve(res).then(resolve); }, // await na .eq('active',true)
      };
      return chain;
    },
  };
}

const THREAD = { id: 'uuid-1', channel: 'messenger', customer_id: 'c1' };
const CUSTOMER = { public_id: 'LL-00042', display_name: 'Jan Kowalski' };

test('admin dostaje push, nie-admin spoza KOM_NOTIFY nie', async () => {
  calls.length = 0;
  delete process.env.KOM_NOTIFY;
  const db = mockDb({
    users: [{ id: 1, name: 'Antoni', role: 'admin' }, { id: 6, name: 'Lorenzo', role: 'user' }],
    customer: CUSTOMER,
  });
  await notifyNewMessage(db, { thread: THREAD, body: 'Dzień dobry, ile za taśmę?' });
  assert.deepEqual(calls.map((c) => c.userId), [1]);
  assert.match(calls[0].payload.url, /klient=LL-00042/);
  assert.match(calls[0].payload.title, /Messenger/);
  assert.match(calls[0].payload.body, /Jan Kowalski/);
});

test('KOM_NOTIFY dokłada nie-admina po nazwie', async () => {
  calls.length = 0;
  process.env.KOM_NOTIFY = 'lorenzo';
  const db = mockDb({
    users: [{ id: 1, name: 'Antoni', role: 'admin' }, { id: 6, name: 'Lorenzo', role: 'user' }],
    customer: CUSTOMER,
  });
  await notifyNewMessage(db, { thread: THREAD, body: 'test' });
  assert.deepEqual(calls.map((c) => c.userId).sort(), [1, 6]);
  delete process.env.KOM_NOTIFY;
});

test('brak adresatów = zero wysyłek, bez wyjątku', async () => {
  calls.length = 0;
  delete process.env.KOM_NOTIFY;
  const db = mockDb({ users: [{ id: 6, name: 'Lorenzo', role: 'user' }], customer: CUSTOMER });
  await notifyNewMessage(db, { thread: THREAD, body: 'x' });
  assert.equal(calls.length, 0);
});
