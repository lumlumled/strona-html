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

  // Pozycje nawigacji w pasku: ekran główny + działające panele. Atrapy
  // (Wyceny/Wiadomości/Statystyki) celowo tylko na kafelkach ekranu głównego,
  // żeby pasek nie zamulał się linkami "wkrótce".
  const NAV_ITEMS = [
    { key: 'hub', label: 'Start' },
    { key: 'backlog-b2c', label: 'Backlog B2C' },
    { key: 'crm', label: 'CRM' },
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
    bar.append(home, nav, userWrap);

    if (!opts.into) document.body.prepend(bar);
    return bar;
  }

  return { mount };
})();
