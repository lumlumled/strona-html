// ── Edytor wyceny + Szybkie dodanie (zakładka Wyceny w CRM) ──────────────────
// Dwa modale:
//   WycenaEditor.openQuickAdd — pole tekstowe (odpowiednik wiadomości w
//     Telegramie) -> POST /api/wyceny/parsuj (GPT, prompt 1:1 z Make) ->
//     PODGLĄD sparsowanej wyceny do zatwierdzenia -> zapis (nowa / podmiana
//     istniejącej po telefonie/mailu).
//   WycenaEditor.openNew / openEdit — pełny, strukturalny edytor "żyjącej"
//     wyceny: pozycje z cennika SKU (ze zdjęciami), ilości, ceny, kwota dla
//     klienta (rabat wyliczany na żywo), rabat 24h, kontakt.
// Style: apps/shared/wycena-card.css (sekcja "Modal edytora").
window.WycenaEditor = (() => {
  'use strict';

  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function money(v) {
    const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }

  function moneyPLN(v) {
    return `${money(v).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;
  }

  let cennikCache = null;
  async function fetchCennik(apiBase) {
    if (cennikCache) return cennikCache;
    const res = await fetch(`${apiBase}/api/wyceny/cennik`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Błąd ${res.status}`);
    cennikCache = body.data || [];
    return cennikCache;
  }

  // ── Katalog: model z cennika (kategorie + taśmy parametryczne) ───────────────
  const BARWA_ORDER = ['3000K', '4000K', '6000K', 'CCT', 'RGBCCT'];
  const BARWA_LABELS = {
    '3000K': '3000K · ciepła', '4000K': '4000K · neutralna', '6000K': '6000K · zimna',
    CCT: 'CCT · biel regulowana', RGBCCT: 'RGB+CCT · kolory',
  };
  const IP_LABELS = { IP20: 'IP20 · wewnątrz', IP65: 'IP65 · wodoodporna', IP67: 'IP67 · wodoodporna' };

  // Kategorie "Dodaj produkt". Taśmy są parametryczne (barwa + IP); reszta to
  // proste listy dopasowane po prefiksie SKU.
  // Kolejność wg Antoniego. Kafelki mają ZDJĘCIA (reprezentatywny produkt), nie
  // emoji. Panele biurkowy/ścienny to PILOTY (LL-PANEL → remote). Profile i
  // Pozostałe to placeholdery ("wkrótce") — na przyszłość.
  const CATEGORIES = [
    { key: 'dig', label: 'Cyfrowa taśma', tape: 'DIG' },
    { key: 'ana', label: 'Analogowa taśma', tape: 'ANA' },
    { key: 'ctrl', label: 'Sterowniki', prefixes: ['LL-CTRL'] },
    { key: 'remote', label: 'Piloty', prefixes: ['LL-REMOTE', 'LL-PANEL'] },
    { key: 'sensor', label: 'Czujniki', prefixes: ['LL-SENSOR'] },
    { key: 'acc', label: 'Akcesoria', prefixes: ['LL-ACC'] },
    { key: 'psu', label: 'Zasilacze', prefixes: ['LL-PSU'] },
    { key: 'profile', label: 'Profile', placeholder: true },
    { key: 'pozostale', label: 'Pozostałe', placeholder: true },
  ];

  // Reprezentatywne zdjęcie kategorii (pierwszy produkt ze zdjęciem).
  function categoryImage(catalog, c) {
    if (c.tape) { const t = (catalog.tapes[c.tape] || []).find((x) => x.image); return t ? t.image : ''; }
    const s = (catalog.simple[c.key] || []).find((x) => x.image_url); return s ? s.image_url : '';
  }
  const TAPE_LABEL = { DIG: 'Cyfrowa taśma', ANA: 'Analogowa taśma' };

  function parseTapeSku(sku) {
    const m = /^LL-TAPE-(DIG|ANA)-COB-(.+)-(IP\d+)$/.exec(String(sku || ''));
    return m ? { family: m[1], barwa: m[2], ip: m[3] } : null;
  }

  function buildCatalogModel(cennik) {
    const tapes = { DIG: [], ANA: [] };
    const simple = {};
    (cennik || []).forEach((s) => {
      const t = parseTapeSku(s.sku);
      if (t && tapes[t.family]) {
        tapes[t.family].push({ ...t, sku: s.sku, price: s.price_brutto, image: s.image_url || '', nazwa: s.nazwa, unit: s.unit || 'm' });
      } else {
        const cat = CATEGORIES.find((c) => c.prefixes && c.prefixes.some((p) => String(s.sku || '').startsWith(p)));
        const key = cat ? cat.key : 'acc';
        (simple[key] = simple[key] || []).push(s);
      }
    });
    return { tapes, simple };
  }

  // Konfigurator taśmy: selektor barwa + IP + metry; zdjęcie/cena/nazwa wg
  // wybranego wariantu. Domyślnie 4000K / IP20. Używany przy dodawaniu i edycji.
  function buildTapeConfigurator(family, catalog, initial, onChange) {
    const list = (catalog.tapes[family] || []);
    const wrap = h('div', 'wk-tape-cfg');
    const barwy = BARWA_ORDER.filter((b) => list.some((t) => t.barwa === b));
    const allIps = [...new Set(list.map((t) => t.ip))].sort();
    const ipsFor = (b) => allIps.filter((i) => list.some((t) => t.barwa === b && t.ip === i));

    let barwa = (initial && initial.barwa && barwy.includes(initial.barwa)) ? initial.barwa
      : (barwy.includes('4000K') ? '4000K' : barwy[0]);
    let ip;
    (function pickIp() {
      const avail = ipsFor(barwa);
      ip = (initial && initial.ip && avail.includes(initial.ip)) ? initial.ip
        : (avail.includes('IP20') ? 'IP20' : avail[0]);
    })();
    let qty = (initial && initial.quantity != null && initial.quantity !== '') ? String(initial.quantity) : '';

    const resolve = () => list.find((t) => t.barwa === barwa && t.ip === ip) || null;
    // Pierwsze update() NIE woła onChange: caller robi `const cfg = buildTape...(
    // () => cfg.getItem())`, więc onChange sięgnąłby po cfg jeszcze przed jego
    // przypisaniem (TDZ) — to psuło budowę pozycji z taśmą.
    let started = false;

    // Kompaktowo — wszystko w JEDNEJ linii: [zdjęcie] Cyfrowa taśma COB
    // [3000K][4000K][6000K] [IP20][IP65] [metry m] cena. Krótkie etykiety.
    const shortBarwa = (b) => (b === 'RGBCCT' ? 'RGB+CCT' : b);
    const thumb = h('span', 'wk-tape-thumb');
    const fam = h('span', 'wk-tape-fam', family === 'DIG' ? 'Cyfrowa taśma COB' : 'Analogowa taśma COB');
    const barwaRow = h('span', 'wk-tape-opts');
    const ipRow = h('span', 'wk-tape-opts');
    const qtyInput = input(qty, 'metry');
    qtyInput.inputMode = 'decimal';
    qtyInput.className = 'wk-tape-metry';
    const qtyWrap = h('span', 'wk-tape-qty'); qtyWrap.append(qtyInput, h('span', 'wk-tape-unit', 'm'));
    qtyInput.addEventListener('input', () => { qty = qtyInput.value; onChange(); });
    const priceEl = h('span', 'wk-tape-price');

    function renderThumb(t) {
      thumb.innerHTML = '';
      if (t && t.image) {
        const img = document.createElement('img'); img.src = t.image; img.alt = '';
        img.addEventListener('error', () => { thumb.innerHTML = ''; thumb.appendChild(h('span', 'wk-thumb-placeholder', '')); });
        thumb.appendChild(img);
      } else thumb.appendChild(h('span', 'wk-thumb-placeholder', ''));
    }
    function renderOpts() {
      barwaRow.innerHTML = '';
      barwy.forEach((b) => {
        const btn = h('button', 'wk-opt-btn' + (b === barwa ? ' active' : ''), shortBarwa(b));
        btn.type = 'button';
        btn.addEventListener('click', () => {
          barwa = b;
          if (!ipsFor(barwa).includes(ip)) { const a = ipsFor(barwa); ip = a.includes('IP20') ? 'IP20' : a[0]; }
          update();
        });
        barwaRow.appendChild(btn);
      });
      ipRow.innerHTML = '';
      ipsFor(barwa).forEach((i) => {
        const btn = h('button', 'wk-opt-btn' + (i === ip ? ' active' : ''), i);
        btn.type = 'button';
        btn.addEventListener('click', () => { ip = i; update(); });
        ipRow.appendChild(btn);
      });
    }
    function update() {
      renderOpts();
      const t = resolve();
      renderThumb(t);
      priceEl.textContent = t ? `${moneyPLN(t.price)}/m` : '';
      if (started) onChange();
    }
    update();
    started = true;
    wrap.append(thumb, fam, barwaRow, ipRow, qtyWrap, priceEl);

    return {
      el: wrap,
      getItem: () => {
        const t = resolve();
        if (!t) return null;
        return { name: t.nazwa, SKU: t.sku, quantity: money(qty) || 1, unit: t.unit || 'm', price: String(t.price ?? ''), VAT: '23', image_url: t.image || '' };
      },
    };
  }

  // Picker: najpierw kategoria; taśmy → konfigurator (barwa/IP/metry), reszta →
  // siatka zdjęć (klik = dodaj). onPick dostaje gotową pozycję do wyceny.
  function openCatalogPicker({ catalog, onPick }) {
    const { modal, destroy } = openModal('Dodaj produkt');
    const body = h('div', 'wk-catalog-body');
    modal.appendChild(body);
    const actions = h('div', 'wk-modal-actions');
    const back = h('button', 'wk-btn', '‹ Kategorie');
    back.type = 'button';
    back.style.visibility = 'hidden';
    const done = h('button', 'wk-btn primary', 'Gotowe');
    done.type = 'button'; done.addEventListener('click', destroy);
    actions.append(back, done);
    modal.appendChild(actions);

    function showCategories() {
      back.style.visibility = 'hidden';
      body.innerHTML = '';
      const grid = h('div', 'wk-cat-grid');
      CATEGORIES.forEach((c) => {
        if (c.placeholder) {
          const card = h('div', 'wk-cat-btn placeholder');
          const th = h('span', 'wk-cat-thumb'); th.appendChild(h('span', 'wk-cat-soon', 'wkrótce'));
          card.append(th, h('span', 'wk-cat-lbl', c.label));
          grid.appendChild(card);
          return;
        }
        const has = c.tape ? (catalog.tapes[c.tape] || []).length : (catalog.simple[c.key] || []).length;
        if (!has) return;
        const btn = h('button', 'wk-cat-btn');
        btn.type = 'button';
        const th = h('span', 'wk-cat-thumb');
        const img = categoryImage(catalog, c);
        if (img) {
          const im = document.createElement('img'); im.loading = 'lazy'; im.src = img; im.alt = '';
          im.addEventListener('error', () => { th.innerHTML = ''; });
          th.appendChild(im);
        }
        btn.append(th, h('span', 'wk-cat-lbl', c.label));
        btn.addEventListener('click', () => openCategory(c));
        grid.appendChild(btn);
      });
      body.appendChild(grid);
    }

    function openCategory(c) {
      back.style.visibility = 'visible';
      body.innerHTML = '';
      body.appendChild(h('div', 'wk-section-title', c.label));
      if (c.tape) {
        const cfg = buildTapeConfigurator(c.tape, catalog, {}, () => {});
        body.appendChild(cfg.el);
        const add = h('button', 'wk-btn primary', '+ Dodaj taśmę');
        add.type = 'button';
        add.style.marginTop = '0.7rem';
        add.addEventListener('click', () => {
          const it = cfg.getItem();
          if (it) { onPick(it); add.textContent = '✓ Dodano — dodaj kolejną'; setTimeout(() => { add.textContent = '+ Dodaj taśmę'; }, 1300); }
        });
        body.appendChild(add);
      } else {
        const grid = h('div', 'wk-catalog-grid');
        (catalog.simple[c.key] || []).forEach((s) => {
          const card = h('button', 'wk-catalog-card');
          card.type = 'button';
          const thumbSlot = h('div', 'wk-catalog-thumb');
          if (s.image_url) {
            const img = document.createElement('img'); img.loading = 'lazy'; img.src = s.image_url; img.alt = '';
            img.addEventListener('error', () => { thumbSlot.innerHTML = ''; thumbSlot.appendChild(h('div', 'wk-thumb-placeholder', '💡')); });
            thumbSlot.appendChild(img);
          } else thumbSlot.appendChild(h('div', 'wk-thumb-placeholder', '💡'));
          card.appendChild(thumbSlot);
          card.appendChild(h('div', 'wk-catalog-name', s.nazwa));
          if (s.price_brutto != null && s.price_brutto !== '') card.appendChild(h('div', 'wk-catalog-price', `${moneyPLN(s.price_brutto)}/${s.unit || 'szt'}`));
          card.addEventListener('click', () => {
            onPick({ name: s.nazwa, SKU: s.sku, quantity: 1, unit: s.unit || 'szt', price: String(s.price_brutto ?? ''), VAT: String(s.vat || 23), image_url: s.image_url || '' });
            card.classList.add('dodano');
            if (!card.querySelector('.wk-catalog-added')) card.appendChild(h('div', 'wk-catalog-added', '✓ dodano'));
          });
          grid.appendChild(card);
        });
        body.appendChild(grid);
      }
    }

    back.addEventListener('click', showCategories);
    showCategories();
  }

  function openModal(titleText) {
    const backdrop = h('div', 'wk-modal-backdrop');
    const modal = h('div', 'wk-modal');
    const head = h('div', 'wk-modal-head');
    head.appendChild(h('h3', '', titleText));
    const close = h('button', 'wk-modal-close', '✕');
    close.type = 'button';
    head.appendChild(close);
    modal.appendChild(head);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const destroy = () => backdrop.remove();
    close.addEventListener('click', destroy);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) destroy(); });
    return { backdrop, modal, destroy };
  }

  function field(labelText, inputEl) {
    const wrap = h('div', 'wk-field');
    const label = h('label', '', labelText);
    wrap.append(label, inputEl);
    return wrap;
  }

  function input(value, placeholder, type = 'text') {
    const el = document.createElement('input');
    el.type = type;
    el.value = value ?? '';
    if (placeholder) el.placeholder = placeholder;
    return el;
  }

  // ── Pełny edytor ───────────────────────────────────────────────────────────

  // Edytor pozycji — bez ręcznej edycji nazwy/ceny/SKU/linku. Produkt wybiera
  // się z katalogu; edytujesz TYLKO ilość, a taśmy dodatkowo przez parametry
  // (barwa + IP → podmiana wariantu). Nieznane pozycje (spoza katalogu) zostają
  // widoczne read-only z możliwością zmiany ilości i usunięcia.
  function buildItemsEditor(items, catalog, onChange) {
    const wrap = h('div', 'wk-edit-items');
    const state = { items: (items || []).map((p) => ({ ...p })) };
    // Pierwszy render NIE woła onChange (refreshTotals sięga po itemsEd/sumaVal
    // jeszcze nieistniejące — TDZ). Caller woła refreshTotals() jawnie później.
    let ready = false;

    function render() {
      wrap.innerHTML = '';
      state.items.forEach((p, idx) => {
        const box = h('div', 'wk-edit-item-box');
        const remove = h('button', 'wk-edit-item-remove', '✕');
        remove.type = 'button';
        remove.title = 'Usuń pozycję';
        remove.addEventListener('click', () => { state.items.splice(idx, 1); render(); if (ready) onChange(); });

        const tape = parseTapeSku(p.SKU);
        if (tape && (catalog.tapes[tape.family] || []).length) {
          // Taśma parametryczna w jednej linii; ✕ na końcu wiersza.
          const cfg = buildTapeConfigurator(tape.family, catalog, { barwa: tape.barwa, ip: tape.ip, quantity: p.quantity }, () => {
            const it = cfg.getItem();
            if (it) Object.assign(p, it);
            if (ready) onChange();
          });
          // Sync raz, jawnie (konfigurator celowo nie woła onChange w init).
          const it0 = cfg.getItem();
          if (it0) Object.assign(p, it0);
          cfg.el.appendChild(remove);
          box.appendChild(cfg.el);
        } else {
          // Prosta pozycja — zdjęcie + nazwa (read-only) + ilość.
          const row = h('div', 'wk-edit-item');
          const thumbSlot = h('div', 'wk-edit-thumb-slot');
          if (p.image_url) {
            const img = document.createElement('img');
            img.className = 'wk-thumb'; img.style.width = '42px'; img.style.height = '42px';
            img.src = p.image_url; img.alt = '';
            img.addEventListener('error', () => { thumbSlot.innerHTML = ''; thumbSlot.appendChild(h('div', 'wk-thumb-placeholder', '💡')); });
            thumbSlot.appendChild(img);
          } else {
            thumbSlot.appendChild(h('div', 'wk-thumb-placeholder', '💡'));
          }
          const nameEl = h('div', 'wk-edit-item-name', p.name || 'Produkt');
          const qty = input(p.quantity ?? 1, 'ilość');
          qty.inputMode = 'decimal';
          qty.className = 'wk-edit-qty';
          qty.addEventListener('input', () => { p.quantity = qty.value; if (ready) onChange(); });
          const unit = h('span', 'wk-edit-item-unit', p.unit || 'szt');
          row.append(thumbSlot, nameEl, qty, unit, remove);
          box.appendChild(row);
        }
        wrap.appendChild(box);
      });
      if (!state.items.length) wrap.appendChild(h('div', 'wk-quick-hint', 'Brak pozycji — dodaj produkt poniżej.'));
    }

    render();
    ready = true;
    return {
      el: wrap,
      getItems: () => state.items
        .filter((p) => String(p.name || '').trim())
        .map((p) => ({
          name: String(p.name).trim(),
          SKU: p.SKU || '',
          quantity: money(p.quantity) || 1,
          unit: p.unit || 'szt',
          price: String(money(p.price)),
          VAT: String(p.VAT || '23'),
          image_url: p.image_url || '',
        })),
      addItem: (p) => { state.items.push({ ...p }); render(); if (ready) onChange(); },
      suma: () => state.items.reduce((a, p) => a + money(p.price) * (money(p.quantity) || 0), 0),
    };
  }

  function openEditor({ apiBase, onSaved, wycena = null, prefill = null }) {
    const isNew = !wycena;
    const { modal, destroy } = openModal(isNew ? 'Nowa wycena' : `Edycja wyceny #${wycena.id}`);
    const src = wycena || prefill || {};

    // Kontakt
    const imie = input(src.imie_nazwisko, 'Imię i nazwisko');
    const telefon = input(src.telefon_e164, 'np. 48513141389');
    const email = input(src.email, 'adres@klienta.pl');
    // Komentarz do wyceny — pokazuje się przy realizacji (rzeczy POZA wyceną,
    // np. "dodać 1 czujnik więcej" albo "wysłać w czwartek"). Typ celowo
    // usunięty: dopóki nie zrealizowana, to wycena.
    const komentarz = document.createElement('textarea');
    komentarz.className = 'wk-quick-textarea';
    komentarz.rows = 2;
    komentarz.style.minHeight = '3.2rem';
    komentarz.placeholder = 'np. dodać 1 czujnik więcej poza wyceną albo wysłać w czwartek…';
    komentarz.value = src.komentarz || '';

    const grid = h('div', 'wk-form-grid');
    grid.append(
      field('Imię i nazwisko', imie),
      field('Telefon', telefon),
      field('E-mail', email),
    );
    const komWrap = field('Komentarz (widoczny przy realizacji)', komentarz);
    komWrap.style.gridColumn = '1 / -1';
    grid.appendChild(komWrap);
    modal.appendChild(grid);

    // Powiązany lead (B2C) — spina wycenę z leadem (zapis lead_id). Szukanie po
    // telefonie, e-mailu albo nazwie w "Leady B2C". Steruje też kategorią źródła.
    let leadId = (src.lead_id != null ? String(src.lead_id) : '')
      || (prefill && prefill.lead_id != null ? String(prefill.lead_id) : '');
    const leadStatus = h('div', 'wk-lead-status');
    const leadSearch = input('', 'Szukaj leada: telefon, e-mail albo nazwa…');
    const leadResults = h('div', 'wk-lead-results');
    leadResults.hidden = true;

    function renderLeadStatus() {
      leadStatus.innerHTML = '';
      if (leadId) {
        leadStatus.appendChild(h('span', 'wk-lead-chip', `🔗 Powiązany lead #${leadId}`));
        const un = h('button', 'wk-btn wk-btn--slim', 'Odepnij');
        un.type = 'button';
        un.addEventListener('click', () => { leadId = ''; renderLeadStatus(); });
        leadStatus.appendChild(un);
      } else {
        leadStatus.appendChild(h('span', 'wk-muted-note', 'Brak powiązanego leada.'));
      }
    }

    let leadSearchTimer = null;
    leadSearch.addEventListener('input', () => {
      clearTimeout(leadSearchTimer);
      const q = leadSearch.value.trim();
      if (q.length < 2) { leadResults.hidden = true; leadResults.innerHTML = ''; return; }
      leadSearchTimer = setTimeout(async () => {
        try {
          const res = await fetch(`${apiBase}/api/wyceny/szukaj-leada?q=${encodeURIComponent(q)}`);
          const body = await res.json().catch(() => ({}));
          const list = body.data || [];
          leadResults.innerHTML = '';
          if (!list.length) { leadResults.hidden = false; leadResults.appendChild(h('div', 'wk-lead-empty', 'Brak dopasowań.')); return; }
          list.forEach((l) => {
            const opt = h('button', 'wk-lead-opt');
            opt.type = 'button';
            opt.textContent = `#${l.id} · ${l.name || '—'}${l.phone ? ` · ${l.phone}` : ''}${l.email ? ` · ${l.email}` : ''}`;
            opt.addEventListener('click', () => { leadId = String(l.id); leadResults.hidden = true; leadSearch.value = ''; renderLeadStatus(); });
            leadResults.appendChild(opt);
          });
          leadResults.hidden = false;
        } catch (_) { /* wyszukiwarka to wygoda — cisza przy błędzie */ }
      }, 250);
    });
    renderLeadStatus();

    const leadSection = h('div');
    leadSection.appendChild(h('div', 'wk-section-title', 'Powiązany lead (B2C)'));
    leadSection.append(leadStatus, leadSearch, leadResults);
    modal.appendChild(leadSection);

    // Feedback (watchdog, docs/plan-watchdog-feedback.md) — jawny termin
    // "kiedy wrócić do klienta". Pusta data przy zapisie kasuje termin; cichy
    // termin AI (visible=false) pokazujemy informacyjnie z możliwością
    // wyciszenia. Zapis idzie jako body.feedback_due ("YYYY-MM-DD" | "").
    const watch = src._watch || null;
    const warsawDay = (iso) => new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(iso)); // YYYY-MM-DD
    const plDay = (iso) => new Intl.DateTimeFormat('pl-PL', {
      timeZone: 'Europe/Warsaw', day: '2-digit', month: '2-digit', year: 'numeric',
    }).format(new Date(iso));
    const initialFeedback = watch && watch.visible ? warsawDay(watch.due_at) : '';
    const feedbackInput = input(initialFeedback, '', 'date');
    let watchMuted = false;
    const fbSection = h('div');
    fbSection.appendChild(h('div', 'wk-section-title', 'Feedback — kiedy wrócić do klienta'));
    const fbGrid = h('div', 'wk-form-grid');
    fbGrid.appendChild(field('Termin feedbacku (puste = brak)', feedbackInput));
    fbSection.appendChild(fbGrid);
    if (watch && !watch.visible) {
      const silentRow = h('div', 'wk-lead-status');
      const silentNote = h('span', 'wk-muted-note',
        `🤖 Cichy watchdog AI pilnuje do ${plDay(watch.due_at)}${watch.reason ? ` (${watch.reason})` : ''}`);
      const muteBtn = h('button', 'wk-btn wk-btn--slim', 'Wyłącz watchdoga');
      muteBtn.type = 'button';
      muteBtn.addEventListener('click', () => {
        watchMuted = true;
        silentNote.textContent = 'Watchdog zostanie wyłączony po zapisie.';
        muteBtn.remove();
      });
      silentRow.append(silentNote, muteBtn);
      fbSection.appendChild(silentRow);
    }
    modal.appendChild(fbSection);

    // Pozycje/kwoty/akcje budujemy PO wczytaniu cennika (potrzebny do
    // parametrycznych taśm i pickera). fetchCennik jest cache'owany, więc po
    // pierwszym otwarciu edytora jest to natychmiastowe.
    const loadingEl = h('div', 'wk-quick-hint', 'Wczytywanie cennika…');
    modal.appendChild(loadingEl);

    fetchCennik(apiBase).then((cennik) => {
      const catalog = buildCatalogModel(cennik);
      loadingEl.remove();

      modal.appendChild(h('div', 'wk-section-title', 'Pozycje'));
      let kwotaTouched = Boolean(!isNew || (prefill && prefill.kwota_proponowana_brutto != null));
      const itemsEd = buildItemsEditor(src.items || [], catalog, () => refreshTotals());
      modal.appendChild(itemsEd.el);

      // Dodawanie pozycji — kategorie + parametryczne taśmy (openCatalogPicker).
      const addbar = h('div', 'wk-edit-addbar');
      const catalogBtn = h('button', 'wk-btn primary', '+ Dodaj produkt');
      catalogBtn.type = 'button';
      catalogBtn.addEventListener('click', () => openCatalogPicker({ catalog, onPick: (it) => itemsEd.addItem(it) }));
      addbar.append(catalogBtn);
      modal.appendChild(addbar);

      // Kwoty: suma pozycji + kwota dla klienta (rabat = różnica, na żywo)
      const summary = h('div', 'wk-edit-summary');
      const sumaRow = h('div', 'row');
      const sumaVal = h('span');
      sumaRow.append(h('span', '', 'Suma pozycji'), sumaVal);
      const rabatRow = h('div', 'row');
      const rabatVal = h('span');
      rabatVal.style.fontWeight = '600';
      rabatRow.append(h('span', '', 'Rabat (kwota − suma pozycji)'), rabatVal);
      const kwotaRow = h('div', 'row');
      const kwotaInput = input(src.kwota_proponowana_brutto ?? '', '0,00');
      kwotaInput.inputMode = 'decimal';
      kwotaInput.addEventListener('input', () => { kwotaTouched = true; refreshTotals(); });
      kwotaRow.append(h('span', '', 'Do zapłaty (kwota dla klienta)'), kwotaInput);
      summary.append(sumaRow, rabatRow, kwotaRow);
      modal.appendChild(summary);

      // Rabat czasowy — kwota + ile godzin ważny. Godziny liczą "ważny do" od
      // teraz; pole "ważny do" można też nadpisać ręcznie. Pipeline faktur i tak
      // stosuje ten rabat, dopóki termin nie minął (wyceny-pipeline.js).
      const rabat24hGrid = h('div', 'wk-form-grid');
      const rabat24hKwota = input(src.rabat24h_kwota ?? '', 'np. 100');
      rabat24hKwota.inputMode = 'decimal';
      const godzinyStart = (() => {
        if (!src.rabat24h_wazny_do) return '24';
        const diffH = Math.round((new Date(src.rabat24h_wazny_do).getTime() - Date.now()) / 3600000);
        return diffH > 0 ? String(diffH) : '24';
      })();
      const rabat24hGodziny = input(godzinyStart, 'np. 24', 'number');
      rabat24hGodziny.min = '1';
      rabat24hGodziny.step = '1';
      const rabat24hDo = input('', '', 'datetime-local');
      const setDoFromHours = () => {
        const hrs = money(rabat24hGodziny.value);
        if (!hrs) return;
        const d = new Date(Date.now() + hrs * 60 * 60 * 1000);
        const p = (x) => String(x).padStart(2, '0');
        rabat24hDo.value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
      };
      if (src.rabat24h_wazny_do) {
        const d = new Date(src.rabat24h_wazny_do);
        if (!Number.isNaN(d.getTime())) {
          const p = (x) => String(x).padStart(2, '0');
          rabat24hDo.value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
        }
      }
      rabat24hGodziny.addEventListener('input', () => { if (rabat24hKwota.value) setDoFromHours(); });
      rabat24hKwota.addEventListener('input', () => { if (rabat24hKwota.value && !rabat24hDo.value) setDoFromHours(); });
      rabat24hGrid.append(
        field('Rabat czasowy — kwota (zł)', rabat24hKwota),
        field('Ważny przez (godziny)', rabat24hGodziny),
        field('Ważny do', rabat24hDo),
      );
      modal.appendChild(rabat24hGrid);

      function refreshTotals() {
        const suma = itemsEd.suma();
        sumaVal.textContent = moneyPLN(suma);
        if (!kwotaTouched) kwotaInput.value = suma ? String(Math.round(suma * 100) / 100) : '';
        const kwota = money(kwotaInput.value);
        const rabat = kwota && suma ? Math.round((kwota - suma) * 100) / 100 : 0;
        rabatVal.textContent = rabat < 0 ? moneyPLN(rabat) : (rabat > 0 ? `+${moneyPLN(rabat)}` : '—');
        rabatVal.style.color = rabat < 0 ? 'var(--bad, #b5433f)' : '';
      }
      refreshTotals();

      // Akcje
      const actions = h('div', 'wk-modal-actions');
      const errEl = h('span', 'wk-error');
      const save = h('button', 'wk-btn primary', isNew ? 'Utwórz wycenę' : 'Zapisz zmiany');
      save.type = 'button';
      save.addEventListener('click', async () => {
        errEl.textContent = '';
        const body = {
          imie_nazwisko: imie.value.trim() || null,
          telefon_e164: telefon.value.replace(/\D/g, '') || null,
          email: email.value.trim().toLowerCase() || null,
          komentarz: komentarz.value.trim() || null,
          items: itemsEd.getItems(),
          kwota_proponowana_brutto: kwotaInput.value ? money(kwotaInput.value) : null,
          rabat24h_kwota: rabat24hKwota.value ? money(rabat24hKwota.value) : null,
          rabat24h_wazny_do: rabat24hDo.value ? new Date(rabat24hDo.value).toISOString() : null,
        };
        body.lead_id = leadId || null;
        // feedback_due tylko gdy coś się zmieniło — niezmieniony termin nie
        // resetuje baseline'u watchdoga po stronie serwera.
        const fb = feedbackInput.value;
        if (watchMuted && !fb) body.feedback_due = '';
        else if (fb !== initialFeedback) body.feedback_due = fb;
        if (!body.telefon_e164 && !body.email && !body.lead_id) {
          errEl.textContent = 'Podaj telefon albo e-mail.';
          return;
        }
        if (!body.items.length) {
          errEl.textContent = 'Dodaj przynajmniej jedną pozycję.';
          return;
        }
        save.disabled = true;
        try {
          const res = await fetch(isNew ? `${apiBase}/api/wyceny` : `${apiBase}/api/wyceny/${wycena.id}`, {
            method: isNew ? 'POST' : 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const resBody = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(resBody.error || `Błąd ${res.status}`);
          destroy();
          if (onSaved) onSaved(resBody.data);
        } catch (err) {
          errEl.textContent = err.message;
          save.disabled = false;
        }
      });
      const cancel = h('button', 'wk-btn', 'Anuluj');
      cancel.type = 'button';
      cancel.addEventListener('click', destroy);
      actions.append(errEl, cancel, save);
      modal.appendChild(actions);
    }).catch((err) => {
      loadingEl.textContent = `Nie udało się wczytać cennika: ${err.message}`;
    });
  }

  // ── Szybkie dodanie ────────────────────────────────────────────────────────

  function renderPreview(box, row, match) {
    box.innerHTML = '';
    const typChip = h('span', `wk-chip${row.typ === 'ZAMÓWIENIE' ? ' info' : ''}`, row.typ);
    const title = h('div', 'wk-section-title', 'Podgląd — sprawdź zanim zapiszesz ');
    title.appendChild(typChip);
    box.appendChild(title);

    // kontakt
    const kv = h('div', 'wk-kv');
    const addRow = (label, val) => {
      if (!val) return;
      const r = h('div', 'wk-kv-row');
      r.append(h('span', 'wk-kv-label', label), h('span', 'wk-kv-value', val));
      kv.appendChild(r);
    };
    addRow('Klient', row.imie_nazwisko);
    addRow('Telefon', row.telefon_e164 ? `+${row.telefon_e164}` : '');
    addRow('E-mail', row.email);
    addRow('Opis', row.opis_zamowienia);
    if (!row.telefon_e164 && !row.email) {
      const warn = h('div', 'wk-kv-row');
      warn.append(h('span', 'wk-kv-label', '⚠ Kontakt'), h('span', 'wk-kv-value', 'Parser nie znalazł telefonu ani e-maila — otwórz w edytorze i uzupełnij.'));
      kv.appendChild(warn);
    }
    box.appendChild(kv);

    // produkty (jak na karcie, ze zdjęciami)
    const fake = {
      items: row.items,
      kwota_proponowana_brutto: row.kwota_proponowana_brutto,
      _suma_pozycji: (row.items || []).reduce((a, p) => a + money(p.price) * (money(p.quantity) || 1), 0),
      rabat24h_kwota: row.rabat24h_kwota,
      rabat24h_wazny_do: row.rabat24h_wazny_do,
      _rabat24h_aktywny: Boolean(row.rabat24h_kwota),
    };
    fake._discount = fake.kwota_proponowana_brutto != null && fake._suma_pozycji
      ? Math.round((money(fake.kwota_proponowana_brutto) - fake._suma_pozycji) * 100) / 100 : 0;
    const productsEl = window.WycenaKarta
      ? (() => {
        const tmp = WycenaKarta.buildBody(fake, { readOnly: true, mode: 'preview' }).el;
        return tmp.firstChild; // sekcja Produkty
      })()
      : null;
    if (productsEl) box.appendChild(productsEl);
    return box;
  }

  function openQuickAdd({ apiBase, onSaved }) {
    const { modal, destroy } = openModal('⚡ Szybkie dodanie wyceny');

    const ta = document.createElement('textarea');
    ta.className = 'wk-quick-textarea';
    ta.placeholder = 'Wklej albo wpisz jak w Telegramie, np.:\nWycena\ntel. 513141389\n20 m cyfrowej taśmy COB IP65 3000K\n2 sterowniki\nCena 2600';
    modal.appendChild(ta);
    modal.appendChild(h('div', 'wk-quick-hint', 'Minimum: telefon LUB e-mail + produkty + cena. AI sparsuje i pokaże podgląd do zatwierdzenia — nic nie zapisuje się bez Twojego OK.'));

    const previewBox = h('div', 'wk-preview-box');
    previewBox.hidden = true;
    modal.appendChild(previewBox);

    const matchBanner = h('div', 'wk-match-banner');
    matchBanner.hidden = true;
    modal.appendChild(matchBanner);

    const actions = h('div', 'wk-modal-actions');
    const errEl = h('span', 'wk-error');
    const analyze = h('button', 'wk-btn primary', 'Analizuj (AI)');
    analyze.type = 'button';
    const saveBtn = h('button', 'wk-btn primary', 'Zapisz');
    saveBtn.type = 'button';
    saveBtn.hidden = true;
    const editorBtn = h('button', 'wk-btn', '✎ Edytuj produkty');
    editorBtn.type = 'button';
    editorBtn.title = 'Otwórz w pełnym edytorze — ilości, barwa, dodaj/usuń pozycję (ten sam co przy Produktach)';
    editorBtn.hidden = true;
    const cancel = h('button', 'wk-btn', 'Anuluj');
    cancel.type = 'button';
    cancel.addEventListener('click', destroy);
    actions.append(errEl, cancel, editorBtn, analyze, saveBtn);
    modal.appendChild(actions);

    let lastRow = null;
    let lastMatch = null;

    analyze.addEventListener('click', async () => {
      const tekst = ta.value.trim();
      errEl.textContent = '';
      if (!tekst) { errEl.textContent = 'Wpisz treść wyceny.'; return; }
      analyze.disabled = true;
      analyze.textContent = 'Analizuję…';
      try {
        const res = await fetch(`${apiBase}/api/wyceny/parsuj`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tekst }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `Błąd ${res.status}`);
        lastRow = body.row;
        lastMatch = body.match || null;

        previewBox.hidden = false;
        renderPreview(previewBox, lastRow, lastMatch);

        matchBanner.innerHTML = '';
        if (lastMatch) {
          matchBanner.hidden = false;
          matchBanner.appendChild(h('div', '', `Ten kontakt ma już wycenę #${lastMatch.id}`
            + `${lastMatch.imie_nazwisko ? ` (${lastMatch.imie_nazwisko})` : ''}`
            + `${lastMatch.kwota_proponowana_brutto ? ` na ${moneyPLN(lastMatch.kwota_proponowana_brutto)}` : ''}.`));
          const replaceDefault = body.parsed && body.parsed.quote_mode === 'REPLACE_EXISTING';
          [['podmien', `Podmień wycenę #${lastMatch.id} (nowe produkty i kwota, kontakt zostaje)`, replaceDefault],
           ['nowa', 'Utwórz nową, osobną wycenę', !replaceDefault]].forEach(([val, label, checked]) => {
            const lab = h('label');
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'wk-decyzja';
            radio.value = val;
            radio.checked = checked;
            lab.append(radio, document.createTextNode(label));
            matchBanner.appendChild(lab);
          });
        } else {
          matchBanner.hidden = true;
        }

        saveBtn.hidden = false;
        editorBtn.hidden = false;
        analyze.textContent = 'Analizuj ponownie';
      } catch (err) {
        errEl.textContent = err.message;
        analyze.textContent = 'Analizuj (AI)';
      } finally {
        analyze.disabled = false;
      }
    });

    saveBtn.addEventListener('click', async () => {
      if (!lastRow) return;
      errEl.textContent = '';
      const decyzja = lastMatch
        ? (modal.querySelector('input[name="wk-decyzja"]:checked')?.value || 'nowa')
        : 'nowa';
      saveBtn.disabled = true;
      try {
        const res = await fetch(`${apiBase}/api/wyceny/zapisz-parsowane`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tekst: ta.value.trim(), row: lastRow, decyzja, matchId: lastMatch ? lastMatch.id : null }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `Błąd ${res.status}`);
        destroy();
        if (onSaved) onSaved(body.data);
      } catch (err) {
        errEl.textContent = err.message;
        saveBtn.disabled = false;
      }
    });

    editorBtn.addEventListener('click', () => {
      if (!lastRow) return;
      destroy();
      openEditor({ apiBase, onSaved, prefill: lastRow });
    });
  }

  return {
    openQuickAdd,
    openNew: (opts) => openEditor(opts),
    openEdit: (wycena, opts) => openEditor({ ...opts, wycena }),
  };
})();
