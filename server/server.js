require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { getClient } = require('./supabase');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// KRYTYCZNE dla bramki hasła: res.sendFile() domyślnie ustawia
// "Cache-Control: public, max-age=0", co Vercel CDN traktuje jako
// zezwolenie na cache'owanie na brzegu sieci — i wtedy serwuje tę samą
// zapamiętaną odpowiedź (np. zalogowany widok "/") KAŻDEMU, także bez
// ciasteczka, całkowicie omijając middleware auth poniżej. Wszystko poza
// /assets musi być no-store.
app.use((req, res, next) => {
  if (!req.path.startsWith('/assets/')) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});

const SITE_PASSWORD = process.env.SITE_PASSWORD;
const COOKIE_NAME = 'lumlum_session';
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 dni

// Bez bazy użytkowników — jedno wspólne hasło. Token sesji jest podpisany
// HMAC-em (kluczem jest samo SITE_PASSWORD), więc jego ważność da się
// zweryfikować bezstanowo, bez trzymania listy sesji w pamięci procesu —
// ważne na serverless (Vercel), gdzie kolejne requesty mogą trafić do innej,
// nie współdzielącej pamięci instancji funkcji.
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
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Wymagane zalogowanie' });
  return res.redirect('/login');
});

// Bez express.static — na Vercelu jest ignorowany (statyki trzeba serwować
// z public/**, a to zepsułoby bramkę hasła dla index.html). sendFile działa
// wszędzie tak samo, więc zamiast tego jest zwykły route.
app.get('/assets/:file', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'assets', req.params.file));
});
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'), { cacheControl: false });
});

function handleError(res, err, fallbackStatus = 400) {
  console.error(err);
  const message = err.message || 'Wewnętrzny błąd serwera';
  const status = /brak/i.test(message) ? 500 : fallbackStatus;
  res.status(status).json({ error: message });
}

app.get('/api/tables/:table', async (req, res) => {
  try {
    const supabase = getClient();
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const { data, error } = await supabase
      .from(req.params.table)
      .select('*')
      .limit(limit);
    if (error) throw error;
    res.json(data);
  } catch (err) {
    handleError(res, err, 502);
  }
});

app.post('/api/tables/:table', async (req, res) => {
  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from(req.params.table)
      .insert(req.body)
      .select();
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    handleError(res, err, 502);
  }
});

app.put('/api/tables/:table/:id', async (req, res) => {
  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from(req.params.table)
      .update(req.body)
      .eq('id', req.params.id)
      .select();
    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Wiersz nie istnieje' });
    res.json(data[0]);
  } catch (err) {
    handleError(res, err, 502);
  }
});

app.delete('/api/tables/:table/:id', async (req, res) => {
  try {
    const supabase = getClient();
    const { error, count } = await supabase
      .from(req.params.table)
      .delete({ count: 'exact' })
      .eq('id', req.params.id);
    if (error) throw error;
    if (!count) return res.status(404).json({ error: 'Wiersz nie istnieje' });
    res.status(204).end();
  } catch (err) {
    handleError(res, err, 502);
  }
});

// Na Vercelu moduł jest tylko importowany (jako Vercel Function), nigdy
// uruchamiany bezpośrednio — listen() ma się odpalać tylko lokalnie.
if (require.main === module) {
  const port = process.env.PORT || 3001;
  app.listen(port, () => {
    console.log(`Serwer działa na http://localhost:${port}`);
  });
}

module.exports = app;
