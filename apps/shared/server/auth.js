// ── Wspólne logowanie i uprawnienia (hub + Backlog B2C + CRM) ────────────────
// Indywidualne konta użytkowników w tabeli Supabase `app_users` zamiast
// jednego wspólnego hasła. Sesja pozostaje BEZSTANOWA (serverless na Vercelu
// nie współdzieli pamięci): ciasteczko `lumlum_session` z Path=/ niesie
// `u.<id>.<expires>.<hmac>` podpisany SESSION_SECRET (fallback: SITE_PASSWORD,
// żeby prod działał bez dodawania nowych zmiennych środowiskowych).
//
// Uprawnienia (kolumna jsonb `permissions` na app_users):
//   {
//     "panels": ["backlog-b2c", "crm", ...],          // do których paneli wchodzi
//     "crm_sheets": { "leady-b2c": "edit" | "view" }  // arkusze CRM: podgląd/edycja
//   }
// role='admin' pomija wszystkie sprawdzenia. Egzekwowanie jest SERVER-SIDE:
// bramka panelu w każdej appce + middleware requireSheet na endpointach CRM.
//
// Użycie (każdy serwer, PRZED swoimi route'ami):
//   const auth = createAuth({ getClient, panelKey: 'crm' });
//   auth.register(app);   // /login, /logout, bramka
// a potem np. app.get('/api/x', auth.requireSheet('leady-b2c','edit'), ...)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COOKIE_NAME = 'lumlum_session';
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 dni
const USERS_TABLE = 'app_users';
// Krótki cache użytkownika per instancja funkcji — zmiana uprawnień w panelu
// Pozwolenia dojeżdża do wszystkich appek najpóźniej po USER_CACHE_TTL_MS,
// bez odpytywania bazy przy każdym pojedynczym requeście o asset.
const USER_CACHE_TTL_MS = 30 * 1000;

// Jedno źródło prawdy o panelach systemu — hub renderuje z tego kafelki,
// panel Pozwolenia checkboxy, topbar linki nawigacji.
const PANELS = [
  { key: 'backlog-b2c', label: 'Backlog B2C', desc: 'Dzienny standup: plan dnia, Umowa, priorytety, podsumowanie', status: 'live' },
  { key: 'crm', label: 'CRM', desc: 'Leady B2C: arkusz, karta leada, pytania do AI', status: 'live' },
  { key: 'wyceny', label: 'Wyceny', desc: 'Panel wycen: tworzenie, edycja kwot i statusów', status: 'soon' },
  { key: 'wiadomosci', label: 'Wiadomości', desc: 'Hub wiadomości: komunikacja z klientami w jednym miejscu', status: 'soon' },
  { key: 'statystyki', label: 'Statystyki', desc: 'Lejek, telefony, skuteczność — dane z całego systemu', status: 'soon' },
  { key: 'pozwolenia', label: 'Pozwolenia', desc: 'Użytkownicy i dostępy do paneli oraz arkuszy', status: 'live', adminOnly: true },
];

// Arkusze CRM podlegające uprawnieniom podgląd/edycja (rejestr rośnie razem
// z NAV_SECTIONS w apps/crm/app.html i AI_SECTIONS w apps/crm/server).
const CRM_SHEETS = [
  { key: 'leady-b2c', label: 'Leady B2C' },
];

// ── Hasła: scrypt z solą (crypto wbudowane, bez zależności) ─────────────────

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `s2$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 's2' || !salt || !hash) return false;
  const expected = crypto.scryptSync(String(password), salt, 64).toString('hex');
  if (expected.length !== hash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hash));
}

// ── Uprawnienia ──────────────────────────────────────────────────────────────

function isAdmin(user) {
  return Boolean(user && user.role === 'admin');
}

function userPanels(user) {
  if (!user) return [];
  if (isAdmin(user)) return PANELS.map((p) => p.key);
  const panels = Array.isArray(user.permissions?.panels) ? user.permissions.panels : [];
  return PANELS.filter((p) => !p.adminOnly && panels.includes(p.key)).map((p) => p.key);
}

function userHasPanel(user, panelKey) {
  if (!panelKey) return Boolean(user);
  return userPanels(user).includes(panelKey);
}

// 'view' spełnia też edycja; 'edit' wymaga edycji. Admin: zawsze 'edit'.
function userSheetLevel(user, sheetKey) {
  if (!user) return null;
  if (isAdmin(user)) return 'edit';
  const level = user.permissions?.crm_sheets?.[sheetKey];
  return level === 'edit' || level === 'view' ? level : null;
}

function userCanSheet(user, sheetKey, needed) {
  const level = userSheetLevel(user, sheetKey);
  if (!level) return false;
  return needed === 'view' ? true : level === 'edit';
}

// Payload wstrzykiwany do frontu jako window.LUMLUM_USER — tylko to, czego
// UI potrzebuje (nigdy hash hasła ani surowy wiersz).
function clientPayload(user) {
  const sheets = {};
  CRM_SHEETS.forEach((s) => {
    const level = userSheetLevel(user, s.key);
    if (level) sheets[s.key] = level;
  });
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    isAdmin: isAdmin(user),
    panels: userPanels(user),
    crmSheets: sheets,
  };
}

// Linki między panelami: na Vercelu ścieżki jednej domeny, lokalnie każda
// appka to osobny port (hub 3003, backlog 3001, crm 3002).
function panelLinks() {
  if (process.env.VERCEL) {
    return {
      hub: '/',
      'backlog-b2c': '/backlog-b2c/',
      crm: '/crm/',
      wyceny: '/wyceny',
      wiadomosci: '/wiadomosci',
      statystyki: '/statystyki',
      pozwolenia: '/pozwolenia',
    };
  }
  const hub = 'http://localhost:3003';
  return {
    hub: `${hub}/`,
    'backlog-b2c': 'http://localhost:3001/',
    crm: 'http://localhost:3002/',
    wyceny: `${hub}/wyceny`,
    wiadomosci: `${hub}/wiadomosci`,
    statystyki: `${hub}/statystyki`,
    pozwolenia: `${hub}/pozwolenia`,
  };
}

// ── Sesja ────────────────────────────────────────────────────────────────────

function sessionSecret() {
  return process.env.SESSION_SECRET || process.env.SITE_PASSWORD || '';
}

function sign(value) {
  return crypto.createHmac('sha256', sessionSecret()).update(value).digest('hex');
}

function createSessionToken(userId) {
  const expires = String(Date.now() + SESSION_MAX_AGE_MS);
  return `u.${userId}.${expires}.${sign(`${userId}.${expires}`)}`;
}

// Zwraca userId (number) albo null. Stary format tokenu (wspólne hasło,
// `expires.sig`) jest tu z definicji nieważny — użytkownik loguje się od nowa.
function parseSessionToken(token) {
  if (!token || !sessionSecret()) return null;
  const [prefix, id, expires, sig] = String(token).split('.');
  if (prefix !== 'u' || !id || !expires || !sig) return null;
  const expected = sign(`${id}.${expires}`);
  if (expected.length !== sig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  if (Number(expires) <= Date.now()) return null;
  const userId = Number(id);
  return Number.isFinite(userId) ? userId : null;
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  const match = header.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_MAX_AGE_MS / 1000}; SameSite=Lax`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

// ── Strona 403 (spójna z login.html, bez osobnego pliku) ────────────────────

function forbiddenPage(links) {
  return `<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Brak dostępu</title>
<style>
  :root { --page:#f5f5f4; --text:#111; --muted:#8a8984; --surface:#fff; --border:rgba(17,17,17,.12); }
  @media (prefers-color-scheme: dark) { :root { --page:#0a0a0a; --text:#fff; --muted:#8a8984; --surface:#161616; --border:rgba(255,255,255,.14); } }
  body { font-family:'Inter',system-ui,sans-serif; background:var(--page); color:var(--text); min-height:100vh; display:flex; align-items:center; justify-content:center; margin:0; padding:1rem; }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:18px; padding:2.2rem 2rem; max-width:380px; text-align:center; }
  h1 { font-size:1.15rem; margin:0 0 .5rem; }
  p { color:var(--muted); font-size:.9rem; margin:0 0 1.2rem; line-height:1.5; }
  a { display:inline-block; background:var(--text); color:var(--page); text-decoration:none; font-weight:600; font-size:.9rem; padding:.55rem 1.2rem; border-radius:999px; }
</style></head><body><div class="card">
<h1>Brak dostępu do tego panelu</h1>
<p>Twoje konto nie ma przypisanego dostępu. Poproś administratora o nadanie uprawnień w panelu Pozwolenia.</p>
<a href="${links.hub}">← Wróć do ekranu głównego</a>
</div></body></html>`;
}

// ── Główna fabryka ───────────────────────────────────────────────────────────

// opts:
//   getClient      — () => klient Supabase (service role)
//   panelKey       — klucz panelu, którego dostępu wymaga bramka ('backlog-b2c',
//                    'crm'); null/undefined = wystarczy zalogowanie (hub)
//   publicPrefixes — ścieżki pomijające bramkę (webhooki/crony z własną autoryzacją)
//   loginTitle     — nagłówek na stronie logowania (nazwa panelu)
function createAuth({ getClient, panelKey = null, publicPrefixes = [], loginTitle = 'LumLum' }) {
  const LOGIN_HTML = fs.readFileSync(path.join(__dirname, 'login.html'), 'utf8');
  const userCache = new Map(); // id -> { user, loadedAt }

  async function loadUser(userId) {
    const cached = userCache.get(userId);
    if (cached && Date.now() - cached.loadedAt < USER_CACHE_TTL_MS) return cached.user;
    const { data, error } = await getClient()
      .from(USERS_TABLE)
      .select('*')
      .eq('id', userId)
      .limit(1);
    if (error) throw error;
    const user = (data && data[0]) || null;
    userCache.set(userId, { user, loadedAt: Date.now() });
    return user;
  }

  async function findUserByEmail(email) {
    const { data, error } = await getClient()
      .from(USERS_TABLE)
      .select('*')
      .ilike('email', String(email || '').trim())
      .limit(1);
    if (error) throw error;
    return (data && data[0]) || null;
  }

  function invalidateUserCache(userId) {
    if (userId === undefined) userCache.clear();
    else userCache.delete(Number(userId));
  }

  function loginPage(req, res) {
    const html = LOGIN_HTML
      .replaceAll('{{TITLE}}', loginTitle)
      .replace('{{ERROR}}', req.query.error === '1' ? 'block' : 'none');
    res.type('html').send(html);
  }

  async function loginSubmit(req, res) {
    try {
      const email = String(req.body?.email || '').trim();
      const password = String(req.body?.password || '');
      const user = email && password ? await findUserByEmail(email) : null;
      if (user && user.active !== false && verifyPassword(password, user.password_hash)) {
        setSessionCookie(res, createSessionToken(user.id));
        return res.redirect(`${req.baseUrl}/`);
      }
    } catch (err) {
      console.error('Błąd logowania:', err.message);
    }
    res.redirect(`${req.baseUrl}/login?error=1`);
  }

  function logout(req, res) {
    clearSessionCookie(res);
    res.redirect(`${req.baseUrl}/login`);
  }

  // Bramka: uwierzytelnienie (podpisane ciasteczko → żywy wiersz app_users)
  // + autoryzacja panelu. Nieuwierzytelnione API → 401 JSON; strony → login.
  // Uwierzytelniony bez dostępu do panelu → 403.
  async function gate(req, res, next) {
    if (publicPrefixes.some((p) => req.path.startsWith(p))) return next();
    let user = null;
    try {
      const userId = parseSessionToken(readCookie(req, COOKIE_NAME));
      if (userId) user = await loadUser(userId);
    } catch (err) {
      console.error('Błąd wczytania użytkownika sesji:', err.message);
      return res.status(503).send('Błąd serwera przy weryfikacji sesji — spróbuj ponownie.');
    }
    if (!user || user.active === false) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Wymagane zalogowanie' });
      clearSessionCookie(res);
      return res.redirect(`${req.baseUrl}/login`);
    }
    req.user = user;
    if (!userHasPanel(user, panelKey)) {
      if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Brak dostępu do tego panelu' });
      return res.status(403).type('html').send(forbiddenPage(panelLinks()));
    }
    return next();
  }

  function requireAdmin(req, res, next) {
    if (isAdmin(req.user)) return next();
    if (req.path.startsWith('/api/') || req.baseUrl.includes('/api/')) {
      return res.status(403).json({ error: 'Wymagane uprawnienia administratora' });
    }
    return res.status(403).type('html').send(forbiddenPage(panelLinks()));
  }

  // Fabryka middleware dla arkuszy CRM: requireSheet('leady-b2c', 'edit').
  function requireSheet(sheetKey, needed) {
    return (req, res, next) => {
      if (userCanSheet(req.user, sheetKey, needed)) return next();
      return res.status(403).json({
        error: needed === 'edit'
          ? 'Masz dostęp tylko do podglądu tego arkusza'
          : 'Brak dostępu do tego arkusza',
      });
    };
  }

  // Rejestruje standardowy zestaw route'ów auth na appce (przed jej route'ami).
  function register(app) {
    app.get('/login', loginPage);
    app.post('/login', loginSubmit);
    app.get('/logout', logout);
    app.use(gate);
  }

  return {
    register,
    loginPage,
    loginSubmit,
    logout,
    gate,
    requireAdmin,
    requireSheet,
    invalidateUserCache,
    findUserByEmail,
  };
}

module.exports = {
  createAuth,
  hashPassword,
  verifyPassword,
  clientPayload,
  panelLinks,
  isAdmin,
  userHasPanel,
  userPanels,
  userSheetLevel,
  userCanSheet,
  PANELS,
  CRM_SHEETS,
  USERS_TABLE,
};
