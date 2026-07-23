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

  // Scalanie pozycji o tym samym SKU w jedną (sumuje ilość). To samo SKU = ten
  // sam produkt, więc "4× zasilacz 24 V" ma być 1 wierszem × 4 szt., a nie
  // czterema wierszami × 1. Pozycje bez SKU ("spoza oferty") NIE łączymy — dwa
  // różne produkty indywidualne mają puste SKU i muszą zostać osobno.
  function skuKey(p) {
    const sku = String((p && (p.SKU || p.sku)) || '').trim();
    // Klucz = SKU + cena. Ten sam produkt w dwóch różnych cenach (np. druga
    // partia z rabatem) zostaje osobno — inaczej suma pozycji by się zmieniła.
    return sku ? `${sku}|${money(p.price)}` : '';
  }

  function mergeBySku(list) {
    const out = [];
    const byKey = new Map();
    (list || []).forEach((raw) => {
      const p = { ...raw };
      const key = skuKey(p);
      if (key && byKey.has(key)) {
        const ex = byKey.get(key);
        ex.quantity = (money(ex.quantity) || 0) + (money(p.quantity) || 0);
        return;
      }
      if (key) byKey.set(key, p);
      out.push(p);
    });
    return out;
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
  // emoji. Panele biurkowy/ścienny to PILOTY (LL-PANEL → remote). Profile to
  // placeholder ("wkrótce"); "Spoza oferty" = produkt z ceną indywidualną.
  const CATEGORIES = [
    { key: 'dig', label: 'Cyfrowa taśma', tape: 'DIG' },
    { key: 'ana', label: 'Analogowa taśma', tape: 'ANA' },
    { key: 'ctrl', label: 'Sterowniki', prefixes: ['LL-CTRL'] },
    { key: 'remote', label: 'Piloty', prefixes: ['LL-REMOTE', 'LL-PANEL'] },
    { key: 'sensor', label: 'Czujniki', prefixes: ['LL-SENSOR'] },
    { key: 'acc', label: 'Akcesoria', prefixes: ['LL-ACC'] },
    { key: 'psu', label: 'Zasilacze', prefixes: ['LL-PSU'] },
    { key: 'profile', label: 'Profile', placeholder: true },
    // "Spoza oferty" — produkt z ceną indywidualną (nie ma go w cenniku).
    // Ręczna nazwa + cena za sztukę; jednostka zawsze szt., VAT zawsze 23%.
    { key: 'custom', label: 'Spoza oferty', custom: true },
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
    const skus = new Set(); // wszystkie SKU z cennika — do wykrycia pozycji spoza oferty
    (cennik || []).forEach((s) => {
      if (s.sku) skus.add(String(s.sku).trim());
      const t = parseTapeSku(s.sku);
      if (t && tapes[t.family]) {
        tapes[t.family].push({ ...t, sku: s.sku, price: s.price_brutto, image: s.image_url || '', nazwa: s.nazwa, unit: s.unit || 'm' });
      } else {
        const cat = CATEGORIES.find((c) => c.prefixes && c.prefixes.some((p) => String(s.sku || '').startsWith(p)));
        const key = cat ? cat.key : 'acc';
        (simple[key] = simple[key] || []).push(s);
      }
    });
    return { tapes, simple, skus };
  }

  // Pozycja "spoza oferty" (cena indywidualna): brak SKU albo SKU spoza cennika.
  // Takie pozycje dostają edytowalną nazwę + cenę za sztukę.
  function isCustomItem(catalog, p) {
    const sku = String((p && (p.SKU || p.sku)) || '').trim();
    if (!sku) return true;
    if (parseTapeSku(sku) && (catalog.tapes[parseTapeSku(sku).family] || []).length) return false;
    return !catalog.skus.has(sku);
  }

  // Wszystkie zdjęcia produktów z cennika (taśmy + proste), odsiane po URL —
  // do wyboru zdjęcia dla pozycji spoza oferty.
  function collectCatalogImages(catalog) {
    const out = [];
    const seen = new Set();
    const push = (image, nazwa) => {
      if (!image || seen.has(image)) return;
      seen.add(image);
      out.push({ image, nazwa: nazwa || '' });
    };
    ['DIG', 'ANA'].forEach((fam) => (catalog.tapes[fam] || []).forEach((t) => push(t.image, t.nazwa)));
    Object.keys(catalog.simple || {}).forEach((k) => (catalog.simple[k] || []).forEach((s) => push(s.image_url, s.nazwa)));
    return out;
  }

  // Modal z siatką zdjęć istniejących produktów; klik = przypisz zdjęcie.
  function openImagePicker({ catalog, onPick }) {
    const { modal, destroy } = openModal('Wybierz zdjęcie produktu');
    const body = h('div', 'wk-catalog-body');
    const images = collectCatalogImages(catalog);
    if (!images.length) {
      body.appendChild(h('div', 'wk-quick-hint', 'Brak zdjęć w cenniku do wyboru.'));
    } else {
      const grid = h('div', 'wk-catalog-grid');
      images.forEach(({ image, nazwa }) => {
        const card = h('button', 'wk-catalog-card');
        card.type = 'button';
        const thumbSlot = h('div', 'wk-catalog-thumb');
        const img = document.createElement('img'); img.loading = 'lazy'; img.src = image; img.alt = '';
        img.addEventListener('error', () => { thumbSlot.innerHTML = ''; thumbSlot.appendChild(h('div', 'wk-thumb-placeholder', '💡')); });
        thumbSlot.appendChild(img);
        card.appendChild(thumbSlot);
        card.appendChild(h('div', 'wk-catalog-name', nazwa));
        card.addEventListener('click', () => { onPick(image); destroy(); });
        grid.appendChild(card);
      });
      body.appendChild(grid);
    }
    modal.appendChild(body);
    const actions = h('div', 'wk-modal-actions');
    const cancel = h('button', 'wk-btn', 'Anuluj');
    cancel.type = 'button';
    cancel.addEventListener('click', destroy);
    actions.append(cancel);
    modal.appendChild(actions);
  }

  // Pole "zdjęcie" (miniatura + Wybierz/Zmień/Usuń) używane w formularzu "spoza
  // oferty". Trzyma URL w domknięciu; onChange dostaje aktualny URL.
  function buildImageField(catalog, initialUrl, onChange) {
    let url = initialUrl || '';
    const wrap = h('div', 'wk-img-field');
    const thumb = h('div', 'wk-edit-thumb-slot');
    const btn = h('button', 'wk-btn wk-btn--slim', '');
    btn.type = 'button';
    const clearBtn = h('button', 'wk-btn wk-btn--slim', 'Usuń');
    clearBtn.type = 'button';
    function renderThumb() {
      thumb.innerHTML = '';
      if (url) {
        const img = document.createElement('img');
        img.className = 'wk-thumb'; img.style.width = '42px'; img.style.height = '42px';
        img.src = url; img.alt = '';
        img.addEventListener('error', () => { thumb.innerHTML = ''; thumb.appendChild(h('div', 'wk-thumb-placeholder', '✎')); });
        thumb.appendChild(img);
      } else {
        thumb.appendChild(h('div', 'wk-thumb-placeholder', '✎'));
      }
      btn.textContent = url ? 'Zmień zdjęcie' : 'Wybierz zdjęcie';
      clearBtn.style.display = url ? '' : 'none';
    }
    btn.addEventListener('click', () => openImagePicker({ catalog, onPick: (u) => { url = u; renderThumb(); onChange(url); } }));
    clearBtn.addEventListener('click', () => { url = ''; renderThumb(); onChange(url); });
    renderThumb();
    wrap.append(thumb, btn, clearBtn);
    return { el: wrap, get: () => url, set: (u) => { url = u || ''; renderThumb(); } };
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
        if (c.custom) {
          const btn = h('button', 'wk-cat-btn');
          btn.type = 'button';
          const th = h('span', 'wk-cat-thumb'); th.appendChild(h('span', 'wk-cat-custom-ico', '✎'));
          btn.append(th, h('span', 'wk-cat-lbl', c.label));
          btn.addEventListener('click', () => openCategory(c));
          grid.appendChild(btn);
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
      if (c.custom) {
        // Formularz produktu spoza oferty: nazwa + cena za sztukę + ilość.
        // Jednostka szt., VAT 23% — na sztywno (tak jak chce Antoni).
        const form = h('div', 'wk-custom-form');
        const nameEl = input('', 'np. Klosz aluminiowy, montaż, projekt…');
        const priceEl = input('', '0,00'); priceEl.inputMode = 'decimal';
        const qtyEl = input('1', 'ilość'); qtyEl.inputMode = 'decimal';
        const imgField = buildImageField(catalog, '', () => {});
        form.append(
          field('Nazwa produktu', nameEl),
          field('Cena za sztukę (zł, brutto)', priceEl),
          field('Ilość (szt.)', qtyEl),
          field('Zdjęcie (z istniejących produktów)', imgField.el),
        );
        body.appendChild(form);
        body.appendChild(h('div', 'wk-quick-hint', 'Cena indywidualna — produkt spoza cennika. Jednostka: szt., VAT 23%.'));
        const add = h('button', 'wk-btn primary', '+ Dodaj pozycję');
        add.type = 'button';
        add.style.marginTop = '0.6rem';
        add.addEventListener('click', () => {
          const name = nameEl.value.trim();
          if (!name) { nameEl.focus(); return; }
          onPick({ name, SKU: '', quantity: money(qtyEl.value) || 1, unit: 'szt', price: String(money(priceEl.value)), VAT: '23', image_url: imgField.get() });
          nameEl.value = ''; priceEl.value = ''; qtyEl.value = '1'; imgField.set('');
          add.textContent = '✓ Dodano — dodaj kolejną';
          setTimeout(() => { add.textContent = '+ Dodaj pozycję'; }, 1300);
          nameEl.focus();
        });
        body.appendChild(add);
      } else if (c.tape) {
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
    // Scal duplikaty SKU już na wejściu — istniejące "rozbite" wyceny (albo
    // sparsowane z tekstu) skonsolidują się przy otwarciu edytora.
    const state = { items: mergeBySku(items || []) };
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
        } else if (isCustomItem(catalog, p)) {
          // Pozycja spoza oferty — cena indywidualna: edytowalna nazwa + cena
          // za sztukę + ilość. Jednostka szt., VAT 23% (na sztywno).
          p.unit = 'szt'; p.VAT = '23';
          const wrapc = h('div', 'wk-custom-item');
          const headRow = h('div', 'wk-custom-head');
          // Miniatura klikalna: wybór zdjęcia z istniejących produktów cennika.
          const thumbSlot = h('div', 'wk-edit-thumb-slot wk-img-clickable');
          thumbSlot.title = 'Kliknij, aby wybrać zdjęcie z produktów';
          const renderCustomThumb = () => {
            thumbSlot.innerHTML = '';
            if (p.image_url) {
              const img = document.createElement('img');
              img.className = 'wk-thumb'; img.style.width = '42px'; img.style.height = '42px';
              img.src = p.image_url; img.alt = '';
              img.addEventListener('error', () => { thumbSlot.innerHTML = ''; thumbSlot.appendChild(h('div', 'wk-thumb-placeholder', '✎')); });
              thumbSlot.appendChild(img);
            } else {
              thumbSlot.appendChild(h('div', 'wk-thumb-placeholder', '✎'));
            }
          };
          renderCustomThumb();
          thumbSlot.addEventListener('click', () => openImagePicker({ catalog, onPick: (u) => { p.image_url = u; renderCustomThumb(); if (ready) onChange(); } }));
          const nameEl = input(p.name || '', 'Nazwa produktu (spoza oferty)');
          nameEl.className = 'wk-custom-name';
          nameEl.addEventListener('input', () => { p.name = nameEl.value; if (ready) onChange(); });
          headRow.append(thumbSlot, nameEl, remove);

          const paramsRow = h('div', 'wk-custom-params');
          paramsRow.appendChild(h('span', 'wk-custom-tag', 'Cena indywidualna'));
          const priceEl = input(money(p.price) ? String(p.price) : '', '0,00');
          priceEl.inputMode = 'decimal';
          priceEl.className = 'wk-custom-price';
          priceEl.addEventListener('input', () => { p.price = priceEl.value; if (ready) onChange(); });
          const priceWrap = h('span', 'wk-custom-inline');
          priceWrap.append(priceEl, h('span', 'wk-edit-item-unit', 'zł/szt'));
          const qty = input(p.quantity ?? 1, 'ilość');
          qty.inputMode = 'decimal';
          qty.className = 'wk-edit-qty';
          qty.addEventListener('input', () => { p.quantity = qty.value; if (ready) onChange(); });
          const qtyWrap = h('span', 'wk-custom-inline');
          qtyWrap.append(qty, h('span', 'wk-edit-item-unit', 'szt'));
          paramsRow.append(priceWrap, h('span', 'wk-custom-x', '×'), qtyWrap);

          wrapc.append(headRow, paramsRow);
          box.appendChild(wrapc);
        } else {
          // Prosta pozycja z cennika — zdjęcie + nazwa (read-only) + ilość.
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
      addItem: (p) => {
        // To samo SKU + ta sama cena co pozycja już na liście → dolicz ilość
        // zamiast nowego wiersza. Bez SKU (spoza oferty) zawsze osobno.
        const key = skuKey(p);
        const ex = key ? state.items.find((x) => skuKey(x) === key) : null;
        if (ex) ex.quantity = (money(ex.quantity) || 0) + (money(p.quantity) || 1);
        else state.items.push({ ...p });
        render();
        if (ready) onChange();
      },
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
          showSavedBar(resBody.data, { apiBase, onSaved });
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
    // Rabat czasowy schodzi z "Do zapłaty" także w podglądzie parsera (spójnie
    // z kartą; brak zamrożonej sprzedaży w podglądzie => proponowana − rabat).
    fake._rabat24h_kwota = money(row.rabat24h_kwota) || 0;
    fake._cena_finalna = fake.kwota_proponowana_brutto != null
      ? Math.round((money(fake.kwota_proponowana_brutto) - fake._rabat24h_kwota) * 100) / 100
      : null;
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
        // Scal duplikaty SKU z parsera zanim pokażemy podgląd/zapiszemy — ten
        // sam zasilacz z dwóch linii ma być 1 pozycją × ilość, nie kilkoma.
        if (lastRow && Array.isArray(lastRow.items)) lastRow.items = mergeBySku(lastRow.items);
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
        showSavedBar(body.data, { apiBase, onSaved });
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

  // ── Pasek z linkiem po zapisie ──────────────────────────────────────────────
  // Po każdym zapisie (szybka wycena ORAZ pełny edytor) przykleja na dole
  // ekranu pasek z klienckim linkiem wyceny — wisi do ręcznego zamknięcia, nie
  // znika sam, żeby link był od razu pod ręką do wysłania klientowi. Obok linku
  // skrót "Pokaż wycenę" (otwiera tę wycenę). Jeden pasek na raz: kolejny zapis
  // podmienia poprzedni. Kopiowanie linku = wysłanie: oznacza wycenę jako
  // "Link wysłany" (POST /wyslij-link, tak jak przycisk w karcie). Świadomie NIE
  // wołamy onSaved po kopiowaniu — w szybkiej wycenie onSaved otwiera modal od
  // nowa, więc potwierdzenie pokazujemy w samym pasku.
  let savedBarEl = null;
  function closeSavedBar() {
    if (savedBarEl) { savedBarEl.remove(); savedBarEl = null; }
  }
  // Kopiowanie do schowka odporne na iOS/Safari. Zwraca Promise<bool> z REALNYM
  // wynikiem — wcześniej fallback odpalał clipboard.writeText "w tło" i zwracał
  // true nawet gdy kopiowanie się nie udało (przycisk mówił "Skopiowano", a w
  // schowku pusto). Nowoczesne API najpierw (iOS 13.4+ i desktop, w geście,
  // https), execCommand jako zapas dla starszych przeglądarek.
  async function copyToClipboard(text) {
    const str = String(text || '');
    if (!str) return false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(str);
        return true;
      }
    } catch (_) { /* zapas niżej */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = str;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '0';
      ta.style.width = '1px';
      ta.style.height = '1px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      if (/ipad|iphone|ipod/i.test(navigator.userAgent)) {
        const range = document.createRange();
        range.selectNodeContents(ta);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        ta.setSelectionRange(0, str.length);
      } else {
        ta.select();
      }
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      document.body.removeChild(ta);
      return ok;
    } catch (_) { return false; }
  }

  function showSavedBar(saved, { apiBase, onSaved }) {
    if (!saved || !saved.id) return;
    const link = saved._link || '';
    closeSavedBar();

    const bar = h('div', 'wk-savedbar');
    const titleEl = h('span', 'wk-savedbar-title', `✓ Wycena #${saved.id}`);
    bar.appendChild(titleEl);

    const input = document.createElement('input');
    input.readOnly = true;
    input.value = link;
    input.title = link;
    input.addEventListener('focus', () => input.select());
    input.addEventListener('click', () => input.select());
    bar.appendChild(input);

    const copy = h('button', 'wk-btn primary', '📋 Kopiuj link');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      // Kopiuj NAJPIERW (writeText wołane synchronicznie w geście — iOS), potem
      // oznacz "link wysłany" w tle. Link jest deterministyczny (?id=), więc
      // lokalny = serwerowy; nie czekamy na POST przed kopiowaniem.
      const copied = await copyToClipboard(link);
      if (!copied) { input.focus(); input.select(); }
      copy.textContent = copied ? 'Skopiowano ✓' : 'Zaznacz i skopiuj';
      setTimeout(() => { copy.textContent = '📋 Kopiuj link'; }, 1500);
      try {
        const res = await fetch(`${apiBase}/api/wyceny/${saved.id}/wyslij-link`, { method: 'POST' });
        if (res.ok) titleEl.textContent = `✓ Wycena #${saved.id} · link wysłany`;
      } catch (_) { /* oznaczenie nieobowiązkowe — link już w schowku */ }
    });
    bar.appendChild(copy);

    const show = h('button', 'wk-btn', 'Pokaż wycenę');
    show.type = 'button';
    show.addEventListener('click', () => {
      closeSavedBar();
      openEditor({ apiBase, onSaved, wycena: saved });
    });
    bar.appendChild(show);

    const close = h('button', 'wk-savedbar-close', '×');
    close.type = 'button';
    close.title = 'Zamknij';
    close.addEventListener('click', closeSavedBar);
    bar.appendChild(close);

    document.body.appendChild(bar);
    savedBarEl = bar;
  }

  return {
    openQuickAdd,
    openNew: (opts) => openEditor(opts),
    openEdit: (wycena, opts) => openEditor({ ...opts, wycena }),
  };
})();
