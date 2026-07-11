// ── Service worker powiadomień push (cała domena lumlum.dev) ────────────────
// Serwowany pod /sw.js z KAŻDEGO panelu (apps/shared/server/push.js →
// servePushWorker; na Vercelu rewrite /sw.js → api/index), więc scope to
// zawsze root — jedna rejestracja obsługuje hub i wszystkie podścieżki.
// Celowo bez cache/offline: to tylko odbiornik pushy, appka żyje z sieci.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Payload z apps/shared/server/push.js: { title, body, url, tag }.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* pusty push = domyślne */ }
  event.waitUntil((async () => {
    await self.registration.showNotification(data.title || 'LumLum', {
      body: data.body || '',
      tag: data.tag || undefined,
      data: { url: data.url || '/' },
      icon: '/assets/lumlum-icon-192.png',
      badge: '/assets/lumlum-icon-192.png',
    });
    // Kropka/plakietka na ikonie aplikacji (iOS 16.4+/Android) — czyszczona
    // przy otwarciu appki w apps/shared/topbar.js (clearAppBadge).
    if (self.navigator.setAppBadge) {
      try { await self.navigator.setAppBadge(); } catch { /* nieobsługiwane */ }
    }
  })());
});

// Klik w powiadomienie: fokus na już otwarte okno appki (z nawigacją do
// celu), a bez otwartego okna — nowe.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins[0];
    if (win) {
      await win.focus();
      if ('navigate' in win) await win.navigate(url);
    } else {
      await self.clients.openWindow(url);
    }
  })());
});
