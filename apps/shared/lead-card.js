// ── Wspólna karta leada (Backlog B2C + CRM) ─────────────────────────────────
// Jedno źródło prawdy dla rozwiniętego widoku leada: Najbliższa akcja (z
// ptaszkiem "zrobione dziś"), plusik "+ Dodaj własny komentarz", Podsumowanie
// AI, Historia rozmów, siatki Kontakt/Transakcja i sekcja Wycena. Kod
// przeniesiony z apps/crm/app.html (wygląd/edycja pól) + apps/backlog-b2c
// (notatka z dyktowaniem). Obie appki ładują ten plik przez <script src=
// "shared/lead-card.js"> i wołają LeadKarta.buildBody(lead, opts).
//
// Wymagane endpointy (te same ścieżki w obu appkach — patrz
// apps/shared/server/leady-endpoints.js):
//   PUT  /api/leady/:idLeada            — zapis jednego pola
//   GET  /api/leady/:telefon/historia   — fallback historii z Log zmian
//   GET  /api/leady/:telefon/wycena     — dopasowana Wycena B2C
//   POST /api/leady/notatka             — własny komentarz handlowca
//   POST /api/leady/akcja               — edycja/odhaczenie najbliższej akcji
//   POST /api/transcribe                — dyktowanie notatki
//
// `lead` to surowy wiersz "Leady B2C" wzbogacony o pola wyliczane
// (_telefon_digits, _telefon_formatted, _ma_wycene, _ilosc_polaczen,
// _kontakt_dzisiaj) — dokładnie to, co zwraca GET /api/leady (CRM) i
// GET /api/leady/pelny (Backlog).
window.LeadKarta = (() => {
  'use strict';

  // ── Daty / formatowanie (1:1 z CRM) ───────────────────────────────────────

  function parseAnyDate(value) {
    if (!value) return null;
    const s = String(value).trim();
    // DD.MM.YYYY sprawdzamy PRZED new Date() — część silników parsuje
    // "08.07.2026" po amerykańsku jako MM.DD.YYYY, inne odrzucają.
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T](\d{1,2}):(\d{2}))?/.exec(s);
    if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4] || 0), Number(m[5] || 0));
    // Czyste liczby (np. surowy numer seryjny Excela) nie są datą — nie zgaduj.
    if (/^\d+$/.test(s)) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function formatPlDateTime(value) {
    const d = parseAnyDate(value);
    if (!d) return '—';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${dd}.${mm}.${d.getFullYear()} ${hh}:${min}`;
  }

  // Formatowanie WYŁĄCZNIE do wyświetlania — niesparsowalna wartość wraca
  // bez zmian, żeby nigdy nie zniekształcić surowych danych.
  function formatDateOnly(value, withTime) {
    if (!value) return '';
    const d = parseAnyDate(value);
    if (!d) return value;
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    let out = `${dd}.${mm}.${d.getFullYear()}`;
    if (withTime) {
      const hh = String(d.getHours()).padStart(2, '0');
      const min = String(d.getMinutes()).padStart(2, '0');
      out += ` ${hh}:${min}`;
    }
    return out;
  }

  // Konwersje dla natywnego <input type="date">; zapis wraca do Supabase w
  // "DD.MM.YYYY" (Backlog parsuje "Data Feedbacku" sztywnym regexem).
  function toIsoDateValue(value) {
    const d = parseAnyDate(value);
    if (!d) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function fromIsoDateValue(isoValue) {
    if (!isoValue) return '';
    const [y, m, d] = isoValue.split('-');
    return `${d}.${m}.${y}`;
  }

  function formatRelativeDateTime(value) {
    const d = parseAnyDate(value);
    if (!d) return '—';
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diffDays = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
    if (diffDays === 0) return `dziś ${hh}:${min}`;
    if (diffDays === 1) return `wczoraj ${hh}:${min}`;
    return formatPlDateTime(value);
  }

  function nowPlDateTime() {
    return formatDateOnly(new Date().toISOString(), true) || formatPlDateTime(new Date().toISOString());
  }

  function formatDurationS(totalS) {
    const s = Number(totalS) || 0;
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return rest ? `${m}min ${rest}s` : `${m}min`;
  }

  function isOverdue(value) {
    const d = parseAnyDate(value);
    if (!d) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return d.getTime() < today.getTime();
  }

  // Termin akcji: "DD.MM.YYYY" lub "DD.MM.YYYY HH:mm"; sam dzień bez godziny
  // jest przeterminowany dopiero po końcu dnia.
  function parseTerminAkcji(str) {
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(String(str || '').trim());
    if (!m) return null;
    return new Date(
      Number(m[3]), Number(m[2]) - 1, Number(m[1]),
      m[4] !== undefined ? Number(m[4]) : 23,
      m[5] !== undefined ? Number(m[5]) : 59
    );
  }

  function isOverdueTermin(str) {
    const d = parseTerminAkcji(str);
    return d ? d.getTime() < Date.now() : false;
  }

  function truncatePreview(text, max) {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    if (!flat) return '—';
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
  }

  // Linki z automatyzacji Make bywają brudne ("...id=#1852", "...id=''1683").
  function cleanFormLink(url) {
    return String(url || '').trim().replace(/[#']/g, '');
  }

  function isSurowyOpisPoll(opis) {
    return /^\S+,\s*\d+s\s*\(from\s+\S+\s+to\s+\S+\)$/i.test(String(opis || '').trim());
  }

  // ── Drobne komponenty ─────────────────────────────────────────────────────

  function buildCopyButton(getValue, className) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className || 'lk-copy-btn';
    btn.title = 'Kopiuj';
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const value = typeof getValue === 'function' ? getValue() : getValue;
      if (!value) return;
      navigator.clipboard.writeText(value).then(() => {
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 1200);
      });
    });
    return btn;
  }

  // Dyktowanie: MediaRecorder → POST /api/transcribe (OpenAI); nagranie
  // nigdzie nie zostaje (wzorzec z Backlogu).
  function attachDictation(btn, textarea, setMsg, apiBase) {
    let recorder = null;
    let chunks = [];
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (recorder && recorder.state === 'recording') {
        recorder.stop();
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
        recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        chunks = [];
        recorder.addEventListener('dataavailable', (ev) => {
          if (ev.data.size) chunks.push(ev.data);
        });
        recorder.addEventListener('stop', async () => {
          stream.getTracks().forEach((t) => t.stop());
          btn.classList.remove('recording');
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
          if (!blob.size) return;
          setMsg('Transkrybuję…');
          try {
            const res = await fetch(`${apiBase}/api/transcribe`, {
              method: 'POST',
              headers: { 'Content-Type': blob.type || 'audio/webm' },
              body: blob,
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.error || `Błąd ${res.status}`);
            if (body.text) {
              const existing = textarea.value.replace(/\s+$/, '');
              textarea.value = existing ? `${existing} ${body.text}` : body.text;
              textarea.focus();
            }
            setMsg('');
          } catch (err) {
            setMsg(err.message, true);
          }
        });
        recorder.start();
        btn.classList.add('recording');
        setMsg('Nagrywam — kliknij mikrofon ponownie, żeby zakończyć.');
      } catch (err) {
        setMsg(`Brak dostępu do mikrofonu: ${err.message}`, true);
      }
    });
  }

  // ── Definicje pól (1:1 z CRM) ─────────────────────────────────────────────

  // "Kontakt" — zawsze widoczne. Ilość telefonów/Skontaktowane dziś READ-ONLY:
  // liczone live z "Log zmian" po stronie serwera, nie z legacy skażonej
  // kolumny "Ilość telefonów".
  const KONTAKT_FIELDS = [
    { col: 'Ostatni kontakt', label: 'Ostatni kontakt', formatDisplay: (v) => formatDateOnly(v, true) },
    { col: '_ilosc_polaczen', label: 'Ilość telefonów', readonly: true },
    { col: 'Temperatura', label: 'Temperatura' },
    { col: '_kontakt_dzisiaj', label: 'Skontaktowane dziś', readonly: true, bool: true },
    { col: 'Data Feedbacku', label: 'Data feedbacku', datePicker: true },
    { col: 'Email', label: 'Email', wide: true, copy: true },
    // Ręczna notatka handlowca — zlepek rozmów żyje w "Historia rozmów",
    // a "Podsumowanie AI" (Ocena AI kontaktu) na górze karty.
    { col: 'Notes', label: 'Notatka', textarea: true, wide: true },
  ];

  // "Transakcja" — pola tożsamościowe + wycena/oferta; etykiety zależne od
  // _ma_wycene (1:1 z logiką ma_wycene w Backlogu).
  const TRANSAKCJA_FIELDS = [
    { col: 'Date', label: 'Data dodania', formatDisplay: (v) => formatDateOnly(v) },
    { col: 'Name', label: 'Imię' },
    { col: 'ID Leada', label: 'ID Leada', readonly: true },
    { col: 'ID', label: 'ID wyceny', readonly: true, hideWhenEmpty: true },
    { col: 'Data wysłania wyceny', label: (l) => (l._ma_wycene ? 'Data wyceny' : 'Data przedstawienia oferty'), formatDisplay: (v) => formatDateOnly(v) },
    { col: 'Kwota wyceny', label: (l) => (l._ma_wycene ? 'Kwota' : 'Proponowana kwota'), number: true },
    // Produkty/link chowane, gdy lead ma realną Wycenę — kompletna wersja
    // jest wtedy w sekcji "Wycena" na dole karty.
    { col: 'Produkty z wyceny', label: 'Produkty złapane z rozmowy', textarea: true, wide: true, collapsible: true, hide: (l) => l._ma_wycene },
    { col: 'Link do formularza', label: 'Link do formularza', wide: true, link: true, hideWhenEmpty: true, hide: (l) => l._ma_wycene },
    { col: 'Źródło', label: 'Źródło', readonly: true, hideWhenEmpty: true },
    { col: 'ad_name', label: 'Reklama', readonly: true, hideWhenEmpty: true },
    { col: 'Facebook Leads ID', label: 'Facebook Leads ID', readonly: true, hideWhenEmpty: true },
  ];

  // ── Zapis pojedynczego pola ───────────────────────────────────────────────

  async function saveField(apiBase, lead, field, value) {
    const res = await fetch(`${apiBase}/api/leady/${lead['ID Leada']}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field, value }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Błąd zapisu');
    lead[field] = value;
  }

  // ── Pojedyncze pole siatki ────────────────────────────────────────────────

  function buildField(lead, spec, ctx) {
    if (spec.hide && spec.hide(lead)) return null;

    const labelText = typeof spec.label === 'function' ? spec.label(lead) : spec.label;

    if (spec.link) {
      const wrap = document.createElement('div');
      wrap.className = 'lk-field' + (spec.wide ? ' wide' : '');
      const label = document.createElement('span');
      label.className = 'lk-label';
      label.textContent = labelText;
      const value = document.createElement('span');
      value.className = 'lk-value readonly';
      const url = cleanFormLink(lead[spec.col]);
      if (url) {
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = url;
        a.addEventListener('click', (e) => e.stopPropagation());
        value.appendChild(a);
      } else {
        value.textContent = '—';
      }
      wrap.append(label, value);
      return wrap;
    }

    if (spec.bool || spec.readonly) {
      const wrap = document.createElement('div');
      wrap.className = 'lk-field' + (spec.wide ? ' wide' : '');
      if (spec.hideWhenEmpty && !lead[spec.col]) wrap.style.display = 'none';
      const label = document.createElement('span');
      label.className = 'lk-label';
      label.textContent = labelText;
      const value = document.createElement('span');
      value.className = 'lk-value readonly';
      if (spec.bool) {
        value.textContent = lead[spec.col] ? 'Tak' : 'Nie';
      } else {
        value.textContent = lead[spec.col] === null || lead[spec.col] === undefined || lead[spec.col] === ''
          ? '—'
          : lead[spec.col];
      }
      wrap.append(label, value);
      return wrap;
    }

    // Natywny kalendarzyk dla pól dat — zapis na 'change', nie blur (natywne
    // date inputy nie odpalają blur niezawodnie po wyborze z kalendarza).
    if (spec.datePicker) {
      const wrap = document.createElement('div');
      wrap.className = 'lk-field' + (spec.wide ? ' wide' : '');
      const label = document.createElement('span');
      label.className = 'lk-label';
      label.textContent = labelText;
      const input = document.createElement('input');
      input.type = 'date';
      input.className = 'lk-value';
      let baselineIso = toIsoDateValue(lead[spec.col]);
      input.value = baselineIso;
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('change', async () => {
        if (input.value === baselineIso) return;
        const stored = fromIsoDateValue(input.value);
        try {
          await saveField(ctx.apiBase, lead, spec.col, stored);
          baselineIso = input.value;
          if (spec.col === 'Data Feedbacku' && ctx.onFeedbackDate) ctx.onFeedbackDate(stored);
        } catch (err) {
          input.value = baselineIso;
          alert(`Błąd zapisu pola "${labelText}": ${err.message}`);
        }
      });
      // Zewnętrzne aktualizacje (np. data feedbacku wyciągnięta z notatki).
      if (spec.col === 'Data Feedbacku') {
        ctx.feedbackSetters.push((stored) => {
          baselineIso = toIsoDateValue(stored);
          input.value = baselineIso;
        });
      }
      wrap.append(label, input);
      return wrap;
    }

    // Baseline = sformatowana wartość pokazana w polu; zapis leci tylko gdy
    // input.value faktycznie od niej odbiegnie — samo formatowanie nigdy nie
    // wywoła zapisu.
    let baseline = lead[spec.col] === null || lead[spec.col] === undefined ? '' : String(lead[spec.col]);
    if (spec.formatDisplay) baseline = spec.formatDisplay(baseline);

    const input = document.createElement(spec.textarea ? 'textarea' : 'input');
    input.className = spec.collapsible ? '' : 'lk-value' + (spec.copy ? ' with-copy' : '');
    if (!spec.textarea) input.type = spec.number ? 'number' : 'text';
    input.placeholder = '—';
    input.value = baseline;
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('blur', async () => {
      const raw = input.value;
      if (raw === baseline) return;
      const value = spec.number ? (raw === '' ? null : Number(raw)) : raw;
      try {
        await saveField(ctx.apiBase, lead, spec.col, value);
        baseline = raw;
      } catch (err) {
        input.value = baseline;
        alert(`Błąd zapisu pola "${labelText}": ${err.message}`);
      }
    });

    if (spec.collapsible) {
      const details = document.createElement('details');
      details.className = 'lk-field-collapse lk-field' + (spec.wide ? ' wide' : '');
      const summary = document.createElement('summary');
      summary.addEventListener('click', (e) => e.stopPropagation());
      const label = document.createElement('span');
      label.className = 'lk-label';
      label.textContent = labelText;
      const preview = document.createElement('span');
      preview.className = 'lk-preview';
      preview.textContent = truncatePreview(lead[spec.col], 90);
      summary.append(label, preview);
      input.className = 'lk-value';
      details.append(summary, input);
      return details;
    }

    const wrap = document.createElement('div');
    wrap.className = 'lk-field' + (spec.wide ? ' wide' : '');
    const label = document.createElement('span');
    label.className = 'lk-label';
    label.textContent = labelText;
    wrap.appendChild(label);

    if (spec.copy) {
      const copyWrap = document.createElement('div');
      copyWrap.className = 'lk-value with-copy';
      copyWrap.appendChild(input);
      copyWrap.appendChild(buildCopyButton(() => input.value));
      wrap.appendChild(copyWrap);
      return wrap;
    }

    wrap.appendChild(input);
    return wrap;
  }

  // ── Historia rozmów ───────────────────────────────────────────────────────

  // Kolumna "Historia rozmów": jeden wpis na linię, najnowsze na górze,
  // "DD.MM.YYYY[ HH:mm] - treść" (pisze ją webhook Zadarmy + notatki).
  function parseHistoriaRozmow(raw) {
    return String(raw || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line) => {
        const m = /^(\d{1,2}\.\d{1,2}\.\d{4})(?: +(\d{1,2}:\d{2}))? *[-–—] *([\s\S]*)$/.exec(line);
        if (!m) return { data: null, czas: null, tresc: line };
        return { data: m[1], czas: m[2] || null, tresc: m[3].trim() };
      });
  }

  function renderHistoriaFromColumn(entries, container) {
    const list = document.createElement('div');
    list.className = 'lk-historia-rozmow-list';
    entries.forEach((row) => {
      const nieodebrane = /^nie odebrał/i.test(row.tresc);
      const entry = document.createElement('div');
      entry.className = 'lk-historia-rozmow-entry' + (nieodebrane ? ' nieodebrane' : '');
      const head = document.createElement('div');
      head.className = 'lk-historia-rozmow-head';
      const when = document.createElement('span');
      when.className = 'lk-historia-rozmow-data';
      when.textContent = row.data ? `${row.data}${row.czas ? ` ${row.czas}` : ''}` : '—';
      head.appendChild(when);
      const note = document.createElement('div');
      note.className = 'lk-historia-rozmow-notatka';
      if (nieodebrane) {
        note.textContent = row.tresc;
        note.classList.add('brak-tresci');
      } else {
        note.textContent = row.tresc || 'Odebrane — brak zapisanego podsumowania (starszy wpis)';
        if (!row.tresc) note.classList.add('brak-tresci');
      }
      entry.append(head, note);
      list.appendChild(entry);
    });
    container.innerHTML = '';
    container.appendChild(list);
  }

  async function loadHistoria(apiBase, lead, container) {
    // Główne źródło: kolumna "Historia rozmów" (kompletna). Fallback na Log
    // zmian tylko, gdy kolumna pusta, a licznik twierdzi, że rozmowy były.
    const entries = parseHistoriaRozmow(lead['Historia rozmów']);
    if (entries.length) {
      renderHistoriaFromColumn(entries, container);
      return;
    }
    container.innerHTML = '<p class="lk-empty-note">Wczytywanie…</p>';
    try {
      const res = await fetch(`${apiBase}/api/leady/${lead._telefon_digits}/historia`);
      const body = await res.json();
      const rows = body.data || [];
      if (!rows.length) {
        container.innerHTML = '<p class="lk-empty-note">Brak zarejestrowanych rozmów.</p>';
        return;
      }
      const list = document.createElement('div');
      list.className = 'lk-historia-rozmow-list';
      // Najnowsze na górze (endpoint sortuje rosnąco dla innych konsumentów).
      [...rows].reverse().forEach((row) => {
        const jestNotatka = row.zrodlo === 'notatka_handlowca' || row.zrodlo === 'manual_akcja';
        const nieodebrane = row.disposition === 'no_answer';
        const entry = document.createElement('div');
        entry.className = 'lk-historia-rozmow-entry' + (nieodebrane ? ' nieodebrane' : '');
        const head = document.createElement('div');
        head.className = 'lk-historia-rozmow-head';
        const when = document.createElement('span');
        when.className = 'lk-historia-rozmow-data';
        when.textContent = formatRelativeDateTime(row.data_zmiany);
        head.appendChild(when);
        if (jestNotatka) {
          const tag = document.createElement('span');
          tag.className = 'lk-historia-rozmow-czas';
          tag.textContent = row.zrodlo === 'manual_akcja'
            ? 'ręczna zmiana akcji'
            : `notatka${row.handlowiec ? ` · ${row.handlowiec}` : ''}`;
          head.appendChild(tag);
        } else if (row.czas_trwania_s) {
          const czas = document.createElement('span');
          czas.className = 'lk-historia-rozmow-czas';
          czas.textContent = formatDurationS(row.czas_trwania_s);
          head.appendChild(czas);
        }
        const note = document.createElement('div');
        note.className = 'lk-historia-rozmow-notatka';
        const hasRealOpis = row.opis && !isSurowyOpisPoll(row.opis);
        if (hasRealOpis) {
          note.textContent = row.opis;
        } else {
          note.textContent = nieodebrane ? 'Nieodebrane' : 'Odebrane — brak zapisanego podsumowania (starszy wpis)';
          note.classList.add('brak-tresci');
        }
        entry.append(head, note);
        list.appendChild(entry);
      });
      container.innerHTML = '';
      container.appendChild(list);
    } catch (err) {
      container.innerHTML = `<p class="lk-empty-note">Błąd wczytywania: ${err.message}</p>`;
    }
  }

  // ── Wycena ────────────────────────────────────────────────────────────────

  async function loadWycena(apiBase, lead, container) {
    container.innerHTML = '<p class="lk-empty-note">Wczytywanie…</p>';
    try {
      const res = await fetch(`${apiBase}/api/leady/${lead._telefon_digits}/wycena`);
      const body = await res.json();
      const wycena = body.data;
      if (!wycena) {
        container.innerHTML = '<p class="lk-empty-note">Brak dopasowanej wyceny.</p>';
        return;
      }
      container.innerHTML = '';
      const meta = document.createElement('div');
      meta.className = 'lk-wycena-meta';
      [
        ['ID', wycena['ID']],
        ['Status', wycena['Status']],
        ['Kwota', wycena['Kwota']],
        ['Komentarz', wycena['Komentarz']],
      ].forEach(([label, value]) => {
        const div = document.createElement('div');
        div.innerHTML = `<span class="lk-label">${label}:</span>${value ?? '—'}`;
        meta.appendChild(div);
      });
      if (wycena['Link do formularza']) {
        const link = document.createElement('a');
        link.href = cleanFormLink(wycena['Link do formularza']);
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'Link do formularza wyceny →';
        meta.appendChild(link);
      }
      container.appendChild(meta);

      const produkty = Array.isArray(wycena.produkty_json) ? wycena.produkty_json : [];
      if (produkty.length) {
        const table = document.createElement('table');
        table.className = 'lk-produkty';
        table.innerHTML = `
          <thead><tr><th>Nazwa</th><th>SKU</th><th>Ilość</th><th>Jedn.</th><th>Cena</th><th>VAT</th></tr></thead>
          <tbody></tbody>
        `;
        const tbody = table.querySelector('tbody');
        produkty.forEach((p) => {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td>${p.name ?? ''}</td>
            <td>${p.SKU ?? ''}</td>
            <td>${p.quantity ?? ''}</td>
            <td>${p.unit ?? ''}</td>
            <td>${p.price ?? ''}</td>
            <td>${p.VAT ?? ''}</td>
          `;
          tbody.appendChild(tr);
        });
        container.appendChild(table);
      }
    } catch (err) {
      container.innerHTML = `<p class="lk-empty-note">Błąd wczytywania: ${err.message}</p>`;
    }
  }

  function buildNestedDetails(titleText, loader) {
    const details = document.createElement('details');
    details.className = 'lk-historia-rozmow';
    const summary = document.createElement('summary');
    summary.textContent = titleText;
    const body = document.createElement('div');
    details.append(summary, body);

    let loaded = false;
    details.addEventListener('toggle', () => {
      if (details.open && !loaded) {
        loaded = true;
        loader(body);
      }
    });
    return details;
  }

  // ── Cała karta ────────────────────────────────────────────────────────────

  // opts:
  //   apiBase        — prefiks appki ('' lokalnie, '/crm' / '/backlog-b2c' na Vercelu)
  //   hostDetails    — zewnętrzny <details> leada; przy otwarciu auto-rozwija Historię
  //   onAkcjaChange  — (telefonDigits, {akcja,termin,owner}|null) po każdej zmianie
  //                    akcji z karty (edycja, ptaszek, notatka) — Backlog
  //                    aktualizuje tym pigułki na zwiniętych case'ach
  //   onFeedbackDate — (stored "DD.MM.YYYY") po zmianie daty feedbacku —
  //                    host aktualizuje swój nagłówek wiersza
  // Zwraca { el, setAkcja } — setAkcja pozwala hostowi wepchnąć zewnętrzną
  // zmianę akcji (np. edycję z pigułki) do już wyrenderowanej karty.
  function buildBody(lead, opts = {}) {
    const apiBase = opts.apiBase || '';
    const digits = lead._telefon_digits || '';
    const ctx = { apiBase, onFeedbackDate: opts.onFeedbackDate, feedbackSetters: [] };

    const body = document.createElement('div');
    body.className = 'lk-lead-body';

    // ── Najbliższa akcja (z ptaszkiem "zrobione dziś") ──
    let currentAkcja = {
      akcja: lead['Najbliższa akcja'] || '',
      termin: lead['Najbliższa akcja termin'] || '',
      owner: lead['Najbliższa akcja owner'] || '',
    };

    const akcjaWrap = document.createElement('div');
    akcjaWrap.className = 'lk-opis-wrap lk-akcja-wrap';
    const akcjaLabel = document.createElement('span');
    akcjaLabel.className = 'lk-opis-label';
    const akcjaValue = document.createElement('textarea');
    akcjaValue.className = 'lk-opis-value';
    akcjaValue.placeholder = '—';
    akcjaValue.rows = 1;
    const akcjaDone = document.createElement('button');
    akcjaDone.type = 'button';
    akcjaDone.className = 'lk-akcja-done';
    akcjaDone.textContent = '✓';
    akcjaDone.title = 'Zrobione dziś — odhacz akcję';

    const renderAkcjaUi = () => {
      const meta = [currentAkcja.termin, currentAkcja.owner].filter(Boolean).join(' · ');
      akcjaLabel.textContent = 'Najbliższa akcja' + (meta ? ` · ${meta}` : '');
      akcjaValue.value = currentAkcja.akcja;
      akcjaDone.classList.toggle('visible', Boolean(currentAkcja.akcja));
    };
    renderAkcjaUi();

    const applyAkcjaLocally = (a) => {
      currentAkcja = a && a.akcja
        ? { akcja: a.akcja, termin: a.termin || '', owner: a.owner || '' }
        : { akcja: '', termin: '', owner: '' };
      lead['Najbliższa akcja'] = currentAkcja.akcja || null;
      lead['Najbliższa akcja termin'] = currentAkcja.termin || null;
      lead['Najbliższa akcja owner'] = currentAkcja.owner || null;
      renderAkcjaUi();
    };

    async function postAkcja(payload) {
      const res = await fetch(`${apiBase}/api/leady/akcja`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telefon: digits, ...payload }),
      });
      const resBody = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(resBody.error || `Błąd ${res.status}`);
      return resBody;
    }

    akcjaValue.addEventListener('click', (e) => e.stopPropagation());
    akcjaValue.addEventListener('blur', async () => {
      const val = akcjaValue.value.trim();
      if (val === currentAkcja.akcja.trim()) return;
      try {
        // Termin zostaje z dotychczasowej akcji — ręczna edycja zmienia
        // zwykle samą treść; kto chce podać termin, wpisuje go w treści.
        const resBody = await postAkcja({ akcja: val, termin: val && currentAkcja.akcja ? (currentAkcja.termin || '') : '' });
        applyAkcjaLocally(val ? { akcja: resBody.akcja, termin: resBody.termin, owner: resBody.owner } : null);
        if (opts.onAkcjaChange) opts.onAkcjaChange(digits, val ? { ...currentAkcja } : null);
      } catch (err) {
        akcjaValue.value = currentAkcja.akcja;
        alert(`Błąd zapisu najbliższej akcji: ${err.message}`);
      }
    });

    akcjaDone.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!currentAkcja.akcja) return;
      const zrobiona = currentAkcja.akcja;
      akcjaDone.disabled = true;
      try {
        await postAkcja({ akcja: '', wykonane: true });
        applyAkcjaLocally(null);
        if (opts.onAkcjaChange) opts.onAkcjaChange(digits, null);
        // Serwer dopisuje tę samą linię do kolumny "Historia rozmów" —
        // lokalny dopis tylko odzwierciedla to bez ponownego odczytu.
        prependHistoriaLocally(`[Akcja] Zrobione: ${zrobiona}`);
      } catch (err) {
        alert(`Nie odhaczono akcji: ${err.message}`);
      } finally {
        akcjaDone.disabled = false;
      }
    });

    akcjaWrap.append(akcjaLabel, akcjaValue, akcjaDone);

    // ── Podsumowanie AI (Ocena AI kontaktu) ──
    const opisWrap = document.createElement('div');
    opisWrap.className = 'lk-opis-wrap';
    const opisLabel = document.createElement('span');
    opisLabel.className = 'lk-opis-label';
    opisLabel.textContent = 'Podsumowanie AI';
    const opisValue = document.createElement('textarea');
    opisValue.className = 'lk-opis-value';
    opisValue.placeholder = '—';
    opisValue.value = lead['Ocena AI kontaktu'] || '';
    opisValue.rows = 2;
    opisValue.addEventListener('click', (e) => e.stopPropagation());
    opisValue.addEventListener('blur', async () => {
      if (opisValue.value === (lead['Ocena AI kontaktu'] ?? '')) return;
      try {
        await saveField(apiBase, lead, 'Ocena AI kontaktu', opisValue.value);
      } catch (err) {
        opisValue.value = lead['Ocena AI kontaktu'] || '';
        alert(`Błąd zapisu podsumowania: ${err.message}`);
      }
    });
    opisWrap.append(opisLabel, opisValue);

    // ── Historia rozmów (licznik + auto-rozwinięcie przy otwarciu leada) ──
    const historiaEntries = parseHistoriaRozmow(lead['Historia rozmów']);
    const historiaCount = historiaEntries.length || lead._ilosc_polaczen;
    const historiaLabel = 'Historia rozmów' + (historiaCount ? ` · ${historiaCount}` : '');
    const historia = buildNestedDetails(historiaLabel, (container) => loadHistoria(apiBase, lead, container));
    const autoOpenHistoria = () => {
      if (historiaCount) historia.open = true;
    };
    if (opts.hostDetails) {
      opts.hostDetails.addEventListener('toggle', () => {
        if (opts.hostDetails.open) autoOpenHistoria();
      });
      if (opts.hostDetails.open) autoOpenHistoria();
    }

    // Lokalny, natychmiastowy dopis do historii (np. świeżo zapisana notatka)
    // — bez czekania na kolejny poll/odczyt z bazy.
    function prependHistoriaLocally(tresc) {
      if (!tresc) return;
      const entry = `${nowPlDateTime()} - ${tresc}`;
      lead['Historia rozmów'] = lead['Historia rozmów'] ? `${entry}\n${lead['Historia rozmów']}` : entry;
      const container = historia.querySelector('div');
      if (container) renderHistoriaFromColumn(parseHistoriaRozmow(lead['Historia rozmów']), container);
      historia.open = true;
    }

    // ── Własny komentarz handlowca (plusik — wzorzec z Backlogu) ──
    const notatkaSekcja = document.createElement('div');
    notatkaSekcja.className = 'lk-notatka-sekcja';
    if (digits) {
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'lk-notatka-btn';
      addBtn.textContent = '+ Dodaj własny komentarz';
      const editor = document.createElement('div');
      editor.className = 'lk-notatka-editor';
      const ta = document.createElement('textarea');
      ta.placeholder = 'Napisz lub podyktuj notatkę — np. „zadzwonić za 3 dni po 15:00”';
      const actions = document.createElement('div');
      actions.className = 'lk-notatka-actions';
      const sendBtn = document.createElement('button');
      sendBtn.type = 'button';
      sendBtn.className = 'lk-notatka-send';
      sendBtn.textContent = 'Zapisz';
      const micNota = document.createElement('button');
      micNota.type = 'button';
      micNota.className = 'lk-notatka-mic';
      micNota.title = 'Dyktuj (kliknij, mów, kliknij ponownie)';
      micNota.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z"/><path d="M19 11a1 1 0 0 0-2 0 5 5 0 0 1-10 0 1 1 0 0 0-2 0 7 7 0 0 0 6 6.92V20H9a1 1 0 0 0 0 2h6a1 1 0 0 0 0-2h-2v-2.08A7 7 0 0 0 19 11z"/></svg>';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'lk-notatka-cancel';
      cancelBtn.textContent = 'Anuluj';
      const msg = document.createElement('span');
      msg.className = 'lk-notatka-msg';
      const setMsg = (text, isErr) => {
        msg.textContent = text || '';
        msg.classList.toggle('err', Boolean(isErr));
      };
      attachDictation(micNota, ta, setMsg, apiBase);
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        addBtn.style.display = 'none';
        editor.classList.add('open');
        ta.focus();
      });
      cancelBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        editor.classList.remove('open');
        addBtn.style.display = '';
        setMsg('');
      });
      ta.addEventListener('click', (e) => e.stopPropagation());
      sendBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const tresc = ta.value.trim();
        if (!tresc) {
          setMsg('Pusta notatka', true);
          return;
        }
        sendBtn.disabled = micNota.disabled = cancelBtn.disabled = true;
        setMsg('Zapisuję…');
        try {
          const res = await fetch(`${apiBase}/api/leady/notatka`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ telefon: digits, tresc }),
          });
          const resBody = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(resBody.error || `Błąd ${res.status}`);
          ta.value = '';
          editor.classList.remove('open');
          addBtn.style.display = '';
          setMsg('');
          if (resBody.akcja) {
            applyAkcjaLocally(resBody.akcja);
            if (opts.onAkcjaChange) opts.onAkcjaChange(digits, { ...currentAkcja });
          }
          if (resBody.data_feedbacku) {
            lead['Data Feedbacku'] = resBody.data_feedbacku;
            ctx.feedbackSetters.forEach((fn) => fn(resBody.data_feedbacku));
            if (opts.onFeedbackDate) opts.onFeedbackDate(resBody.data_feedbacku);
          }
          prependHistoriaLocally(`[Notatka] ${tresc}`);
        } catch (err) {
          setMsg(`Nie zapisano: ${err.message}`, true);
        } finally {
          sendBtn.disabled = micNota.disabled = cancelBtn.disabled = false;
        }
      });
      actions.append(sendBtn, micNota, cancelBtn, msg);
      editor.append(ta, actions);
      notatkaSekcja.append(addBtn, editor);
    }

    // ── Siatki Kontakt / Transakcja ──
    const kontaktGrid = document.createElement('div');
    kontaktGrid.className = 'lk-field-grid';
    KONTAKT_FIELDS.forEach((spec) => {
      const el = buildField(lead, spec, ctx);
      if (el) kontaktGrid.appendChild(el);
    });

    const transakcjaGrid = document.createElement('div');
    transakcjaGrid.className = 'lk-field-grid';
    TRANSAKCJA_FIELDS.forEach((spec) => {
      const el = buildField(lead, spec, ctx);
      if (el) transakcjaGrid.appendChild(el);
    });

    if (digits) body.appendChild(notatkaSekcja);
    body.append(akcjaWrap, opisWrap, historia, kontaktGrid, transakcjaGrid);

    if (lead._ma_wycene) {
      const wycena = buildNestedDetails('Wycena', (container) => loadWycena(apiBase, lead, container));
      body.appendChild(wycena);
    }

    return {
      el: body,
      // Zewnętrzna zmiana akcji (edycja z pigułki w Backlogu) → odśwież kartę,
      // chyba że użytkownik właśnie edytuje pole akcji.
      setAkcja: (a) => {
        if (document.activeElement === akcjaValue) return;
        applyAkcjaLocally(a);
      },
    };
  }

  return {
    buildBody,
    saveField,
    utils: {
      parseAnyDate,
      formatDateOnly,
      formatPlDateTime,
      formatRelativeDateTime,
      toIsoDateValue,
      fromIsoDateValue,
      isOverdue,
      parseTerminAkcji,
      isOverdueTermin,
      truncatePreview,
      cleanFormLink,
      buildCopyButton,
    },
  };
})();
