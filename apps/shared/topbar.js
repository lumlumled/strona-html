// ── Wspólny górny pasek nawigacji (hub + Backlog B2C + CRM) ─────────────────
// Jeden komponent nawigacji między panelami lumlum.dev. Wymaga wstrzykniętych
// przez serwer (patrz injectContext / GET '/' w każdej appce):
//   window.LUMLUM_USER  — { name, email, isAdmin, panels: [...] }
//   window.LUMLUM_LINKS — { hub, 'backlog-b2c', crm, ... } (ścieżki na
//                          Vercelu, porty localhost lokalnie)
//   window.API_BASE     — prefiks bieżącej appki (dla linku /logout)
// Użycie: LumTopbar.mount({ active: 'crm' }) — tworzy pasek na górze <body>
// albo wypełnia istniejący element przekazany w opts.into.
window.LumTopbar = (() => {
  'use strict';

  // ── Powiadomienia push (dzwoneczek) ────────────────────────────────────────
  // Web Push wg docs/plan-powiadomienia-push.md: /sw.js + /api/push/* serwuje
  // KAŻDY panel (apps/shared/server/push.js), więc fetch idzie zawsze na
  // własny origin (window.API_BASE) — zero CORS lokalnie i na Vercelu.

  function urlBase64ToUint8Array(base64) {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map((ch) => ch.charCodeAt(0)));
  }

  function buildPushBell() {
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tb-bell';
    btn.title = 'Powiadomienia push na tym urządzeniu';
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true"><path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22zm8-5v-1l-1.7-1.7a2 2 0 0 1-.59-1.41V10a5.71 5.71 0 0 0-4.21-5.5V4a1.5 1.5 0 0 0-3 0v.5A5.71 5.71 0 0 0 6.29 10v2.89a2 2 0 0 1-.59 1.41L4 16v1z"/></svg>';
    const base = window.API_BASE || '';
    // Świadome wyłączenie zapamiętujemy lokalnie — inaczej ciche odtwarzanie
    // (poniżej) włączyłoby powiadomienia z powrotem przy następnym wejściu.
    const OFF_KEY = 'lumlumPushOff';
    const isOff = () => { try { return localStorage.getItem(OFF_KEY) === '1'; } catch (_) { return false; } };
    const setOff = (v) => { try { v ? localStorage.setItem(OFF_KEY, '1') : localStorage.removeItem(OFF_KEY); } catch (_) { /* prywatne okno */ } };

    // Zapis subskrypcji na serwerze. silent=true → serwer NIE wysyła testowego
    // pusha (ciche odtwarzanie przy każdym wejściu nie może spamować testem).
    async function saveSubscription(sub, { silent }) {
      const res = await fetch(`${base}/api/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), silent: Boolean(silent) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Błąd ${res.status}`);
      return body;
    }

    // Utworzenie subskrypcji push na tym urządzeniu (SW + VAPID + zapis).
    async function subscribeDevice(reg, { silent }) {
      const keyBody = await fetch(`${base}/api/push/vapid-key`).then((r) => r.json());
      if (!keyBody.key) throw new Error(keyBody.error || 'Brak klucza VAPID');
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(keyBody.key),
      });
      await saveSubscription(sub, { silent });
      return sub;
    }

    // Ciche odtworzenie subskrypcji przy KAŻDYM wejściu, jeśli pozwolenie już
    // dane i użytkownik świadomie nie wyłączył. iOS potrafi ubić subskrypcję/SW
    // między uruchomieniami PWA (samo pozwolenie zostaje 'granted' na stałe) —
    // bez tego dzwonek „gasł" i trzeba było klikać za każdym razem. Klik jest
    // potrzebny RAZ (zgoda); potem odtwarza się samo, bez testowego pinga.
    async function ensureSubscribed() {
      if (!supported || isOff() || Notification.permission !== 'granted') return false;
      const reg = await navigator.serviceWorker.register('/sw.js');
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await subscribeDevice(reg, { silent: true });
      else await saveSubscription(sub, { silent: true }); // odśwież wiersz/last_used
      return true;
    }

    if (supported) {
      ensureSubscribed()
        .then((on) => btn.classList.toggle('on', Boolean(on)))
        .catch(() => { /* brak sieci/uprawnień — dzwonek zostaje „off" */ });
    }

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!supported) {
        alert('Ta przeglądarka nie obsługuje powiadomień push.\nNa iPhonie: Udostępnij → „Do ekranu początkowego", potem otwórz LumLum z ikony i włącz dzwoneczek tam.');
        return;
      }
      btn.disabled = true;
      try {
        const reg = await navigator.serviceWorker.register('/sw.js');
        const existing = await reg.pushManager.getSubscription();
        if (existing) {
          // Świadome wyłączenie na tym urządzeniu — zapamiętane, żeby ciche
          // odtwarzanie nie włączyło z powrotem przy następnym wejściu.
          setOff(true);
          await existing.unsubscribe();
          await fetch(`${base}/api/push/unsubscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: existing.endpoint }),
          });
          btn.classList.remove('on');
          return;
        }
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') {
          alert('Powiadomienia są zablokowane — włącz je w ustawieniach przeglądarki dla tej strony.');
          return;
        }
        setOff(false);
        // Pierwsze świadome włączenie → testowy push (silent=false), żeby od
        // razu było widać, że działa.
        await subscribeDevice(reg, { silent: false });
        btn.classList.add('on');
      } catch (err) {
        alert(`Nie udało się przełączyć powiadomień: ${err.message}`);
      } finally {
        btn.disabled = false;
      }
    });

    return btn;
  }

  // Pozycje nawigacji w pasku: ekran główny + działające panele. Atrapy
  // ("wkrótce", np. Statystyki) celowo tylko na kafelkach ekranu głównego,
  // żeby pasek nie zamulał się linkami "wkrótce".
  const NAV_ITEMS = [
    { key: 'hub', label: 'Start' },
    { key: 'backlog-b2c', label: 'Backlog B2C' },
    { key: 'crm', label: 'CRM' },
    { key: 'wyceny', label: 'Wyceny' },
    { key: 'sprzedaze', label: 'Sprzedaże' },
    { key: 'fulfillment', label: 'Fulfillment', adminOnly: true },
    { key: 'wiadomosci', label: 'Wiadomości' },
    { key: 'wiedza', label: 'Wiedza' },
    { key: 'doradca', label: 'Doradca', adminOnly: true },
    { key: 'pozwolenia', label: 'Pozwolenia', adminOnly: true },
  ];

  function mount(opts = {}) {
    const user = window.LUMLUM_USER;
    const links = window.LUMLUM_LINKS || {};
    if (!user) return null;

    const bar = opts.into || document.createElement('header');
    bar.classList.add('lumlum-topbar');
    bar.innerHTML = '';

    const home = document.createElement('a');
    home.className = 'tb-home';
    home.href = links.hub || '/';
    home.title = 'Ekran główny';
    const logo = document.createElement('img');
    logo.src = 'assets/lumlum-logo-white.svg';
    logo.alt = 'LumLum';
    // Backlog skaluje logo przy scrollu po tej klasie — nieobecna w innych
    // appkach, nieszkodliwa.
    logo.classList.add('site-logo');
    home.appendChild(logo);

    const nav = document.createElement('nav');
    nav.className = 'tb-nav';
    NAV_ITEMS.forEach((item) => {
      if (item.adminOnly && !user.isAdmin) return;
      if (item.key !== 'hub' && !item.adminOnly && !user.panels.includes(item.key)) return;
      const a = document.createElement('a');
      a.className = 'tb-link' + (opts.active === item.key ? ' active' : '');
      a.href = links[item.key] || '#';
      a.textContent = item.label;
      nav.appendChild(a);
    });

    const userWrap = document.createElement('div');
    userWrap.className = 'tb-user';
    const userBtn = document.createElement('button');
    userBtn.type = 'button';
    userBtn.className = 'tb-user-btn';
    const avatar = document.createElement('span');
    avatar.className = 'tb-avatar';
    avatar.textContent = (user.name || '?').trim().charAt(0).toUpperCase();
    const username = document.createElement('span');
    username.className = 'tb-username';
    username.textContent = user.name || '';
    userBtn.append(avatar, username);

    const menu = document.createElement('div');
    menu.className = 'tb-menu';
    const head = document.createElement('div');
    head.className = 'tb-menu-head';
    head.innerHTML = `<div class="tb-menu-name"></div><div class="tb-menu-email"></div>`;
    head.querySelector('.tb-menu-name').textContent = user.name || '';
    head.querySelector('.tb-menu-email').textContent = user.email || '';
    menu.appendChild(head);

    const homeLink = document.createElement('a');
    homeLink.href = links.hub || '/';
    homeLink.textContent = 'Ekran główny';
    menu.appendChild(homeLink);

    // Zmiana hasła żyje na ekranie głównym (hub ma endpoint /api/me/haslo).
    if (opts.onChangePassword) {
      const pwBtn = document.createElement('button');
      pwBtn.type = 'button';
      pwBtn.textContent = 'Zmień hasło';
      pwBtn.addEventListener('click', () => {
        menu.classList.remove('open');
        opts.onChangePassword();
      });
      menu.appendChild(pwBtn);
    }

    const logoutLink = document.createElement('a');
    logoutLink.href = `${window.API_BASE || ''}/logout`;
    logoutLink.textContent = 'Wyloguj się';
    menu.appendChild(logoutLink);

    userBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('open');
    });
    document.addEventListener('click', () => menu.classList.remove('open'));

    userWrap.append(userBtn, menu);
    bar.append(home, nav, buildPushBell(), userWrap);

    // Otwarcie appki czyści plakietkę na ikonie (nadaną przez push-sw.js).
    if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});

    if (!opts.into) document.body.prepend(bar);
    return bar;
  }

  return { mount };
})();
