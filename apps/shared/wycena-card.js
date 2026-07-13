// ── Wspólna karta wyceny (zakładka Wyceny w CRM + panel Sprzedaże) ───────────
// Jedno źródło prawdy rozwiniętego widoku wyceny: produkty ZE ZDJĘCIAMI (jak
// w formularzu klienckim), kwoty z wyliczanym rabatem, kontakt, dostawa,
// sekcja formularza (link jednorazowy) i realizacja (przesyłki, faktury,
// tracking). Obie appki ładują ten plik przez <script src=".../wycena-card.js">
// i wołają WycenaKarta.buildBody(wycena, opts).
//
// `wycena` to wiersz z GET /api/wyceny — surowe kolumny + pola wyliczane
// (_suma_pozycji, _discount, _link, _rabat24h_aktywny, _shipments, _invoices,
// opcjonalnie _events). Endpointy: apps/shared/server/wyceny-endpoints.js.
window.WycenaKarta = (() => {
  'use strict';

  // Baza publicznych linków PDF (etykieta/faktura) — funkcja formularza,
  // ten sam origin co panele na prod (lumlum.dev). Nadpisywalne globalną
  // window.PUBLIC_PDF_BASE (np. inny port w dev).
  const PUBLIC_PDF_BASE = (typeof window !== 'undefined' && window.PUBLIC_PDF_BASE) || '/formularz';

  function moneyPLN(v) {
    const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(n)) return '—';
    return `${n.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;
  }

  function formatDT(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  const STAGE_LABELS = {
    NEW: ['Nowa', ''],
    FORM_SENT: ['Link wysłany', 'info'],
    SUBMITTED: ['Zamówienie złożone', 'info'],
    PROFORMA_SENT: ['Proforma wysłana', 'info'],
    PAID: ['Opłacona', 'good'],
    SHIPPED: ['Wysłana', 'info'],
    DELIVERED: ['Doręczona', 'good'],
    INVOICED: ['Faktura końcowa', 'good'],
    ERROR: ['Błąd pipeline', 'bad'],
  };

  const SHIP_STATUS_LABELS = {
    created: 'utworzona',
    confirmed: 'potwierdzona',
    sent: 'w drodze',
    delivered: 'doręczona',
    error: 'błąd',
  };

  const INVOICE_STATUS_LABELS = {
    pending: 'w przygotowaniu',
    issued: 'wystawiona',
    sent: 'wysłana',
    paid: 'opłacona',
    deleted: 'usunięta',
    error: 'błąd',
  };

  const PAYMENT_LABELS = {
    COD: 'Pobranie',
    cod: 'Pobranie',
    'Cash on Delivery (COD)': 'Pobranie',
    transfer: 'Przelew',
    PRZELEW: 'Przelew',
    'PRZELEW - OPŁACONE': 'Przelew (opłacone z góry)',
    FREE: 'Gratis',
    shopify_payments: 'Sklep (Shopify)',
  };

  function stageChip(stage) {
    const [label, tone] = STAGE_LABELS[stage] || [stage || '—', ''];
    const el = document.createElement('span');
    el.className = `wk-chip${tone ? ` ${tone}` : ''}`;
    el.textContent = label;
    return el;
  }

  function formChip(wycena) {
    const el = document.createElement('span');
    if (wycena.form_status === 'SUBMITTED') {
      el.className = 'wk-chip good';
      el.textContent = `Wypełniony ${wycena.form_submitted_at ? formatDT(wycena.form_submitted_at) : ''}`.trim();
    } else if (wycena.process_stage === 'FORM_SENT') {
      el.className = 'wk-chip info';
      el.textContent = 'Link wysłany, czeka na klienta';
    } else {
      el.className = 'wk-chip';
      el.textContent = 'Niewysłany';
    }
    return el;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Kopiowanie do schowka odporne na iOS/Safari: musi się wydarzyć
  // SYNCHRONICZNIE w geście kliknięcia (żaden await przed). navigator.clipboard
  // bywa blokowany po await i na nie-HTTPS, więc najpierw execCommand na
  // ukrytym textarea (działa też na iPhonie), potem API jako fallback.
  function copyToClipboard(text) {
    const str = String(text || '');
    if (!str) return false;
    try {
      const ta = document.createElement('textarea');
      ta.value = str;
      ta.contentEditable = 'true';
      ta.readOnly = false;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
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
      if (ok) return true;
    } catch (_) { /* przejdź do API */ }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(str);
        return true;
      }
    } catch (_) { /* nic */ }
    return false;
  }

  function copyBtn(getValue, label = 'Kopiuj') {
    const btn = el('button', 'wk-btn', label);
    btn.type = 'button';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(String(getValue() || ''));
        const prev = btn.textContent;
        btn.textContent = 'Skopiowano';
        setTimeout(() => { btn.textContent = prev; }, 1200);
      } catch (_) { /* clipboard niedostępny — nic nie psujemy */ }
    });
    return btn;
  }

  function kvRow(label, value, { muted = false, href = null } = {}) {
    const row = el('div', 'wk-kv-row');
    row.appendChild(el('span', 'wk-kv-label', label));
    const val = el('span', `wk-kv-value${muted ? ' wk-muted' : ''}`);
    if (href && value && value !== '—') {
      const a = el('a', '', value);
      a.href = href;
      val.appendChild(a);
    } else {
      val.textContent = value || '—';
    }
    row.appendChild(val);
    return row;
  }

  // ── Sekcja: produkty ze zdjęciami + kwoty ──────────────────────────────────
  function buildProducts(wycena, opts = {}) {
    const wrap = el('div');
    const title = el('div', 'wk-section-title wk-section-title--row', 'Produkty');
    if (opts.onEdit && !opts.readOnly) {
      const edit = el('button', 'wk-btn wk-btn--slim', '✎ Edytuj');
      edit.type = 'button';
      edit.title = 'Zmień ilości, barwę, dodaj lub usuń pozycję';
      edit.addEventListener('click', (e) => { e.stopPropagation(); opts.onEdit(wycena); });
      title.appendChild(edit);
    }
    wrap.appendChild(title);
    const list = el('div', 'wk-products');

    const items = Array.isArray(wycena.items) ? wycena.items : [];
    if (!items.length) list.appendChild(el('div', 'wk-pipe-sub', 'Brak pozycji.'));

    items.forEach((p) => {
      const row = el('div', 'wk-product');
      if (p.image_url) {
        const img = document.createElement('img');
        img.className = 'wk-thumb';
        img.loading = 'lazy';
        img.src = p.image_url;
        img.alt = '';
        img.addEventListener('error', () => {
          const ph = el('div', 'wk-thumb-placeholder', '💡');
          img.replaceWith(ph);
        });
        row.appendChild(img);
      } else {
        row.appendChild(el('div', 'wk-thumb-placeholder', '💡'));
      }
      const meta = el('div', 'wk-product-meta');
      meta.appendChild(el('div', 'wk-product-name', p.name || 'Produkt'));
      if (p.SKU) meta.appendChild(el('div', 'wk-product-sub', p.SKU));
      row.appendChild(meta);

      const line = el('div', 'wk-product-line');
      const qty = Number(p.quantity) || 1;
      const unit = p.unit || 'szt';
      const price = Number(String(p.price ?? '').replace(',', '.'));
      line.appendChild(el('div', 'wk-product-qty', Number.isFinite(price) && price > 0
        ? `${qty} ${unit} × ${moneyPLN(price)}`
        : `${qty} ${unit}`));
      if (Number.isFinite(price)) {
        line.appendChild(el('div', 'wk-product-total', moneyPLN(price * qty)));
      }
      row.appendChild(line);
      list.appendChild(row);
    });

    const discount = Number(wycena._discount) || 0;
    if (discount < 0) {
      const row = el('div', 'wk-product wk-product--rabat');
      row.appendChild(el('div', 'wk-thumb-placeholder', '−'));
      const meta = el('div', 'wk-product-meta');
      meta.appendChild(el('div', 'wk-product-name', 'Rabat'));
      row.appendChild(meta);
      const line = el('div', 'wk-product-line');
      line.appendChild(el('div', 'wk-product-total', moneyPLN(discount)));
      row.appendChild(line);
      list.appendChild(row);
    }
    wrap.appendChild(list);

    const totals = el('div', 'wk-totals');
    const suma = el('div', 'wk-totals-row');
    suma.append(el('span', '', 'Suma pozycji'), el('span', '', moneyPLN(wycena._suma_pozycji)));
    totals.appendChild(suma);
    if (discount < 0) {
      const rab = el('div', 'wk-totals-row wk-rabat');
      rab.append(el('span', '', 'Rabat'), el('span', '', moneyPLN(discount)));
      totals.appendChild(rab);
    }
    const final = el('div', 'wk-totals-row wk-final');
    final.append(
      el('span', '', 'Do zapłaty'),
      el('span', '', moneyPLN(wycena.kwota_proponowana_brutto ?? wycena._suma_pozycji))
    );
    totals.appendChild(final);
    if (wycena.kwota_sprzedazy_brutto && Number(wycena.kwota_sprzedazy_brutto) !== Number(wycena.kwota_proponowana_brutto)) {
      const sprz = el('div', 'wk-totals-row');
      sprz.append(el('span', '', 'Kwota sprzedaży'), el('span', '', moneyPLN(wycena.kwota_sprzedazy_brutto)));
      totals.appendChild(sprz);
    }
    wrap.appendChild(totals);

    if (wycena.rabat24h_kwota) {
      const aktywny = wycena._rabat24h_aktywny;
      const banner = el('div', `wk-rabat24h ${aktywny ? 'aktywny' : 'wygasly'}`);
      banner.textContent = aktywny
        ? `⏳ Rabat czasowy: −${moneyPLN(wycena.rabat24h_kwota)} ważny do ${formatDT(wycena.rabat24h_wazny_do)}`
        : `Rabat czasowy (−${moneyPLN(wycena.rabat24h_kwota)}) wygasł ${formatDT(wycena.rabat24h_wazny_do)}`;
      wrap.appendChild(banner);
    }
    return wrap;
  }

  // ── Sekcja: kontakt + dostawa/płatność ─────────────────────────────────────
  function buildInfoGrid(wycena, opts = {}) {
    const grid = el('div', 'wk-grid');

    const kontakt = el('div');
    kontakt.appendChild(el('div', 'wk-section-title', 'Kontakt'));
    const kv1 = el('div', 'wk-kv');
    const imie = wycena.imie_nazwisko || [wycena.first_name, wycena.last_name].filter(Boolean).join(' ');
    kv1.appendChild(kvRow('Imię i nazwisko', imie));
    const tel = wycena.telefon_e164 ? (String(wycena.telefon_e164).startsWith('+') ? wycena.telefon_e164 : `+${wycena.telefon_e164}`) : '';
    kv1.appendChild(kvRow('Telefon', tel, { href: tel ? `tel:${tel}` : null }));
    kv1.appendChild(kvRow('E-mail', wycena.email, { href: wycena.email ? `mailto:${wycena.email}` : null }));
    if (wycena.opis_zamowienia) kv1.appendChild(kvRow('Opis', wycena.opis_zamowienia));
    if (wycena.komentarz) kv1.appendChild(kvRow('Komentarz', wycena.komentarz));
    if (wycena.partner) kv1.appendChild(kvRow('Partner', wycena.partner));
    kv1.appendChild(kvRow('Data wyceny', formatDT(wycena.created_at), { muted: true }));
    // Data złożenia zamówienia tylko w panelu Sprzedaże — w Wycenach zbędna.
    if (opts.mode === 'sprzedaze' && wycena.form_submitted_at) {
      kv1.appendChild(kvRow('Data złożenia zamówienia', formatDT(wycena.form_submitted_at), { muted: true }));
    }
    kontakt.appendChild(kv1);
    grid.appendChild(kontakt);

    const dostawa = el('div');
    dostawa.appendChild(el('div', 'wk-section-title', 'Dostawa i płatność'));
    const kv2 = el('div', 'wk-kv');
    kv2.appendChild(kvRow('Płatność', PAYMENT_LABELS[wycena.payment_method] || wycena.payment_method || '—'));
    if (wycena.punkt_odbioru && String(wycena.punkt_odbioru).replace(/[,\s]/g, '')) {
      kv2.appendChild(kvRow('Paczkomat', `${wycena.punkt_odbioru}${wycena.punkt_odbioru_adres ? ` — ${wycena.punkt_odbioru_adres}` : ''}`));
    }
    const adres = [
      [wycena.ship_street, wycena.ship_house_no, wycena.ship_flat_no ? `/${wycena.ship_flat_no}` : ''].filter(Boolean).join(' ').replace(' /', '/'),
      [wycena.ship_postcode, wycena.ship_city].filter(Boolean).join(' '),
      wycena.ship_country && wycena.ship_country !== 'PL' ? wycena.ship_country : '',
    ].filter(Boolean).join(', ');
    if (adres) kv2.appendChild(kvRow('Adres dostawy', adres));
    if (wycena.invoice_company_nip || wycena.invoice_company_name) {
      kv2.appendChild(kvRow('Faktura na firmę', [wycena.invoice_company_name, wycena.invoice_company_nip ? `NIP ${wycena.invoice_company_nip}` : ''].filter(Boolean).join(', ')));
    }
    if (wycena.dane_do_faktury) kv2.appendChild(kvRow('Dane do faktury', wycena.dane_do_faktury));
    dostawa.appendChild(kv2);
    grid.appendChild(dostawa);

    return grid;
  }

  // ── Sekcja: formularz (jednorazowy link) ───────────────────────────────────
  function buildFormSection(wycena, opts) {
    const wrap = el('div');
    const title = el('div', 'wk-section-title', 'Formularz zamówienia ');
    title.appendChild(formChip(wycena));
    wrap.appendChild(title);

    const bar = el('div', 'wk-linkbar');
    const input = document.createElement('input');
    input.readOnly = true;
    input.value = wycena._link || '';
    input.addEventListener('click', () => input.select());
    bar.appendChild(input);

    if (!opts.readOnly) {
      const send = el('button', 'wk-btn primary', 'Kopiuj link');
      send.type = 'button';
      send.title = 'Kopiuje link i oznacza wycenę jako "Link wysłany"';
      send.addEventListener('click', async () => {
        // Kopiuj NAJPIERW (synchronicznie w geście — inaczej iOS odmawia),
        // dopiero potem oznacz "link wysłany" w tle.
        const copied = copyToClipboard(wycena._link || input.value);
        send.textContent = copied ? 'Skopiowano ✓' : 'Zaznacz i skopiuj';
        setTimeout(() => { send.textContent = 'Kopiuj link'; }, 1500);
        try {
          const res = await fetch(`${opts.apiBase}/api/wyceny/${wycena.id}/wyslij-link`, { method: 'POST' });
          if (res.ok && opts.onChanged) opts.onChanged();
        } catch (_) { /* oznaczenie nieobowiązkowe — link już w schowku */ }
      });
      bar.appendChild(send);

      if (wycena.form_status === 'SUBMITTED') {
        const reopen = el('button', 'wk-btn danger', 'Otwórz formularz ponownie');
        reopen.type = 'button';
        reopen.title = 'Klient będzie mógł wypełnić formularz jeszcze raz (historia zostaje)';
        reopen.addEventListener('click', async () => {
          if (!confirm(`Otworzyć ponownie formularz wyceny #${wycena.id}? Klient będzie mógł złożyć zamówienie jeszcze raz.`)) return;
          try {
            const res = await fetch(`${opts.apiBase}/api/wyceny/${wycena.id}/otworz-formularz`, { method: 'POST' });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.error || `Błąd ${res.status}`);
            if (opts.onChanged) opts.onChanged();
          } catch (err) {
            alert(`Nie udało się: ${err.message}`);
          }
        });
        bar.appendChild(reopen);
      }
    } else {
      bar.appendChild(copyBtn(() => input.value));
    }
    wrap.appendChild(bar);
    return wrap;
  }

  // ── Sekcja: realizacja (przesyłki + faktury) ───────────────────────────────
  function buildPipeline(wycena, opts) {
    const wrap = el('div');
    const title = el('div', 'wk-section-title', 'Realizacja ');
    title.appendChild(stageChip(wycena.process_stage));
    if (wycena.paid) title.appendChild(document.createTextNode(' '));
    if (wycena.paid) {
      const paidChip = el('span', 'wk-chip good', '✓ Zapłacone');
      title.appendChild(paidChip);
    }
    wrap.appendChild(title);

    // Treść błędu pipeline widoczna wprost na karcie (nie tylko status
    // "Błąd pipeline") — żeby od razu było wiadomo CO poszło nie tak.
    if (wycena.process_stage === 'ERROR' && wycena.worker_last_error) {
      const errBox = el('div', 'wk-pipe-error');
      errBox.append(
        el('span', 'wk-pipe-error-ico', '⚠️'),
        el('span', '', String(wycena.worker_last_error))
      );
      wrap.appendChild(errBox);

      // "Ponów realizację" — Twój przycisk decyzji z panelu: po poprawie danych
      // w edycji albo gdy błąd był chwilowy, odpala pipeline od nowa (/realizuj
      // re-waliduje i startuje). Idempotentnie: istniejąca przesyłka/faktura
      // nie tworzy się drugi raz (pipeline sprawdza).
      if (!opts.readOnly) {
        const retry = el('button', 'wk-btn primary', 'Ponów realizację');
        retry.type = 'button';
        retry.title = 'Uruchom realizację jeszcze raz (po poprawie danych lub gdy błąd był chwilowy)';
        retry.addEventListener('click', async () => {
          if (!confirm(`Ponowić realizację wyceny #${wycena.id}?`)) return;
          retry.disabled = true;
          retry.textContent = 'Ponawiam…';
          try {
            const res = await fetch(`${opts.apiBase}/api/wyceny/${wycena.id}/realizuj`, { method: 'POST' });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.error || `Błąd ${res.status}`);
            if (opts.onChanged) opts.onChanged();
          } catch (err) {
            alert(`Nie udało się: ${err.message}`);
            retry.disabled = false;
            retry.textContent = 'Ponów realizację';
          }
        });
        wrap.appendChild(retry);
      }
    }

    // Komentarz do wyceny widoczny przy realizacji (np. "dodaj 1 czujnik
    // więcej") — pakujący/realizujący musi go zobaczyć.
    if (wycena.komentarz && String(wycena.komentarz).trim()) {
      const note = el('div', 'wk-komentarz');
      note.append(el('span', 'wk-komentarz-ico', '📝'), el('span', '', String(wycena.komentarz).trim()));
      wrap.appendChild(note);
    }

    const list = el('div', 'wk-pipeline');

    (wycena._shipments || []).forEach((s) => {
      const row = el('div', 'wk-pipe-row');
      row.appendChild(el('span', 'wk-pipe-ico', '📦'));
      const main = el('div', 'wk-pipe-main');
      const serviceLabel = s.provider === 'furgonetka'
        ? 'Furgonetka'
        : (String(s.service || '').includes('locker') ? 'InPost Paczkomat' : 'InPost Kurier');
      main.appendChild(el('div', '', `${serviceLabel}${s.kind === 'reship' ? ' (dosyłka)' : ''} — ${SHIP_STATUS_LABELS[s.status] || s.status || '—'}`));
      const subParts = [];
      if (s.tracking_number) subParts.push(`nr ${s.tracking_number}`);
      if (s.cod_amount) subParts.push(`pobranie ${moneyPLN(s.cod_amount)}`);
      if (s.delivered_at) subParts.push(`doręczono ${formatDT(s.delivered_at)}`);
      else if (s.nadana_at) subParts.push(`nadano ${formatDT(s.nadana_at)}`);
      if (subParts.length) main.appendChild(el('div', 'wk-pipe-sub', subParts.join(' · ')));
      row.appendChild(main);
      const links = el('div', 'wk-pipe-links');
      if (s.tracking_number) {
        const a = el('a', '', 'Śledzenie');
        a.href = `https://inpost.pl/sledzenie-przesylek?number=${encodeURIComponent(s.tracking_number)}`;
        a.target = '_blank';
        links.appendChild(a);
      }
      // Publiczny link (bez logowania) gdy wycena ma form_token — druk z
      // telefonu bez sesji panelu; fallback na proxy panelu dla starych wycen.
      const labelHref = s.label_url
        || (s.provider === 'shipx' && s.shipment_id
          ? (wycena.form_token
            ? `${PUBLIC_PDF_BASE}/api/etykieta/${s.shipment_id}?t=${encodeURIComponent(wycena.form_token)}`
            : `${opts.apiBase || ''}/api/wyceny/label/${s.shipment_id}`)
          : null);
      if (labelHref) {
        const a = el('a', '', 'Etykieta');
        a.href = labelHref;
        a.target = '_blank';
        links.appendChild(a);
      }
      row.appendChild(links);
      list.appendChild(row);
    });

    (wycena._invoices || []).forEach((i) => {
      const row = el('div', 'wk-pipe-row');
      row.appendChild(el('span', 'wk-pipe-ico', '🧾'));
      const main = el('div', 'wk-pipe-main');
      main.appendChild(el('div', '', `${i.kind === 'vat' ? 'Faktura VAT' : 'Proforma'}${i.number ? ` ${i.number}` : ''} — ${INVOICE_STATUS_LABELS[i.status] || i.status || '—'}`));
      const subParts = [];
      if (i.gross) subParts.push(moneyPLN(i.gross));
      if (i.paid_at) subParts.push(`opłacona ${formatDT(i.paid_at)}`);
      if (i.ksef_at) subParts.push('KSeF ✓');
      if (subParts.length) main.appendChild(el('div', 'wk-pipe-sub', subParts.join(' · ')));
      row.appendChild(main);
      const links = el('div', 'wk-pipe-links');
      const pdfHref = i.pdf_url
        || (i.infakt_uuid && i.status !== 'deleted'
          ? (wycena.form_token
            ? `${PUBLIC_PDF_BASE}/api/faktura/${i.infakt_uuid}?t=${encodeURIComponent(wycena.form_token)}`
            : `${opts.apiBase || ''}/api/wyceny/invoice-pdf/${i.infakt_uuid}`)
          : null);
      if (pdfHref) {
        const a = el('a', '', 'PDF');
        a.href = pdfHref;
        a.target = '_blank';
        links.appendChild(a);
      }
      if (i.quick_payment_url) {
        const a = el('a', '', 'Link płatności');
        a.href = i.quick_payment_url;
        a.target = '_blank';
        links.appendChild(a);
      }
      row.appendChild(links);
      list.appendChild(row);
    });

    if (!(wycena._shipments || []).length && !(wycena._invoices || []).length) {
      list.appendChild(el('div', 'wk-pipe-sub', 'Jeszcze bez przesyłek i faktur.'));
    }
    wrap.appendChild(list);

    // "Zamów kuriera ponownie" — dosyłka/reklamacja na te same dane, bez
    // faktury i bez zmiany statusów (panel Sprzedaże; endpoint w pipeline).
    if (opts.mode === 'sprzedaze' && !opts.readOnly && (wycena._shipments || []).length) {
      const actions = el('div', 'wk-actions');
      const btn = el('button', 'wk-btn', 'Zamów kuriera ponownie');
      btn.type = 'button';
      btn.addEventListener('click', async () => {
        if (!confirm(`Utworzyć NOWĄ przesyłkę na te same dane dla zamówienia #${wycena.id}? (bez faktury, bez zmiany statusów)`)) return;
        btn.disabled = true;
        try {
          const res = await fetch(`${opts.apiBase}/api/wyceny/${wycena.id}/reship`, { method: 'POST' });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || `Błąd ${res.status}`);
          if (opts.onChanged) opts.onChanged();
        } catch (err) {
          alert(`Nie udało się: ${err.message}`);
        } finally {
          btn.disabled = false;
        }
      });
      actions.appendChild(btn);
      wrap.appendChild(actions);
    }
    return wrap;
  }

  // ── Sekcja: historia (events + history_log z arkusza) ──────────────────────
  const EVENT_LABELS = {
    'wycena.created': 'Utworzono wycenę',
    'wycena.edited': 'Edycja',
    'form.link_sent': 'Link wysłany',
    'form.reopened': 'Formularz otwarty ponownie',
    'form.submitted': 'Formularz wypełniony',
    'shipment.created': 'Przesyłka utworzona',
    'shipment.reship': 'Dosyłka utworzona',
    'tracking.read': 'Odczyt trackingu',
    'invoice.created': 'Faktura utworzona',
    'invoice.paid': 'Faktura opłacona',
    'mail.sent': 'Mail wysłany',
    'pipeline.error': 'Błąd pipeline',
  };

  function buildHistory(wycena) {
    if (!(wycena._events || []).length && !wycena.history_log) return null;
    const details = el('details', 'wk-history');
    details.appendChild(el('summary', '', `Historia (${(wycena._events || []).length})`));
    const list = el('div', 'wk-history-list');
    (wycena._events || []).forEach((ev) => {
      const row = el('div', 'wk-event');
      row.appendChild(el('span', 'wk-event-dot'));
      row.appendChild(el('span', 'wk-event-time', formatDT(ev.created_at)));
      row.appendChild(el('span', 'wk-event-kind', EVENT_LABELS[ev.kind] || ev.kind));
      if (ev.payload) {
        const summary = typeof ev.payload === 'object'
          ? Object.entries(ev.payload).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ')
          : String(ev.payload);
        row.appendChild(el('span', 'wk-event-payload', summary.slice(0, 220)));
      }
      list.appendChild(row);
    });
    details.appendChild(list);
    if (wycena.history_log) {
      details.appendChild(el('div', 'wk-history-raw', wycena.history_log));
    }
    return details;
  }

  // ── Sekcja: Historia rozmów (telefon + notatki + transkrypcje z leada) ──────
  // Wszystko, co wiemy o kliencie: zbiór wpisów z "Log zmian" dopasowanych po
  // numerze telefonu wyceny (telefoniczne rozmowy Zadarmy, notatki handlowca,
  // a w przyszłości maile). Leniwie — dociąga dopiero po rozwinięciu.
  function callDot(row) {
    const nieodebrane = row.disposition === 'no_answer';
    return el('span', `wk-rozmowa-dot${nieodebrane ? ' nieodebrane' : ''}`);
  }

  function renderRozmowy(list, rozmowy) {
    list.innerHTML = '';
    if (!rozmowy.length) {
      list.appendChild(el('div', 'wk-pipe-sub', 'Brak zarejestrowanych rozmów dla tego numeru.'));
      return;
    }
    rozmowy.forEach((row) => {
      const entry = el('div', 'wk-rozmowa');
      const head = el('div', 'wk-rozmowa-head');
      head.appendChild(callDot(row));
      head.appendChild(el('span', 'wk-rozmowa-time', formatDT(row.data_zmiany)));
      const jestNotatka = row.zrodlo === 'notatka_handlowca' || row.zrodlo === 'manual_akcja';
      if (row.zrodlo === 'facebook_lead_webhook') {
        // Wpadnięcie leada, nie rozmowa — czytelna etykieta zamiast pustki/czasu.
        head.appendChild(el('span', 'wk-rozmowa-tag', 'nowy lead'));
      } else if (jestNotatka) {
        head.appendChild(el('span', 'wk-rozmowa-tag', row.zrodlo === 'manual_akcja'
          ? 'zmiana akcji'
          : `notatka${row.handlowiec ? ` · ${row.handlowiec}` : ''}`));
      } else if (row.czas_trwania_s) {
        const s = Number(row.czas_trwania_s) || 0;
        head.appendChild(el('span', 'wk-rozmowa-tag', `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`));
      }
      entry.appendChild(head);
      const opis = String(row.opis || '').trim();
      if (opis) {
        entry.appendChild(el('div', 'wk-rozmowa-opis', opis));
      } else if (row.disposition === 'no_answer') {
        entry.appendChild(el('div', 'wk-rozmowa-opis wk-muted', 'Nieodebrane'));
      }
      const transkr = String(row.transkrypcja || '').trim();
      if (transkr) {
        const det = el('details', 'wk-rozmowa-transkr');
        det.appendChild(el('summary', '', 'Transkrypcja'));
        det.appendChild(el('div', 'wk-rozmowa-transkr-tresc', transkr));
        entry.appendChild(det);
      }
      list.appendChild(entry);
    });
  }

  function buildRozmowy(wycena, opts = {}) {
    const wrap = el('div');
    const details = el('details', 'wk-history wk-rozmowy');
    const summary = el('summary', '', 'Historia rozmów');
    details.appendChild(summary);
    const list = el('div', 'wk-rozmowy-list');
    details.appendChild(list);
    wrap.appendChild(details);

    let loaded = false;
    details.addEventListener('toggle', async () => {
      if (!details.open || loaded) return;
      loaded = true;
      list.appendChild(el('div', 'wk-pipe-sub', 'Wczytywanie…'));
      try {
        const res = await fetch(`${opts.apiBase || ''}/api/wyceny/${wycena.id}/rozmowy`);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `Błąd ${res.status}`);
        renderRozmowy(list, body.rozmowy || []);
      } catch (err) {
        list.innerHTML = '';
        list.appendChild(el('div', 'wk-pipe-sub', `Błąd wczytywania: ${err.message}`));
        loaded = false;
      }
    });
    return wrap;
  }

  // ── Główne API ─────────────────────────────────────────────────────────────
  // opts: { apiBase, readOnly, mode: 'crm'|'sprzedaze', onChanged, onEdit }
  function buildBody(wycena, opts = {}) {
    const body = el('div', 'wk-body');
    body.appendChild(buildProducts(wycena, opts));
    body.appendChild(buildInfoGrid(wycena, opts));
    body.appendChild(buildFormSection(wycena, opts));
    body.appendChild(buildPipeline(wycena, opts));
    body.appendChild(buildRozmowy(wycena, opts));
    const history = buildHistory(wycena);
    if (history) body.appendChild(history);
    return { el: body };
  }

  return {
    buildBody,
    utils: { moneyPLN, formatDT, stageChip, formChip, STAGE_LABELS, PAYMENT_LABELS },
  };
})();
