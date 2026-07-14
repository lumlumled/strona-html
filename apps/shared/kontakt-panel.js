// ── Panel Kontakt — scalona oś czasu wszystkich kanałów na karcie leada ─────
// Etap 1 planu docs/plan-kontakt-karta-leada.md. Skleja w jedną listę
// (najnowsze na górze):
//   • wpisy z kolumny "Historia rozmów" (telefony/notatki/akcje — parser
//     udostępnia LeadKarta.utils), z fallbackiem na Log zmian jak dotąd,
//   • wiadomości komunikatora z GET /api/kontakt/dla-leada (mail/DM/
//     komentarze, docelowo SMS), z linkiem "Otwórz w komunikatorze".
// Ładowany PO shared/lead-card.js; gdy strona-host go nie dołączy, karta
// pokazuje starą sekcję "Historia rozmów" — panel jest czystą nakładką.
window.KontaktPanel = (() => {
  'use strict';

  const CHANNEL_LABELS = {
    email: '✉️ mail',
    sms: '📱 SMS',
    messenger: '💬 Messenger',
    instagram: '📷 Instagram',
    whatsapp: '🟢 WhatsApp',
    tiktok: '🎵 TikTok',
    phone: '📞 telefon',
    note: '📝 notatka',
  };

  // Etykieta kanału dla wpisu z kolumny "Historia rozmów" — kolumna nie ma
  // pola kanału, więc rozpoznajemy po prefiksie treści (te same prefiksy
  // piszą endpointy notatki/akcji i — od Etapu 3 — wysyłka maila/SMS-a).
  function kolumnaTag(tresc) {
    if (/^\[Notatka\]/i.test(tresc)) return '📝 notatka';
    if (/^\[Akcja\]/i.test(tresc)) return '✓ akcja';
    if (/^\[Mail→\]/i.test(tresc)) return '✉️ mail · wysłany';
    if (/^\[SMS→\]/i.test(tresc)) return '📱 SMS · wysłany';
    return '📞 telefon';
  }

  function formatDurationS(totalS) {
    const s = Number(totalS) || 0;
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return rest ? `${m}min ${rest}s` : `${m}min`;
  }

  function isSurowyOpisPoll(opis) {
    return /^\S+,\s*\d+s\s*\(from\s+\S+\s+to\s+\S+\)$/i.test(String(opis || '').trim());
  }

  // Wpisy z kolumny "Historia rozmów" → wspólny model osi czasu.
  function itemsZKolumny(lead, utils) {
    if (!utils || !utils.parseHistoriaRozmow) return [];
    return utils.parseHistoriaRozmow(lead['Historia rozmów']).map((row) => ({
      ts: row.data ? utils.parseAnyDate(`${row.data}${row.czas ? ` ${row.czas}` : ''}`) : null,
      whenText: row.data ? `${row.data}${row.czas ? ` ${row.czas}` : ''}` : '—',
      tag: kolumnaTag(row.tresc),
      body: row.tresc,
      nieodebrane: /^nie odebrał/i.test(row.tresc),
    }));
  }

  // Fallback dla starych leadów: kolumna pusta, ale Log zmian ma połączenia
  // (ta sama logika co dotychczasowa Historia rozmów w lead-card.js).
  function itemsZLogZmian(rows, utils) {
    return (rows || []).map((row) => {
      const jestNotatka = row.zrodlo === 'notatka_handlowca' || row.zrodlo === 'manual_akcja';
      const nieodebrane = row.disposition === 'no_answer';
      const tagi = [];
      if (row.zrodlo === 'facebook_lead_webhook') tagi.push('nowy lead');
      else if (jestNotatka) tagi.push(row.zrodlo === 'manual_akcja' ? '✓ akcja' : `📝 notatka${row.handlowiec ? ` · ${row.handlowiec}` : ''}`);
      else {
        tagi.push('📞 telefon');
        if (row.czas_trwania_s) tagi.push(formatDurationS(row.czas_trwania_s));
      }
      const hasRealOpis = row.opis && !isSurowyOpisPoll(row.opis);
      return {
        ts: row.data_zmiany ? new Date(row.data_zmiany) : null,
        whenText: utils ? utils.formatRelativeDateTime(row.data_zmiany) : String(row.data_zmiany || '—'),
        tag: tagi.join(' · '),
        body: hasRealOpis ? row.opis : (nieodebrane ? 'Nieodebrane' : 'Odebrane — brak zapisanego podsumowania (starszy wpis)'),
        mutedBody: !hasRealOpis,
        nieodebrane,
      };
    });
  }

  function itemsZKomunikatora(messages, utils) {
    return (messages || []).map((m) => {
      const kanal = CHANNEL_LABELS[m.channel] || m.channel;
      const kto = m.direction === 'in'
        ? 'klient'
        : (m.direction === 'internal' ? 'notatka' : (m.sent_by && m.sent_by !== 'customer' ? m.sent_by : 'wysłane'));
      return {
        ts: m.created_at ? new Date(m.created_at) : null,
        whenText: utils ? utils.formatRelativeDateTime(m.created_at) : String(m.created_at || '—'),
        tag: `${kanal}${m.kind === 'comment' ? ' · komentarz' : ''} · ${kto}`,
        body: m.body || '',
        out: m.direction === 'out',
        clamp: true,
      };
    });
  }

  function renderList(container, items, customer, note) {
    container.innerHTML = '';

    if (customer) {
      const head = document.createElement('div');
      head.className = 'lk-kontakt-head';
      const who = document.createElement('span');
      who.className = 'lk-kontakt-klient';
      who.textContent = customer.display_name
        ? `${customer.display_name} · ${customer.public_id}`
        : customer.public_id;
      const link = document.createElement('a');
      link.href = customer.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'Otwórz w komunikatorze ↗';
      link.addEventListener('click', (e) => e.stopPropagation());
      head.append(who, link);
      container.appendChild(head);
    }

    if (!items.length) {
      container.appendChild(Object.assign(document.createElement('p'), {
        className: 'lk-empty-note',
        textContent: note || 'Brak zarejestrowanego kontaktu.',
      }));
      return;
    }

    const list = document.createElement('div');
    list.className = 'lk-historia-rozmow-list';
    items.forEach((it) => {
      const entry = document.createElement('div');
      entry.className = 'lk-historia-rozmow-entry'
        + (it.nieodebrane ? ' nieodebrane' : '')
        + (it.out ? ' lk-kontakt-out' : '');
      const head = document.createElement('div');
      head.className = 'lk-historia-rozmow-head';
      const when = document.createElement('span');
      when.className = 'lk-historia-rozmow-data';
      when.textContent = it.whenText;
      head.appendChild(when);
      if (it.tag) {
        const tag = document.createElement('span');
        tag.className = 'lk-historia-rozmow-czas';
        tag.textContent = it.tag;
        head.appendChild(tag);
      }
      const body = document.createElement('div');
      body.className = 'lk-historia-rozmow-notatka';
      body.textContent = it.body || '—';
      if (!it.body || it.mutedBody) body.classList.add('brak-tresci');
      // Długie treści (maile) zwinięte do kilku linii; klik rozwija/zwija.
      if (it.clamp && it.body && it.body.length > 220) {
        body.classList.add('lk-kontakt-tresc', 'clamped');
        body.title = 'Kliknij, aby rozwinąć / zwinąć';
        body.addEventListener('click', (e) => {
          e.stopPropagation();
          body.classList.toggle('clamped');
        });
      }
      entry.append(head, body);
      list.appendChild(entry);
    });
    container.appendChild(list);

    if (note) {
      container.appendChild(Object.assign(document.createElement('p'), {
        className: 'lk-empty-note',
        textContent: note,
      }));
    }
  }

  async function render(apiBase, lead, container) {
    const utils = window.LeadKarta && window.LeadKarta.utils;
    const kartaItems = itemsZKolumny(lead, utils);

    // 1) Natychmiast: to, co karta ma pod ręką (bez czekania na sieć).
    renderList(container, kartaItems, null, 'Szukam wiadomości (mail/DM)…');

    // 2) Równolegle: komunikator + (dla starych leadów z pustą kolumną,
    //    ale z połączeniami) fallback z Log zmian.
    const params = new URLSearchParams();
    if (lead._telefon_digits) params.set('telefon', lead._telefon_digits);
    if (lead['Email']) params.set('email', String(lead['Email']).trim());
    if (lead['ID Leada'] != null) params.set('lead_id', String(lead['ID Leada']));

    const potrzebaLogZmian = !kartaItems.length && lead._ilosc_polaczen && lead._telefon_digits;
    const [komRes, logRes] = await Promise.all([
      fetch(`${apiBase}/api/kontakt/dla-leada?${params.toString()}`)
        .then(async (res) => {
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || `Błąd ${res.status}`);
          return body;
        })
        .catch((err) => ({ _error: err.message })),
      potrzebaLogZmian
        ? fetch(`${apiBase}/api/leady/${lead._telefon_digits}/historia`)
          .then((res) => res.json())
          .then((body) => body.data || [])
          .catch(() => [])
        : Promise.resolve([]),
    ]);

    let items = kartaItems.length ? kartaItems : itemsZLogZmian(logRes, utils);
    let customer = null;
    let note = null;

    if (komRes._error) {
      note = `Wiadomości z komunikatora niedostępne: ${komRes._error}`;
    } else {
      customer = (komRes.customers && komRes.customers[0]) || null;
      // Od Etapu 3 wysyłka z karty pisze i do kom_messages, i linijkę
      // [Mail→]/[SMS→] do kolumny — przy działającym komunikatorze wpis
      // z kolumny to duplikat pełnej wiadomości, więc go chowamy.
      if (customer) items = items.filter((it) => !/^(✉️ mail|📱 SMS) · wysłany$/.test(it.tag));
      items = items.concat(itemsZKomunikatora(komRes.messages, utils));
    }

    items.sort((a, b) => (b.ts ? b.ts.getTime() : 0) - (a.ts ? a.ts.getTime() : 0));
    renderList(container, items, customer, items.length ? note : (note || 'Brak zarejestrowanego kontaktu.'));
  }

  // Publiczne wejście — z bezpiecznikiem na podwójne wywołanie (dopis
  // notatki odświeża panel i jednocześnie otwiera sekcję, która ma własny
  // lazy-loader; druga próba w trakcie pierwszej jest pomijana).
  async function load(apiBase, lead, container) {
    if (container._kontaktLoading) return;
    container._kontaktLoading = true;
    try {
      await render(apiBase, lead, container);
    } catch (err) {
      container.innerHTML = `<p class="lk-empty-note">Błąd wczytywania: ${err.message}</p>`;
    } finally {
      container._kontaktLoading = false;
    }
  }

  return { load };
})();
