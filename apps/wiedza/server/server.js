// Panel Wiedza (lumlum.dev/wiedza) — UI nad wspólnym modułem Bazy Wiedzy
// (apps/shared/server/knowledge.js, brief: docs/plan-baza-wiedzy.md).
// Q&A, kolejka "do zatwierdzenia" (komentarz Antoniego poprawia fakt przed
// zatwierdzeniem), ręczne dodawanie, lista faktów, luki wiedzy.
//
// Role: admin (Antoni) pyta jako 'owner' i zarządza faktami; pozostali
// użytkownicy z dostępem do panelu widzą wyłącznie fakty team/public
// i tylko czytają/pytają (rola 'team').
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config();
const fs = require('fs');
const express = require('express');
const { getClient } = require('./supabase');
const { createAuth, clientPayload, panelLinks, isAdmin, PANELS, CRM_SHEETS } = require('../../shared/server/auth');
const knowledge = require('../../shared/server/knowledge');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// Patrz apps/backlog-b2c/server/server.js — bez no-store Vercel CDN
// cache'owałby odpowiedzi po zalogowaniu i serwował je każdemu.
app.use((req, res, next) => {
  if (!req.path.startsWith('/assets/')) res.set('Cache-Control', 'no-store');
  next();
});

// Statyki przed bramką auth (logo dla strony logowania) — logo z huba,
// wspólne pliki frontu (topbar) jak w pozostałych appkach.
app.get('/assets/:file', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'hub', 'assets', req.params.file));
});
app.get('/shared/:file', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'shared', req.params.file));
});

const auth = createAuth({ getClient, panelKey: 'wiedza', loginTitle: 'Baza Wiedzy' });
auth.register(app);

const APP_HTML = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');

app.get('/', (req, res) => {
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
  res.type('html').send(APP_HTML.replace('<head>', `<head>\n<script>\n${script}\n</script>`));
});

function handleError(res, err, fallbackStatus = 400) {
  console.error(err);
  res.status(fallbackStatus).json({ error: err.message || 'Wewnętrzny błąd serwera' });
}

// Rola wywołującego dla modułu wiedzy. KAŻDE zapytanie nie-admina = 'team' —
// fakt 'owner' dla takiego użytkownika nie istnieje (filtr w SQL).
function roleOf(user) {
  return isAdmin(user) ? 'owner' : 'team';
}

// ── Q&A ─────────────────────────────────────────────────────────────────────

// POST /api/ask { question, jako? } — jako:'team' pozwala adminowi sprawdzić,
// co zobaczy zespół/Lorenzo. Nie-admin ZAWSZE pyta jako team.
app.post('/api/ask', async (req, res) => {
  try {
    const question = String(req.body?.question || '').trim();
    if (!question) return res.status(400).json({ error: 'Podaj pytanie' });
    let role = roleOf(req.user);
    if (role === 'owner' && req.body?.jako === 'team') role = 'team';
    const result = await knowledge.ask(getClient(), {
      question,
      role,
      askedBy: `${req.user.email} (${role})`,
    });
    res.json(result);
  } catch (err) {
    handleError(res, err, 502);
  }
});

// ── Fakty: lista / dodawanie / review ───────────────────────────────────────

const STATUSY = new Set(['proposed', 'active', 'rejected', 'archived']);
const WIDOCZNOSCI = new Set(['owner', 'team', 'public']);

function publicFact(row) {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    tags: row.tags || [],
    visibility: row.visibility,
    status: row.status,
    source: row.source,
    source_ref: row.source_ref,
    created_by: row.created_by,
    created_at: row.created_at,
    reviewed_at: row.reviewed_at,
  };
}

// GET /api/facts?status=proposed&q=tekst — lista (nowsze pierwsze).
// Nie-admin nigdy nie dostaje faktów 'owner' (filtr w zapytaniu do bazy).
app.get('/api/facts', async (req, res) => {
  try {
    const status = STATUSY.has(req.query.status) ? req.query.status : 'active';
    let query = getClient()
      .from('kb_facts')
      .select('id,title,content,tags,visibility,status,source,source_ref,created_by,created_at,reviewed_at')
      .eq('status', status)
      .order('created_at', { ascending: false })
      .limit(200);
    if (!isAdmin(req.user)) query = query.in('visibility', ['team', 'public']);
    const q = String(req.query.q || '').trim();
    if (q) query = query.or(`title.ilike.%${q}%,content.ilike.%${q}%`);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ data: (data || []).map(publicFact) });
  } catch (err) {
    handleError(res, err, 502);
  }
});

// GET /api/stats — liczniki do zakładek.
app.get('/api/stats', async (req, res) => {
  try {
    const db = getClient();
    const count = (q) => q.select('id', { count: 'exact', head: true });
    const [proposed, active, gaps] = await Promise.all([
      count(db.from('kb_facts')).eq('status', 'proposed'),
      count(db.from('kb_facts')).eq('status', 'active'),
      count(db.from('kb_questions')).eq('answered', false),
    ]);
    res.json({
      proposed: proposed.count || 0,
      active: active.count || 0,
      luki: gaps.count || 0,
    });
  } catch (err) {
    handleError(res, err, 502);
  }
});

// POST /api/facts — ręczne dodanie. Admin dodaje od razu jako 'active'
// (to jego wiedza), pozostali jako 'proposed' do review.
app.post('/api/facts', async (req, res) => {
  try {
    const { title, content, tags, visibility, lukaId } = req.body || {};
    if (!String(title || '').trim() || !String(content || '').trim()) {
      return res.status(400).json({ error: 'Podaj tytuł i treść faktu' });
    }
    const admin = isAdmin(req.user);
    const vis = WIDOCZNOSCI.has(visibility) ? visibility : 'owner';
    const created = await knowledge.proposeFact(getClient(), {
      title: String(title).trim(),
      content: String(content).trim(),
      tags: Array.isArray(tags) ? tags : String(tags || '').split(',').map((t) => t.trim()).filter(Boolean),
      // nie-admin nie może tworzyć faktów 'owner' (i tak by ich nie zobaczył)
      visibility: admin ? vis : (vis === 'owner' ? 'team' : vis),
      status: admin ? 'active' : 'proposed',
      source: 'manual',
      createdBy: req.user.email,
    });
    if (lukaId) {
      await getClient().from('kb_questions')
        .update({ answered: true, answer: `uzupełniono faktem ${created.id}` })
        .eq('id', lukaId);
    }
    res.json({ data: created });
  } catch (err) {
    handleError(res, err, 502);
  }
});

// POST /api/facts/:id/poprawka — PODGLĄD korekty (tylko admin, NIC nie
// zapisuje): komentarz Antoniego (tekst lub dyktowany) → LLM analizuje fakt
// i zwraca poprawioną wersję. Antoni w panelu decyduje: Zapisz albo Odrzuć.
app.post('/api/facts/:id/poprawka', auth.requireAdmin, async (req, res) => {
  try {
    const comment = String(req.body?.comment || '').trim();
    if (!comment) return res.status(400).json({ error: 'Napisz albo podyktuj komentarz' });
    const { data, error } = await getClient().from('kb_facts').select('*').eq('id', req.params.id).limit(1);
    if (error) throw error;
    const fact = data && data[0];
    if (!fact) return res.status(404).json({ error: 'Nie znaleziono faktu' });
    const revised = await knowledge.reviseWithComment({ fact, comment });
    res.json({ data: revised });
  } catch (err) {
    handleError(res, err, 502);
  }
});

// POST /api/facts/:id/review — decyzja (tylko admin).
// { decision:'approve'|'reject', title?, content?, visibility?, tags? }
// title/content przychodzą z ZATWIERDZONEGO przez Antoniego podglądu
// korekty (endpoint /poprawka). Działa też na faktach 'active' (edycja).
app.post('/api/facts/:id/review', auth.requireAdmin, async (req, res) => {
  try {
    const db = getClient();
    const { decision, title, content, visibility, tags } = req.body || {};
    const result = await knowledge.reviewFact(db, req.params.id, {
      decision,
      title: String(title || '').trim() || undefined,
      content: String(content || '').trim() || undefined,
      visibility: WIDOCZNOSCI.has(visibility) ? visibility : undefined,
      tags: Array.isArray(tags) ? tags : undefined,
    });
    res.json({ data: result });
  } catch (err) {
    handleError(res, err, 502);
  }
});

// ── Luki wiedzy (pytania bez odpowiedzi) ────────────────────────────────────

app.get('/api/luki', auth.requireAdmin, async (req, res) => {
  try {
    const { data, error } = await getClient()
      .from('kb_questions')
      .select('id,asked_by,question,created_at')
      .eq('answered', false)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json({ data: data || [] });
  } catch (err) {
    handleError(res, err, 502);
  }
});

app.post('/api/luki/:id/zamknij', auth.requireAdmin, async (req, res) => {
  try {
    const { error } = await getClient()
      .from('kb_questions')
      .update({ answered: true, answer: 'zamknięta ręcznie w panelu' })
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err, 502);
  }
});

const PORT = process.env.PORT || 3005;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Panel Wiedza działa na http://localhost:${PORT}`);
  });
}

module.exports = app;
