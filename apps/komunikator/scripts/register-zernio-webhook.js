// Rejestracja webhooka Zernio przez API (idempotentna): tworzy albo
// aktualizuje webhook 'lumlum-komunikator' wskazujący na endpoint panelu.
// Sekret = ZERNIO_WEBHOOK_SECRET (ten sam, którym serwer weryfikuje
// X-Zernio-Signature). Odpalenie: node scripts/register-zernio-webhook.js [url]
// Domyślny url = produkcja; do testów lokalnych podaj np. tunel ngrok.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'server', '.env') });

const NAME = 'lumlum-komunikator';
const EVENTS = ['message.received', 'message.sent', 'conversation.started', 'comment.received'];
const DEFAULT_URL = 'https://lumlum.dev/wiadomosci/api/webhooks/zernio';

async function zernio(method, pathname, body) {
  const res = await fetch(`https://zernio.com/api${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.ZERNIO_API_KEY}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Zernio ${method} ${pathname} → ${res.status}: ${raw.slice(0, 400)}`);
  return raw ? JSON.parse(raw) : {};
}

async function main() {
  if (!process.env.ZERNIO_API_KEY) throw new Error('Brak ZERNIO_API_KEY w server/.env');
  if (!process.env.ZERNIO_WEBHOOK_SECRET) throw new Error('Brak ZERNIO_WEBHOOK_SECRET w server/.env');
  const url = process.argv[2] || DEFAULT_URL;

  const { webhooks = [] } = await zernio('GET', '/v1/webhooks/settings');
  const existing = webhooks.find((w) => w.name === NAME);
  const config = { name: NAME, url, secret: process.env.ZERNIO_WEBHOOK_SECRET, events: EVENTS, isActive: true };

  const result = existing
    ? await zernio('PUT', '/v1/webhooks/settings', { _id: existing._id, ...config })
    : await zernio('POST', '/v1/webhooks/settings', config);

  console.log(`${existing ? 'Zaktualizowano' : 'Utworzono'} webhook '${NAME}':`);
  console.log(`  url:    ${url}`);
  console.log(`  eventy: ${EVENTS.join(', ')}`);
  console.log(`  id:     ${result.webhook?._id || existing?._id}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
