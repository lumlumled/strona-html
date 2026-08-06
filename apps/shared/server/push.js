// ── Wspólne endpointy powiadomień push (wszystkie panele) ───────────────────
// Web Push (VAPID) wg docs/plan-powiadomienia-push.md. Każdy serwer woła:
//   servePushWorker(app)                 — PRZED bramką auth (SW to statyk),
//   registerPushEndpoints(app, { getClient }) — PO bramce (user z sesji).
// Endpointy są względne (/api/push/...), więc z każdego panelu front pyta
// własny origin — zero CORS lokalnie (osobne porty) i na Vercelu (rewrite'y).
// Subskrypcje żyją w push_subscriptions (scripts/create-push-subscriptions.js),
// wysyłka: notifyUser(getClient, userId, payload) — użyją jej też przyszłe
// producenci zdarzeń (nowy lead / sprzedaż / feedback / wiadomość).

const path = require('path');
const webpush = require('web-push');

const SUBSCRIPTIONS_TABLE = 'push_subscriptions';

// ── Wyciszanie powiadomień per użytkownik (alert fatigue) ────────────────────
// Handlowiec w teście umowy tonął w powiadomieniach i przez to gubił te ważne:
// Lorenzo PRZEGAPIŁ nowego leada, bo watchdog spamował go „temat ucieka".
// Decyzja Antoniego (6.08): Lorenzo dostaje tylko nowy lead, przypomnienie
// feedbacku, SMS od klienta oraz pingi o sprzedaży — a watchdog ma milczeć.
//
// Realizacja jako DENYLISTA (nie allowlista): dla handlowca gorzej ZGUBIĆ sygnał
// (leada) niż wpuścić trochę szumu, więc odcinamy tylko jawnie hałaśliwe typy
// (watchdog), a nowe/nieznane typy nadal dochodzą. Typ wnioskujemy z prefiksu
// `tag`, który każdy producent i tak już nadaje. Wszystko idzie przez notifyUser,
// więc jedna bramka pokrywa wszystkich producentów (push do ownera, crony, itd.).
//
// Konfiguracja env (opcjonalna, nadpisuje domyślne):
//   PUSH_MUTE_RULES = "Lorenzo:watchdog;Ktoś:watchdog,wiadomosc"
// Pusty env => domyślne poniżej. "0"/"off" => wyłącza wyciszanie całkowicie.
const DEFAULT_MUTE_RULES = { lorenzo: ['watchdog'] };

// Prefiks `tag` -> typ powiadomienia. Nowy producent, który ma podlegać
// wyciszaniu, dopisuje tu swój prefiks; nierozpoznane = 'inne' (nie wyciszane).
function tagKind(tag) {
  const t = String(tag || '');
  if (t.startsWith('watchdog')) return 'watchdog';
  if (t.startsWith('nowy-lead') || t.startsWith('new-lead')) return 'nowy_lead';
  if (t.startsWith('sla-')) return 'sla';
  if (t.startsWith('feedback-reminder')) return 'feedback';
  if (t.startsWith('sms-')) return 'sms';
  if (t.startsWith('wycena-') || t.startsWith('sklep-') || t.startsWith('fulfillment')) return 'sprzedaz';
  if (t.startsWith('kom-msg')) return 'wiadomosc';
  if (t.startsWith('push-test')) return 'test';
  return 'inne';
}

// Parsuje PUSH_MUTE_RULES do mapy { imię(lowercase): [typy] }. Bez env = domyślne.
function muteRules() {
  const raw = String(process.env.PUSH_MUTE_RULES ?? '').trim();
  if (!raw) return DEFAULT_MUTE_RULES;
  if (raw === '0' || raw.toLowerCase() === 'off') return {};
  const rules = {};
  for (const part of raw.split(';').map((s) => s.trim()).filter(Boolean)) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim().toLowerCase();
    const kinds = part.slice(idx + 1).split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
    if (name && kinds.length) rules[name] = kinds;
  }
  return rules;
}

// Czy powiadomienie z danym `tag` jest wyciszone dla użytkownika o tym imieniu?
function isMuted(name, tag) {
  const muted = muteRules()[String(name || '').trim().toLowerCase()];
  return Array.isArray(muted) && muted.includes(tagKind(tag));
}

let vapidConfigured = false;
function ensureVapid() {
  if (vapidConfigured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:kontakt@lumlum.co', pub, priv);
  vapidConfigured = true;
  return true;
}

// Wysyłka do WSZYSTKICH urządzeń użytkownika. 404/410 od push service =
// subskrypcja martwa (cofnięta zgoda / reinstalacja) → wiersz kasujemy.
// Zwraca { sent, gone, failed } — do logów/diagnostyki.
async function notifyUser(getClient, userId, { title, body, url, tag }) {
  if (!ensureVapid()) throw new Error('Brak kluczy VAPID w env (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY)');
  const supabase = getClient();

  // Wyciszanie per użytkownik (alert fatigue) — patrz muteRules(). Sprawdzamy
  // dopiero gdy jakiekolwiek reguły istnieją, żeby nie dokładać zapytania o imię
  // przy każdym pushu, gdy wyciszanie jest wyłączone. Błąd lookupu = nie wyciszaj
  // (lepiej wysłać, niż zgubić przez awarię tabeli app_users).
  const rules = muteRules();
  if (Object.keys(rules).length) {
    let name = null;
    try {
      const { data } = await supabase.from('app_users').select('name').eq('id', userId).maybeSingle();
      name = data?.name || null;
    } catch (err) {
      console.warn('notifyUser: lookup imienia do wyciszenia nie wyszedł:', err.message);
    }
    if (name && isMuted(name, tag)) {
      return { sent: 0, gone: 0, failed: 0, muted: true };
    }
  }

  const { data: subs, error } = await supabase
    .from(SUBSCRIPTIONS_TABLE)
    .select('id,endpoint,p256dh,auth')
    .eq('user_id', userId);
  if (error) throw error;

  const payload = JSON.stringify({ title, body, url: url || '/', tag });
  let sent = 0;
  let gone = 0;
  let failed = 0;
  await Promise.all((subs || []).map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
      sent += 1;
      await supabase.from(SUBSCRIPTIONS_TABLE).update({ last_used_at: new Date().toISOString() }).eq('id', sub.id);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        gone += 1;
        await supabase.from(SUBSCRIPTIONS_TABLE).delete().eq('id', sub.id);
      } else {
        failed += 1;
        console.error(`Push do subskrypcji ${sub.id} nie wyszedł:`, err.statusCode || err.message);
      }
    }
  }));
  return { sent, gone, failed };
}

// /sw.js — service worker; MUSI żyć na roocie origin (scope /), stąd osobna
// funkcja wołana przed bramką auth (statyk bez wrażliwych danych, a fetch
// aktualizacji SW przez przeglądarkę nie może dostać przekierowania na login).
function servePushWorker(app) {
  app.get('/sw.js', (req, res) => {
    res.type('application/javascript');
    res.sendFile(path.join(__dirname, '..', 'push-sw.js'));
  });
}

function registerPushEndpoints(app, { getClient }) {
  // Klucz publiczny do pushManager.subscribe — front pobiera go z endpointu,
  // żeby klucz żył tylko w env (bez wkompilowania w HTML).
  app.get('/api/push/vapid-key', (req, res) => {
    if (!process.env.VAPID_PUBLIC_KEY) return res.status(500).json({ error: 'Brak VAPID_PUBLIC_KEY w env' });
    res.json({ key: process.env.VAPID_PUBLIC_KEY });
  });

  // Zapis subskrypcji urządzenia. user_id ZAWSZE z sesji (jak owner leada —
  // klient nie może zapisać urządzenia na kogoś innego). Upsert po endpoint:
  // ta sama przeglądarka po ponownym włączeniu nadpisuje swój wiersz, a
  // urządzenie przejęte po innym koncie przepina się na aktualnego usera.
  // Po zapisie leci od razu testowy push — użytkownik od razu widzi, że działa.
  app.post('/api/push/subscribe', async (req, res) => {
    try {
      const sub = req.body?.subscription;
      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
        return res.status(400).json({ error: 'Niepełna subskrypcja push' });
      }
      // silent=true: ciche odtworzenie subskrypcji przy wejściu (topbar) — bez
      // testowego pusha, żeby nie strzelać powiadomieniem przy każdym otwarciu.
      const silent = req.body?.silent === true;
      const supabase = getClient();
      const { error } = await supabase.from(SUBSCRIPTIONS_TABLE).upsert({
        user_id: req.user.id,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        user_agent: req.headers['user-agent'] || null,
      }, { onConflict: 'endpoint' });
      if (error) throw error;

      let test = null;
      if (!silent) {
        try {
          test = await notifyUser(getClient, req.user.id, {
            title: 'Nowa wiadomość (test)',
            body: 'Powiadomienia działają — tak będzie wyglądać info o nowej wiadomości.',
            url: '/wiadomosci',
            tag: 'push-test',
          });
        } catch (err) {
          console.error('Testowy push po subskrypcji nie wyszedł:', err.message);
        }
      }
      res.json({ ok: true, test });
    } catch (err) {
      console.error(err);
      res.status(502).json({ error: err.message || 'Błąd zapisu subskrypcji' });
    }
  });

  // Wyłączenie powiadomień na TYM urządzeniu — front najpierw robi
  // pushManager unsubscribe, potem zgłasza endpoint do skasowania.
  app.post('/api/push/unsubscribe', async (req, res) => {
    try {
      const endpoint = req.body?.endpoint;
      if (!endpoint) return res.status(400).json({ error: 'Brak endpointu' });
      const supabase = getClient();
      const { error } = await supabase
        .from(SUBSCRIPTIONS_TABLE)
        .delete()
        .eq('endpoint', endpoint)
        .eq('user_id', req.user.id);
      if (error) throw error;
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(502).json({ error: err.message || 'Błąd wypisania subskrypcji' });
    }
  });

  // Testowe powiadomienie na żądanie (wszystkie urządzenia zalogowanego).
  app.post('/api/push/test', async (req, res) => {
    try {
      const result = await notifyUser(getClient, req.user.id, {
        title: 'Nowa wiadomość (test)',
        body: 'Testowe powiadomienie z panelu LumLum.',
        url: '/wiadomosci',
        tag: 'push-test',
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error(err);
      res.status(502).json({ error: err.message || 'Błąd wysyłki testowej' });
    }
  });
}

module.exports = { servePushWorker, registerPushEndpoints, notifyUser, tagKind, muteRules, isMuted };
