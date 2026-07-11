// Panel główny lumlum.dev — ekran startowy narzędzi wewnętrznych: "Do
// zrobienia dziś" (akcje + zaległe feedbacki z Leady B2C), kafelki paneli
// wg uprawnień, panel Pozwolenia (użytkownicy i dostępy, tylko admin) oraz
// strony-atrapy przyszłych paneli (Wyceny / Wiadomości / Statystyki).
// Logowanie: indywidualne konta z app_users — wspólny moduł
// apps/shared/server/auth.js, ciasteczko z Path=/ obowiązuje w całej domenie.
const path = require('path');
// Lokalne env niezależnie od CWD, z którego odpalono serwer (na Vercelu
// zmienne przychodzą z projektu i dotenv niczego nie nadpisuje).
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config();
const fs = require('fs');
const express = require('express');
const { getClient } = require('./supabase');
const {
  createAuth, hashPassword, clientPayload, panelLinks, isAdmin, userHasPanel,
  PANELS, CRM_SHEETS, USERS_TABLE,
} = require('../../shared/server/auth');
const { servePushWorker, registerPushEndpoints } = require('../../shared/server/push');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Patrz apps/backlog-b2c/server/server.js — bez no-store Vercel CDN
// cache'owałby odpowiedzi po zalogowaniu i serwował je każdemu.
app.use((req, res, next) => {
  if (!req.path.startsWith('/assets/')) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});

// Assets/shared PRZED bramką auth — strona logowania też potrzebuje logo
// i wspólnych styli, a to statyki bez wrażliwych danych.
app.get('/assets/:file', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'assets', req.params.file));
});

// Wspólne pliki frontu (topbar) — ten sam wzorzec co /shared/ w obu appkach.
app.get('/shared/:file', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'shared', req.params.file));
});

const auth = createAuth({ getClient, panelKey: null, loginTitle: 'Panel główny' });
// /sw.js przed bramką auth (publiczny statyk — patrz apps/shared/server/push.js),
// endpointy /api/push/* za bramką (user z sesji).
servePushWorker(app);
auth.register(app);
registerPushEndpoints(app, { getClient });

// Wstrzyknięcie kontekstu do każdej strony huba: kto jest zalogowany, jakie
// ma panele i dokąd prowadzą linki (ścieżki na Vercelu, porty lokalnie).
function injectContext(html, req) {
  const payload = {
    API_BASE: req.baseUrl,
    LUMLUM_USER: clientPayload(req.user),
    LUMLUM_LINKS: panelLinks(),
    LUMLUM_PANELS: PANELS,
    LUMLUM_CRM_SHEETS: CRM_SHEETS,
  };
  const script = Object.entries(payload)
    .map(([key, value]) => `window.${key} = ${JSON.stringify(value)};`)
    .join('\n');
  return html.replace('<head>', `<head>\n<script>\n${script}\n</script>`);
}

const APP_HTML = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
const POZWOLENIA_HTML = fs.readFileSync(path.join(__dirname, '..', 'pozwolenia.html'), 'utf8');
const WKROTCE_HTML = fs.readFileSync(path.join(__dirname, '..', 'wkrotce.html'), 'utf8');

app.get('/', (req, res) => {
  res.type('html').send(injectContext(APP_HTML, req));
});

app.get('/pozwolenia', auth.requireAdmin, (req, res) => {
  res.type('html').send(injectContext(POZWOLENIA_HTML, req));
});

// Wyceny żyją jako zakładka CRM (decyzja 2026-07-11) — kafelek/link huba
// przekierowuje prosto do niej.
app.get('/wyceny', (req, res) => {
  if (!userHasPanel(req.user, 'wyceny')) return res.redirect(`${req.baseUrl}/`);
  res.redirect(`${panelLinks().crm}?arkusz=wyceny`);
});

// Strony-atrapy przyszłych paneli: jeden szablon, treść z rejestru PANELS.
// Dostęp wg uprawnień jak do prawdziwego panelu — kafelek i strona zachowują
// się od dziś tak, jak będą się zachowywać po zbudowaniu funkcjonalności.
// wiadomosci wypadło z atrap — to żywy panel apps/komunikator/ pod /wiadomosci/.
const SOON_PAGES = { statystyki: 'statystyki' };

Object.entries(SOON_PAGES).forEach(([route, panelKey]) => {
  app.get(`/${route}`, (req, res) => {
    if (!userHasPanel(req.user, panelKey)) return res.redirect(`${req.baseUrl}/`);
    const panel = PANELS.find((p) => p.key === panelKey);
    const html = WKROTCE_HTML
      .replaceAll('{{TITLE}}', panel.label)
      .replaceAll('{{DESC}}', panel.desc);
    res.type('html').send(injectContext(html, req));
  });
});

function handleError(res, err, fallbackStatus = 400) {
  console.error(err);
  const message = err.message || 'Wewnętrzny błąd serwera';
  const status = /brak/i.test(message) ? 500 : fallbackStatus;
  res.status(status).json({ error: message });
}

// ── "Do zrobienia dziś" — dane ekranu startowego ────────────────────────────

const LEADY_B2C_TABLE = 'Leady B2C';
const LOG_ZMIAN_TABLE = 'Log zmian';
// Kopia listy ze wspólnego modułu leady-endpoints (hub nie potrzebuje całego
// modułu, tylko tego zbioru): wpisy Log zmian, które NIE są telefonami.
const NIE_TELEFON_ZRODLA = new Set(['notatka_handlowca', 'manual_akcja', 'manual_crm']);

function warsawToday() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date()); // YYYY-MM-DD
  return parts;
}

// Dzień (bez godziny) z wartości w dowolnym używanym formacie: "DD.MM.YYYY
// [HH:mm]", ISO "YYYY-MM-DD..." — zwraca "YYYY-MM-DD" albo null.
function dayKey(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  let m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

function formatPhonePlus(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.startsWith('48') ? `+${digits}` : `+48${digits}`;
}

// GET /api/dzisiaj — akcje do zrobienia (zaległe / na dziś / bez terminu),
// zaległe feedbacki i liczniki na ekran startowy. Pozycje z leadów są
// filtrowane po kolumnie "Owner" (docs/plan-wlasnosc-zasobow.md): każdy widzi
// tylko leady przypisane do siebie (lead bez ownera przypada adminowi).
// Użytkownik z panelem Wiadomości dostaje dodatkowo wątki do odpisania z
// Komunikatora — dziś wszystkie (wiadomości są przypisane do Antoniego),
// per-user przyjdzie razem z przypisaniem wątków.
app.get('/api/dzisiaj', async (req, res) => {
  try {
    const supabase = getClient();
    const today = warsawToday();
    const [leadyResult, logResult] = await Promise.all([
      supabase.from(LEADY_B2C_TABLE).select(
        '"ID Leada",Name,"Phone number","Deal stage","Najbliższa akcja","Najbliższa akcja termin","Najbliższa akcja owner","Data Feedbacku","Godzina Feedbacku",Owner'
      ),
      supabase.from(LOG_ZMIAN_TABLE).select('telefon,zrodlo,data_zmiany').gte('data_zmiany', today),
    ]);
    if (leadyResult.error) throw leadyResult.error;
    if (logResult.error) throw logResult.error;

    const myName = String(req.user?.name || '').trim().toLowerCase();
    const admin = isAdmin(req.user);
    const isMine = (row) => {
      const owner = String(row['Owner'] || '').trim().toLowerCase();
      return owner ? owner === myName : admin;
    };
    const leady = (leadyResult.data || []).filter(isMine);

    const akcje = [];
    leady.forEach((row) => {
      const akcja = String(row['Najbliższa akcja'] || '').trim();
      if (!akcja) return;
      const terminDay = dayKey(row['Najbliższa akcja termin']);
      // Przyszłe terminy nie zaśmiecają "dziś" — pokażą się swojego dnia.
      if (terminDay && terminDay > today) return;
      akcje.push({
        id: row['ID Leada'],
        name: row['Name'] || '(bez imienia)',
        telefon: formatPhonePlus(row['Phone number']),
        status: row['Deal stage'] || '',
        akcja,
        termin: row['Najbliższa akcja termin'] || '',
        owner: row['Najbliższa akcja owner'] || '',
        // brak terminu traktujemy jak "na dziś", nie jak zaległość
        zalegle: Boolean(terminDay && terminDay < today),
      });
    });
    // Zaległe najpierw (najstarsze na górze), potem dzisiejsze, potem bez terminu.
    akcje.sort((a, b) => {
      const ka = a.zalegle ? `0${dayKey(a.termin)}` : (dayKey(a.termin) ? '1' : '2');
      const kb = b.zalegle ? `0${dayKey(b.termin)}` : (dayKey(b.termin) ? '1' : '2');
      return ka.localeCompare(kb);
    });

    const akcjeIds = new Set(akcje.map((a) => String(a.id)));
    const feedbacki = [];
    leady.forEach((row) => {
      const fbDay = dayKey(row['Data Feedbacku']);
      if (!fbDay || fbDay > today) return;
      if (akcjeIds.has(String(row['ID Leada']))) return; // już na liście akcji
      feedbacki.push({
        id: row['ID Leada'],
        name: row['Name'] || '(bez imienia)',
        telefon: formatPhonePlus(row['Phone number']),
        status: row['Deal stage'] || '',
        feedback: row['Data Feedbacku'],
        godzina: row['Godzina Feedbacku'] || '',
        zalegle: fbDay < today,
      });
    });
    feedbacki.sort((a, b) => String(dayKey(a.feedback)).localeCompare(String(dayKey(b.feedback))));

    const kontaktyDzis = (logResult.data || []).filter(
      (r) => !NIE_TELEFON_ZRODLA.has(r.zrodlo) && String(r.data_zmiany || '').slice(0, 10) === today
    ).length;
    const nowe = leady.filter((r) => String(r['Deal stage'] || '').trim().toLowerCase() === 'nowy').length;

    // Wiadomości do odpisania (Komunikator): wątki attention+inbox — tylko
    // dla kont z dostępem do panelu Wiadomości. Miękka degradacja: błąd tabel
    // kom_* nie może położyć całego ekranu startowego.
    let wiadomosci = null;
    if (userHasPanel(req.user, 'wiadomosci')) {
      try {
        const { data, error } = await supabase
          .from('kom_threads')
          .select('id,channel,last_message_at,kom_customers(display_name,public_id)')
          .eq('status', 'attention')
          .eq('triage', 'inbox')
          .order('last_message_at', { ascending: false })
          .limit(40);
        if (error) throw error;
        wiadomosci = (data || []).map((t) => ({
          id: t.id,
          channel: t.channel,
          name: t.kom_customers?.display_name || t.kom_customers?.public_id || '(bez nazwy)',
          ostatnia: t.last_message_at,
        }));
      } catch (err) {
        console.error('Błąd odczytu wątków Komunikatora do "dzisiaj":', err.message);
      }
    }

    res.json({
      dzis: today,
      akcje: akcje.slice(0, 40),
      feedbacki: feedbacki.slice(0, 40),
      ...(wiadomosci ? { wiadomosci } : {}),
      stats: {
        akcje: akcje.length,
        zalegleAkcje: akcje.filter((a) => a.zalegle).length,
        feedbacki: feedbacki.length,
        nowe,
        kontaktyDzis,
        ...(wiadomosci ? { wiadomosci: wiadomosci.length } : {}),
      },
    });
  } catch (err) {
    handleError(res, err, 502);
  }
});

// ── Zmiana własnego hasła (każdy zalogowany) ────────────────────────────────

app.post('/api/me/haslo', async (req, res) => {
  try {
    const noweHaslo = String(req.body?.noweHaslo || '');
    if (noweHaslo.length < 8) return res.status(400).json({ error: 'Hasło musi mieć min. 8 znaków' });
    const { error } = await getClient()
      .from(USERS_TABLE)
      .update({ password_hash: hashPassword(noweHaslo) })
      .eq('id', req.user.id);
    if (error) throw error;
    auth.invalidateUserCache(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err, 502);
  }
});

// ── Pozwolenia: zarządzanie użytkownikami (tylko admin) ─────────────────────

function sanitizePermissions(input) {
  const validPanels = new Set(PANELS.filter((p) => !p.adminOnly).map((p) => p.key));
  const validSheets = new Set(CRM_SHEETS.map((s) => s.key));
  const panels = Array.isArray(input?.panels)
    ? input.panels.filter((k) => validPanels.has(k))
    : [];
  const crm_sheets = {};
  Object.entries(input?.crm_sheets || {}).forEach(([key, level]) => {
    if (validSheets.has(key) && (level === 'view' || level === 'edit')) crm_sheets[key] = level;
  });
  return { panels, crm_sheets };
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    permissions: row.permissions || {},
    active: row.active,
    created_at: row.created_at,
  };
}

app.get('/api/users', auth.requireAdmin, async (req, res) => {
  try {
    const { data, error } = await getClient().from(USERS_TABLE).select('*').order('id', { ascending: true });
    if (error) throw error;
    res.json({ data: (data || []).map(publicUser) });
  } catch (err) {
    handleError(res, err, 502);
  }
});

app.post('/api/users', auth.requireAdmin, async (req, res) => {
  try {
    const { email, name, password, role, permissions } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(cleanEmail)) return res.status(400).json({ error: 'Nieprawidłowy e-mail' });
    if (!String(name || '').trim()) return res.status(400).json({ error: 'Podaj imię/nazwę' });
    if (String(password || '').length < 8) return res.status(400).json({ error: 'Hasło musi mieć min. 8 znaków' });

    const { data, error } = await getClient().from(USERS_TABLE).insert({
      email: cleanEmail,
      name: String(name).trim(),
      password_hash: hashPassword(password),
      role: role === 'admin' ? 'admin' : 'user',
      permissions: sanitizePermissions(permissions),
    }).select('*');
    if (error) {
      if (/duplicate|unique/i.test(error.message)) return res.status(409).json({ error: 'Użytkownik z tym e-mailem już istnieje' });
      throw error;
    }
    res.json({ data: publicUser(data[0]) });
  } catch (err) {
    handleError(res, err, 502);
  }
});

app.put('/api/users/:id', auth.requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Nieprawidłowe id' });

    const patch = {};
    const body = req.body || {};
    if (body.name !== undefined) {
      if (!String(body.name).trim()) return res.status(400).json({ error: 'Imię nie może być puste' });
      patch.name = String(body.name).trim();
    }
    if (body.permissions !== undefined) patch.permissions = sanitizePermissions(body.permissions);
    if (body.password !== undefined && body.password !== '') {
      if (String(body.password).length < 8) return res.status(400).json({ error: 'Hasło musi mieć min. 8 znaków' });
      patch.password_hash = hashPassword(body.password);
    }
    if (body.role !== undefined) patch.role = body.role === 'admin' ? 'admin' : 'user';
    if (body.active !== undefined) patch.active = Boolean(body.active);

    // Admin nie może odebrać sobie admina ani się dezaktywować — jedyna
    // ochrona przed zamknięciem sobie drzwi do panelu Pozwolenia.
    if (id === req.user.id && (patch.role === 'user' || patch.active === false)) {
      return res.status(400).json({ error: 'Nie możesz odebrać uprawnień własnemu kontu' });
    }

    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Brak zmian do zapisania' });

    const { data, error } = await getClient().from(USERS_TABLE).update(patch).eq('id', id).select('*');
    if (error) throw error;
    if (!data || !data.length) return res.status(404).json({ error: 'Nie znaleziono użytkownika' });
    auth.invalidateUserCache(id);
    res.json({ data: publicUser(data[0]) });
  } catch (err) {
    handleError(res, err, 502);
  }
});

const PORT = process.env.PORT || 3003;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Panel główny działa na http://localhost:${PORT}`);
  });
}

module.exports = app;
