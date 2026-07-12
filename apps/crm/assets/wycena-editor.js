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

  function buildItemsEditor(items, onChange) {
    const wrap = h('div', 'wk-edit-items');
    const state = { items: (items || []).map((p) => ({ ...p })) };

    function render() {
      wrap.innerHTML = '';
      state.items.forEach((p, idx) => {
        const box = h('div', 'wk-edit-item-box');
        const row = h('div', 'wk-edit-item');

        // Miniatura (żywa — aktualizuje się po wklejeniu linku do zdjęcia).
        const thumbSlot = h('div', 'wk-edit-thumb-slot');
        function renderThumb() {
          thumbSlot.innerHTML = '';
          if (p.image_url) {
            const img = document.createElement('img');
            img.className = 'wk-thumb';
            img.style.width = '42px';
            img.style.height = '42px';
            img.src = p.image_url;
            img.alt = '';
            img.addEventListener('error', () => { thumbSlot.innerHTML = ''; thumbSlot.appendChild(h('div', 'wk-thumb-placeholder', '💡')); });
            thumbSlot.appendChild(img);
          } else {
            thumbSlot.appendChild(h('div', 'wk-thumb-placeholder', '💡'));
          }
        }
        renderThumb();
        row.appendChild(thumbSlot);

        const name = input(p.name, 'Nazwa produktu');
        name.addEventListener('input', () => { p.name = name.value; onChange(); });
        row.appendChild(name);

        const qty = input(p.quantity ?? 1, 'ilość');
        qty.inputMode = 'decimal';
        qty.addEventListener('input', () => { p.quantity = qty.value; update(); });
        row.appendChild(qty);

        const unit = input(p.unit || 'szt', 'jedn.');
        unit.addEventListener('input', () => { p.unit = unit.value; onChange(); });
        row.appendChild(unit);

        const price = input(p.price ?? '', 'cena');
        price.inputMode = 'decimal';
        price.addEventListener('input', () => { p.price = price.value; update(); });
        row.appendChild(price);

        const total = h('div', 'wk-line-total');
        row.appendChild(total);

        const remove = h('button', 'wk-edit-item-remove', '✕');
        remove.type = 'button';
        remove.title = 'Usuń pozycję';
        remove.addEventListener('click', () => {
          state.items.splice(idx, 1);
          render();
          onChange();
        });
        row.appendChild(remove);
        box.appendChild(row);

        // Druga linia: SKU (opcjonalny) + link do zdjęcia. Pozycja z linkiem
        // jest zapisywana do cennika przy zapisie wyceny (serwer, dedupe).
        const extra = h('div', 'wk-edit-item-extra');
        const sku = input(p.SKU || '', 'SKU (opcjonalny)');
        sku.addEventListener('input', () => { p.SKU = sku.value.trim(); onChange(); });
        const imgUrl = input(p.image_url || '', 'link do zdjęcia (https://…)');
        imgUrl.addEventListener('input', () => { p.image_url = imgUrl.value.trim(); renderThumb(); onChange(); });
        extra.append(sku, imgUrl);
        box.appendChild(extra);

        function update() {
          total.textContent = moneyPLN(money(p.price) * (money(p.quantity) || 0));
          onChange();
        }
        update();
        wrap.appendChild(box);
      });
      if (!state.items.length) wrap.appendChild(h('div', 'wk-quick-hint', 'Brak pozycji — dodaj z cennika albo własną.'));
    }

    render();
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
      addItem: (p) => { state.items.push(p); render(); onChange(); },
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
    const opis = input(src.opis_zamowienia, 'krótki opis (opcjonalnie)');
    // Komentarz do wyceny — pokazuje się przy realizacji (np. "dodaj 1 czujnik
    // więcej"). Typ celowo usunięty: dopóki nie zrealizowana, to wycena.
    const komentarz = document.createElement('textarea');
    komentarz.className = 'wk-quick-textarea';
    komentarz.rows = 2;
    komentarz.style.minHeight = '3.2rem';
    komentarz.placeholder = 'np. dodać 1 czujnik więcej, zapakować na prezent…';
    komentarz.value = src.komentarz || '';

    const grid = h('div', 'wk-form-grid');
    grid.append(
      field('Imię i nazwisko', imie),
      field('Telefon', telefon),
      field('E-mail', email),
    );
    const opisWrap = field('Opis', opis);
    opisWrap.style.gridColumn = '1 / -1';
    grid.appendChild(opisWrap);
    const komWrap = field('Komentarz (widoczny przy realizacji)', komentarz);
    komWrap.style.gridColumn = '1 / -1';
    grid.appendChild(komWrap);
    modal.appendChild(grid);

    // Pozycje
    modal.appendChild(h('div', 'wk-section-title', 'Pozycje'));
    let kwotaTouched = Boolean(!isNew || (prefill && prefill.kwota_proponowana_brutto != null));
    const itemsEd = buildItemsEditor(src.items || [], () => refreshTotals());
    modal.appendChild(itemsEd.el);

    // Dodawanie pozycji
    const addbar = h('div', 'wk-edit-addbar');
    const skuSel = document.createElement('select');
    skuSel.appendChild(h('option', '', '+ pozycja z cennika…'));
    fetchCennik(apiBase).then((cennik) => {
      cennik.forEach((s) => {
        const o = h('option', '', `${s.nazwa} — ${moneyPLN(s.price_brutto)}/${s.unit}`);
        o.value = s.sku;
        skuSel.appendChild(o);
      });
    }).catch(() => {});
    skuSel.addEventListener('change', () => {
      const sku = skuSel.value;
      const s = (cennikCache || []).find((x) => x.sku === sku);
      if (s) {
        itemsEd.addItem({
          name: s.nazwa, SKU: s.sku, quantity: 1, unit: s.unit || 'szt',
          price: String(s.price_brutto ?? ''), VAT: String(s.vat || 23), image_url: s.image_url || '',
        });
      }
      skuSel.selectedIndex = 0;
    });
    const customBtn = h('button', 'wk-btn', '+ własna pozycja');
    customBtn.type = 'button';
    customBtn.addEventListener('click', () => itemsEd.addItem({ name: '', quantity: 1, unit: 'szt', price: '', VAT: '23' }));
    addbar.append(skuSel, customBtn);
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
    const rabat24hGodziny = input('24', 'np. 24', 'number');
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
        opis_zamowienia: opis.value.trim() || null,
        komentarz: komentarz.value.trim() || null,
        items: itemsEd.getItems(),
        kwota_proponowana_brutto: kwotaInput.value ? money(kwotaInput.value) : null,
        rabat24h_kwota: rabat24hKwota.value ? money(rabat24hKwota.value) : null,
        rabat24h_wazny_do: rabat24hDo.value ? new Date(rabat24hDo.value).toISOString() : null,
      };
      if (prefill && prefill.lead_id) body.lead_id = prefill.lead_id;
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
    const editorBtn = h('button', 'wk-btn', 'Otwórz w edytorze');
    editorBtn.type = 'button';
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
