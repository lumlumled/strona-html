// Panel główny lumlum.dev — karta startowa narzędzi wewnętrznych (linki do
// Backlogu B2C i CRM) + logowanie przed całością. Ten sam bezstanowy
// mechanizm sesji co w apps/backlog-b2c i apps/crm (HMAC z SITE_PASSWORD),
// ale ciasteczko z Path=/ — jedno zalogowanie (tu albo w dowolnej appce)
// obowiązuje w całej domenie, bo wszystkie appki podpisują token tym samym
// SITE_PASSWORD i czytają to samo ciasteczko lumlum_session.
const path = require('path');
// Lokalne env niezależnie od CWD, z którego odpalono serwer (na Vercelu
// zmienne przychodzą z projektu i dotenv niczego nie nadpisuje).
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');

const app = express();
app.use(express.urlencoded({ extended: false }));

// Patrz apps/backlog-b2c/server/server.js — bez no-store Vercel CDN
// cache'owałby odpowiedzi po zalogowaniu i serwował je każdemu.
app.use((req, res, next) => {
  if (!req.path.startsWith('/assets/')) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});

const SITE_PASSWORD = process.env.SITE_PASSWORD;
const COOKIE_NAME = 'lumlum_session';
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 dni

function sign(value) {
  return crypto.createHmac('sha256', SITE_PASSWORD || '').update(value).digest('hex');
}

function createSessionToken() {
  const expires = String(Date.now() + SESSION_MAX_AGE_MS);
  return `${expires}.${sign(expires)}`;
}

function isValidSessionToken(token) {
  if (!token || !SITE_PASSWORD) return false;
  const [expires, sig] = token.split('.');
  if (!expires || !sig) return false;
  const expected = sign(expires);
  if (expected.length !== sig.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return false;
  return Number(expires) > Date.now();
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  const match = header.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function isAuthenticated(req) {
  return isValidSessionToken(readCookie(req, COOKIE_NAME));
}

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'), { cacheControl: false });
});

app.post('/login', (req, res) => {
  if (SITE_PASSWORD && req.body.password === SITE_PASSWORD) {
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${createSessionToken()}; HttpOnly; Path=/; Max-Age=${SESSION_MAX_AGE_MS / 1000}; SameSite=Lax`
    );
    return res.redirect('/');
  }
  res.redirect('/login?error=1');
});

app.use((req, res, next) => {
  if (isAuthenticated(req)) return next();
  return res.redirect('/login');
});

app.get('/assets/:file', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'assets', req.params.file));
});

const APP_HTML = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');

app.get('/', (req, res) => {
  res.type('html').send(APP_HTML);
});

const PORT = process.env.PORT || 3003;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Panel główny działa na http://localhost:${PORT}`);
  });
}

module.exports = app;
