// ── Zakładka "Wyceny" w CRM ──────────────────────────────────────────────────
// Arkusz wycen w stylu listy leadów (zwinięte wiersze -> rozwinięta karta).
// Karta = wspólny moduł apps/shared/wycena-card.js (ten sam co w panelu
// Sprzedaże). Dane: apps/shared/server/wyceny-endpoints.js zarejestrowane
// w serwerze CRM (uprawnienia arkusza 'wyceny' z panelu Pozwolenia).
window.WycenyTab = (() => {
  'use strict';

  let cfg = null;
  let loaded = false;
  let all = [];
  let statusy = [];
  let typy = [];
  let ownerFilter = ''; // '' = wszyscy; inaczej dokładna nazwa ownera
  let zrodloFilter = ''; // '' = wszystkie źródła; b2c | wiadomosci | b2b | nieprzypisane

  // Źródło wyceny — "co jest gdzie" (liczone server-side, pole _zrodlo).
  const ZRODLO_LABELS = {
    b2c: 'Lead B2C',
    wiadomosci: 'Wiadomości',
    b2b: 'Lead B2B',
    nieprzypisane: 'Nieprzypisane',
  };

  const STATUS_COLORS = {
    open: '#a8c8f0',
    'waiting for payment': '#f0b23d',
    fulfilled: '#a9d9a0',
    closed: '#cfceca',
    stracone: '#7a1220',
  };

  const TYP_LABELS = { WYCENA: 'Wycena', 'ZAMÓWIENIE': 'Zamówienie', NOTATKA: 'Notatka' };

  function contrastTextColor(hex) {
    const c = hex.replace('#', '');
    const r = parseInt(c.substring(0, 2), 16);
    const g = parseInt(c.substring(2, 4), 16);
    const b = parseInt(c.substring(4, 6), 16);
    return ((0.299 * r + 0.587 * g + 0.114 * b) / 255) > 0.6 ? '#111111' : '#ffffff';
  }

  function applyStatusColor(el, status) {
    const bg = STATUS_COLORS[String(status || '').trim().toLowerCase()];
    if (!bg) { el.style.background = ''; el.style.color = ''; return; }
    el.style.background = bg;
    el.style.color = contrastTextColor(bg);
  }

  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ── Właściciel wyceny (owner) ────────────────────────────────────────────────
  // Deterministyczny odcień koloru per właściciel — ten sam człowiek zawsze ma
  // ten sam kolor kółeczka w całej liście.
  function ownerHue(name) {
    let hash = 0;
    for (const ch of String(name || 'x')) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
    return hash;
  }

  function ownerInitial(name) {
    const n = String(name || '').trim();
    return n ? n.charAt(0).toUpperCase() : '?';
  }

  function ownerBadge(owner) {
    const name = String(owner || '').trim();
    const b = h('span', 'owner-badge', ownerInitial(name));
    b.title = name ? `Właściciel: ${name}` : 'Brak właściciela';
    b.style.setProperty('--owner-hue', String(ownerHue(name)));
    return b;
  }

  // Filtr właściciela = kółeczka A/L (styl jak owner leada). Bez „Wszyscy":
  // klik na kółeczko zawęża do tej osoby, klik na aktywne odznacza (=wszyscy).
  // Pokazuje się dopiero przy >1 właścicielu (Lorenzo i tak widzi tylko swoje).
  function renderOwnerFilter() {
    const wrap = document.getElementById('wyceny-owner-filter');
    if (!wrap) return;
    const owners = [...new Set(all.map((w) => String(w.owner || '').trim()).filter(Boolean))].sort();
    if (ownerFilter && !owners.includes(ownerFilter)) ownerFilter = '';
    wrap.innerHTML = '';
    if (owners.length < 2) return;
    owners.forEach((o) => {
      const active = ownerFilter === o;
      const btn = h('button', 'owner-circle' + (active ? ' active' : ''), ownerInitial(o));
      btn.type = 'button';
      btn.title = active ? `Tylko: ${o} (kliknij, by pokazać wszystkich)` : `Pokaż tylko: ${o}`;
      btn.addEventListener('click', () => {
        ownerFilter = active ? '' : o; // toggle
        renderOwnerFilter();
        renderList();
      });
      wrap.appendChild(btn);
    });
  }

  // ── Toolbar ────────────────────────────────────────────────────────────────
  function buildToolbar() {
    cfg.toolbarEl.classList.add('toolbar');
    cfg.toolbarEl.innerHTML = '';

    const search = document.createElement('input');
    search.type = 'text';
    search.id = 'wyceny-search';
    search.placeholder = 'Szukaj: imię, telefon, e-mail albo numer…';
    search.addEventListener('input', renderList);

    const statusSel = document.createElement('select');
    statusSel.id = 'wyceny-status-filter';
    statusSel.addEventListener('change', renderList);

    const typSel = document.createElement('select');
    typSel.id = 'wyceny-typ-filter';
    typSel.addEventListener('change', renderList);

    // Filtr źródła — "co jest gdzie". B2B na razie placeholder (wkrótce).
    const zrodloSel = document.createElement('select');
    zrodloSel.id = 'wyceny-zrodlo-filter';
    [['', 'Wszystkie źródła'], ['b2c', 'Lead B2C'], ['wiadomosci', 'Wiadomości'],
     ['b2b', 'Lead B2B (wkrótce)'], ['nieprzypisane', 'Nieprzypisane']].forEach(([val, label]) => {
      const o = h('option', '', label);
      o.value = val;
      zrodloSel.appendChild(o);
    });
    zrodloSel.addEventListener('change', () => { zrodloFilter = zrodloSel.value; renderList(); });

    const ownerFilterWrap = h('div', 'owner-filter');
    ownerFilterWrap.id = 'wyceny-owner-filter';

    const refresh = h('button', '', 'Odśwież');
    refresh.type = 'button';
    refresh.addEventListener('click', () => load());

    const count = h('span', 'count-badge');
    count.id = 'wyceny-count';

    cfg.toolbarEl.append(search, statusSel, typSel, zrodloSel, ownerFilterWrap, refresh, count);

    // Szybkie dodanie (tekst -> AI -> podgląd) + pełny edytor — moduł
    // wycena-editor.js; bez niego przycisków nie ma (podgląd / stary deploy).
    if (!cfg.readOnly && window.WycenaEditor) {
      const quick = h('button', '', '⚡ Szybka wycena');
      quick.type = 'button';
      quick.style.fontWeight = '700';
      quick.addEventListener('click', () => window.WycenaEditor.openQuickAdd({
        apiBase: cfg.apiBase,
        onSaved: () => load(),
      }));
      const add = h('button', '', '+ Nowa wycena');
      add.type = 'button';
      add.addEventListener('click', () => window.WycenaEditor.openNew({
        apiBase: cfg.apiBase,
        onSaved: () => load(),
      }));
      cfg.toolbarEl.insertBefore(quick, count);
      cfg.toolbarEl.insertBefore(add, count);
    }
  }

  function fillFilters() {
    const statusSel = document.getElementById('wyceny-status-filter');
    const typSel = document.getElementById('wyceny-typ-filter');
    statusSel.innerHTML = '';
    typSel.innerHTML = '';
    const optAllS = h('option', '', 'Wszystkie statusy');
    optAllS.value = '';
    statusSel.appendChild(optAllS);
    statusy.forEach((s) => {
      const o = h('option', '', s);
      o.value = s;
      statusSel.appendChild(o);
    });
    const optAllT = h('option', '', 'Wszystkie typy');
    optAllT.value = '';
    typSel.appendChild(optAllT);
    typy.forEach((t) => {
      const o = h('option', '', TYP_LABELS[t] || t);
      o.value = t;
      typSel.appendChild(o);
    });
  }

  // ── Wiersz listy ───────────────────────────────────────────────────────────
  function buildStatusPill(wycena) {
    const wrap = h('div', 'status-wrap');
    const tag = h('span', 'status-tag', wycena.status || '—');
    applyStatusColor(tag, wycena.status);

    const menu = h('div', 'status-menu');
    statusy.forEach((status) => {
      const option = h('button', 'status-option', status);
      option.type = 'button';
      option.addEventListener('click', async (e) => {
        e.stopPropagation();
        menu.classList.remove('open');
        wrap.closest('.lead').classList.remove('status-menu-open');
        const prev = tag.textContent;
        tag.textContent = status;
        applyStatusColor(tag, status);
        try {
          const res = await fetch(`${cfg.apiBase}/api/wyceny/${wycena.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || `Błąd ${res.status}`);
          wycena.status = status;
        } catch (err) {
          tag.textContent = prev;
          applyStatusColor(tag, prev);
          alert(`Błąd zapisu statusu: ${err.message}`);
        }
      });
      menu.appendChild(option);
    });

    tag.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (cfg.readOnly) return;
      const isOpen = menu.classList.toggle('open');
      wrap.closest('.lead').classList.toggle('status-menu-open', isOpen);
    });

    wrap.append(tag, menu);
    return wrap;
  }

  function moneyShort(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '';
    return `${n.toLocaleString('pl-PL', { maximumFractionDigits: 0 })} zł`;
  }

  // Data bez godziny (DD.MM.RRRR) — do zwiniętego wiersza.
  function dateShort(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
  }

  // "Data wyceny" = created_at (Data stworzenia z arkusza). Data złożenia
  // zamówienia celowo NIE tu — w sekcji Wyceny nie ma sensu (jest w Sprzedażach).
  function buildDates(wycena) {
    const wrap = h('div', 'wyceny-dates');
    const wyc = dateShort(wycena.created_at);
    if (wyc) {
      const s = h('span', 'wyceny-date', `Wycena: ${wyc}`);
      s.title = 'Data wyceny';
      wrap.appendChild(s);
    }
    return wrap;
  }

  function wycenaRow(wycena) {
    const details = h('details', 'lead');
    details.dataset.wycenaId = String(wycena.id);

    const summary = document.createElement('summary');
    const chevron = h('span', 'chevron');
    const lp = h('span', 'lp', `#${wycena.id}`);

    const typChip = h('span', 'wk-chip' + (wycena.typ === 'ZAMÓWIENIE' ? ' info' : ''), TYP_LABELS[wycena.typ] || wycena.typ);

    const zrodlo = wycena._zrodlo || 'nieprzypisane';
    const zrodloChip = h('span', `wk-chip zrodlo-chip zrodlo-${zrodlo}`, ZRODLO_LABELS[zrodlo] || zrodlo);

    const nameText = (wycena.imie_nazwisko
      || [wycena.first_name, wycena.last_name].filter(Boolean).join(' ')
      || '').trim();

    const phoneText = wycena.telefon_e164
      ? (String(wycena.telefon_e164).startsWith('+') ? wycena.telefon_e164 : `+${wycena.telefon_e164}`)
      : '';
    const phone = h('span', 'summary-phone', phoneText);

    const rightAnchor = h('div', 'right-anchor');
    const kwota = h('span', 'summary-feedback', moneyShort(wycena.kwota_proponowana_brutto));
    kwota.style.fontWeight = '700';
    kwota.style.color = 'var(--text-primary)';
    const stage = WycenaKarta.utils.stageChip(wycena.process_stage);
    rightAnchor.append(ownerBadge(wycena.owner), kwota, stage, buildStatusPill(wycena));

    summary.append(chevron, lp, typChip, zrodloChip);
    if (nameText) {
      summary.append(h('span', 'summary-name', nameText), h('span', 'summary-dash', '—'));
    }
    summary.append(phone, buildDates(wycena), rightAnchor);
    details.appendChild(summary);

    let bodyBuilt = false;
    details.addEventListener('toggle', () => {
      if (!details.open || bodyBuilt) return;
      bodyBuilt = true;
      const { el } = WycenaKarta.buildBody(wycena, {
        apiBase: cfg.apiBase,
        readOnly: cfg.readOnly,
        mode: 'crm',
        onChanged: () => load({ keepOpen: true }),
        onEdit: window.WycenaEditor && !cfg.readOnly
          ? (w) => window.WycenaEditor.openEdit(w, { apiBase: cfg.apiBase, onSaved: () => load({ keepOpen: true }) })
          : null,
      });
      details.appendChild(el);
    });

    return details;
  }

  // ── Lista + filtry ─────────────────────────────────────────────────────────
  function matches(wycena) {
    const q = (document.getElementById('wyceny-search')?.value || '').trim().toLowerCase();
    const status = document.getElementById('wyceny-status-filter')?.value || '';
    const typ = document.getElementById('wyceny-typ-filter')?.value || '';
    if (status && wycena.status !== status) return false;
    if (typ && wycena.typ !== typ) return false;
    if (zrodloFilter && (wycena._zrodlo || 'nieprzypisane') !== zrodloFilter) return false;
    if (ownerFilter && String(wycena.owner || '').trim() !== ownerFilter) return false;
    if (!q) return true;
    const hay = `#${wycena.id} ${wycena.id} ${wycena.imie_nazwisko || ''} ${wycena.first_name || ''} ${wycena.last_name || ''} ${wycena.telefon_e164 || ''} ${wycena.telefon_digits || ''} ${wycena.email || ''}`.toLowerCase();
    return hay.includes(q);
  }

  function renderList() {
    const openIds = new Set([...cfg.listEl.querySelectorAll('details[open]')].map((d) => d.dataset.wycenaId));
    const filtered = all.filter(matches);
    cfg.listEl.innerHTML = '';
    filtered.forEach((w) => {
      const row = wycenaRow(w);
      if (openIds.has(String(w.id))) row.open = true;
      cfg.listEl.appendChild(row);
    });
    const count = document.getElementById('wyceny-count');
    if (count) count.textContent = `${filtered.length} / ${all.length} wycen`;
    if (!filtered.length) cfg.listEl.innerHTML = '<p class="empty-note">Brak wycen dla tych filtrów.</p>';
  }

  async function load() {
    // Przy odświeżeniu po akcji (zapis, link) NIE czyścimy listy przed
    // fetchem — renderList podmienia wiersze zachowując rozwinięte karty.
    if (!loaded) cfg.listEl.innerHTML = '<p class="empty-note">Wczytywanie…</p>';
    try {
      // Zakładka Wyceny B2C = tylko wyceny/notatki. Sprzedaże (typ
      // ZAMÓWIENIE) mają własny panel Sprzedaże — tu ich nie ma.
      const res = await fetch(`${cfg.apiBase}/api/wyceny?bez_typ=${encodeURIComponent('ZAMÓWIENIE')}`);
      if (res.status === 401) { window.location.href = `${cfg.apiBase}/login`; return; }
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Błąd wczytywania');
      all = body.data || [];
      statusy = body.statusy || [];
      typy = body.typy || [];
      fillFilters();
      renderOwnerFilter();
      renderList();
      loaded = true;
    } catch (err) {
      cfg.listEl.innerHTML = `<p class="empty-note">Błąd wczytywania: ${err.message}</p>`;
    }
  }

  function init(options) {
    cfg = options;
    buildToolbar();
  }

  function ensureLoaded() {
    if (!loaded) load();
  }

  return { init, ensureLoaded, reload: () => load() };
})();
