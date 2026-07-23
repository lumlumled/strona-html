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

  // Wiersze "Log zmian", które NIE są rozmową telefoniczną — w osi czasu
  // renderują się jak notatka (etykieta zamiast czasu połączenia). Kopia
  // zbioru z apps/shared/server/leady-endpoints.js (NIE_TELEFON_ZRODLA) bez
  // 'facebook_lead_webhook', który ma własną etykietę "nowy lead".
  const NIE_ROZMOWA_ZRODLA = new Set(['notatka_handlowca', 'manual_akcja', 'manual_crm', 'manual_stracony', 'wycena_stracona']);

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
      const jestNotatka = NIE_ROZMOWA_ZRODLA.has(row.zrodlo);
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

  function renderList(container, items, customer, note, lead) {
    container.innerHTML = '';

    // Szybkie dodanie rozmowy (transkrypcji) — prowadzi do strony /rozmowa
    // w Backlogu z prefillowanym numerem (docs/plan-kontakt-karta-leada.md);
    // linki między panelami z LUMLUM_LINKS (działają lokalnie i na Vercelu).
    if (lead && lead._telefon_digits) {
      const actions = document.createElement('div');
      actions.className = 'lk-kontakt-actions';
      const add = document.createElement('a');
      add.className = 'lk-notatka-btn';
      const base = (window.LUMLUM_LINKS && window.LUMLUM_LINKS['backlog-b2c']) || '/backlog-b2c';
      add.href = `${base}/rozmowa?telefon=${encodeURIComponent(lead._telefon_digits)}`;
      add.textContent = '🎙 Dodaj rozmowę (transkrypcję)';
      add.addEventListener('click', (e) => e.stopPropagation());
      actions.appendChild(add);
      container.appendChild(actions);
    }

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

  async function render(apiBase, lead, container, opts = {}) {
    const utils = window.LeadKarta && window.LeadKarta.utils;
    const kartaItems = itemsZKolumny(lead, utils);

    // 1) Natychmiast: to, co karta ma pod ręką (bez czekania na sieć).
    renderList(container, kartaItems, null, 'Szukam wiadomości (mail/DM)…', lead);

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
    renderList(container, items, customer, items.length ? note : (note || 'Brak zarejestrowanego kontaktu.'), lead);

    // Composer Mail/SMS (Etapy 3-4 planu) — tylko z prawem edycji i tylko,
    // gdy endpoint zwrócił dane o wysyłce. Domyślny kanał = ostatni kanał
    // PISANY klienta (telefon nigdy — spójnie z planem follow-upów).
    if (!opts.readOnly && !komRes._error && komRes.wysylka) {
      const ostatniPisany = (komRes.messages || []).find((m) => m.channel === 'email' || m.channel === 'sms');
      const domyslny = ostatniPisany ? ostatniPisany.channel : (lead['Email'] ? 'email' : 'sms');
      container.appendChild(buildComposer(apiBase, lead, komRes.wysylka, domyslny, () => load(apiBase, lead, container, opts)));
    }
  }

  // ── Composer: mail ze skrzynki usera / SMS przez Zadarmę ──────────────────
  function buildComposer(apiBase, lead, wysylka, domyslnyKanal, onSent) {
    const box = document.createElement('div');
    box.className = 'lk-kontakt-composer';

    const tabs = document.createElement('div');
    tabs.className = 'lk-kontakt-tabs';
    const tabMail = document.createElement('button');
    tabMail.type = 'button';
    tabMail.textContent = '✉️ Mail';
    const tabSms = document.createElement('button');
    tabSms.type = 'button';
    tabSms.textContent = '📱 SMS';
    tabs.append(tabMail, tabSms);

    const info = document.createElement('div');
    info.className = 'lk-kontakt-composer-info';

    const tematInput = document.createElement('input');
    tematInput.type = 'text';
    tematInput.className = 'lk-kontakt-temat';
    tematInput.placeholder = 'Temat maila';

    const ta = document.createElement('textarea');
    ta.className = 'lk-kontakt-tresc-input';

    const actions = document.createElement('div');
    actions.className = 'lk-notatka-actions';
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'lk-notatka-send';
    send.textContent = 'Wyślij';
    const licznik = document.createElement('span');
    licznik.className = 'lk-notatka-msg';
    const msg = document.createElement('span');
    msg.className = 'lk-notatka-msg';
    actions.append(send, licznik, msg);
    const setMsg = (t, err) => { msg.textContent = t || ''; msg.classList.toggle('err', Boolean(err)); };

    let kanal = null;
    const mailMozliwy = Boolean(lead['Email']);
    const setKanal = (k) => {
      kanal = k;
      tabMail.classList.toggle('on', k === 'email');
      tabSms.classList.toggle('on', k === 'sms');
      setMsg('');
      if (k === 'email') {
        tematInput.hidden = wysylka.mail.tryb === 'watek';
        ta.placeholder = 'Treść maila…';
        if (!wysylka.mail.skrzynka) {
          info.innerHTML = '';
          info.append('Brak podpiętej skrzynki Gmail — ');
          const a = document.createElement('a');
          a.href = '/wiadomosci/api/gmail/auth';
          a.textContent = 'podepnij Gmail';
          info.appendChild(a);
          send.disabled = true;
        } else if (!mailMozliwy) {
          info.textContent = 'Lead nie ma adresu e-mail — uzupełnij pole Email na karcie.';
          send.disabled = true;
        } else {
          info.textContent = wysylka.mail.tryb === 'watek'
            ? `Odpowiedź w wątku „${wysylka.mail.temat}" · z ${wysylka.mail.skrzynka} · do ${lead['Email']}`
            : `Nowy mail z ${wysylka.mail.skrzynka} do ${lead['Email']}`;
          send.disabled = false;
        }
      } else {
        tematInput.hidden = true;
        ta.placeholder = 'Treść SMS-a…';
        if (!wysylka.sms.skonfigurowany) {
          info.textContent = 'SMS nieskonfigurowany (brak kluczy Zadarmy na serwerze).';
          send.disabled = true;
        } else {
          info.textContent = `SMS z firmowego numeru Zadarma na ${lead._telefon_formatted || lead._telefon_digits}`;
          send.disabled = false;
        }
      }
      aktualizujLicznik();
    };
    tabMail.addEventListener('click', (e) => { e.stopPropagation(); setKanal('email'); });
    tabSms.addEventListener('click', (e) => { e.stopPropagation(); setKanal('sms'); });

    // Licznik znaków SMS: GSM-7 = 160/153, z polskimi znakami (UCS-2) 70/67.
    function aktualizujLicznik() {
      if (kanal !== 'sms') { licznik.textContent = ''; return; }
      const t = ta.value;
      const gsm = /^[\x20-\x7e\n\r]*$/.test(t);
      const limit = gsm ? 160 : 70;
      const nastepne = gsm ? 153 : 67;
      const czesci = t.length <= limit ? 1 : Math.ceil(t.length / nastepne);
      licznik.textContent = `${t.length} zn. · ${czesci} SMS${gsm ? '' : ' (polskie znaki = krótsze części)'}`;
    }
    ta.addEventListener('input', aktualizujLicznik);
    ta.addEventListener('click', (e) => e.stopPropagation());
    tematInput.addEventListener('click', (e) => e.stopPropagation());

    send.addEventListener('click', async (e) => {
      e.stopPropagation();
      const tresc = ta.value.trim();
      if (!tresc) return setMsg('Pusta treść', true);
      if (kanal === 'email' && wysylka.mail.tryb === 'nowy' && !tematInput.value.trim()) {
        return setMsg('Podaj temat nowego maila', true);
      }
      send.disabled = true;
      setMsg('Wysyłam…');
      try {
        const res = await fetch(`${apiBase}/api/kontakt/${kanal === 'email' ? 'mail' : 'sms'}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lead_id: lead['ID Leada'],
            telefon: lead._telefon_digits || '',
            email: lead['Email'] || '',
            temat: tematInput.value.trim(),
            tresc,
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `Błąd ${res.status}`);
        // Serwer dopisał linię do kolumny — odśwież lokalną kopię, żeby
        // ponowny render (i licznik sekcji) nie zgubił świeżego wpisu.
        onSent();
      } catch (err) {
        setMsg(`Nie wysłano: ${err.message}`, true);
        send.disabled = false;
      }
    });

    box.append(tabs, info, tematInput, ta, actions);
    setKanal(domyslnyKanal === 'sms' ? 'sms' : 'email');
    return box;
  }

  // Publiczne wejście — z bezpiecznikiem na podwójne wywołanie (dopis
  // notatki odświeża panel i jednocześnie otwiera sekcję, która ma własny
  // lazy-loader; druga próba w trakcie pierwszej jest pomijana).
  async function load(apiBase, lead, container, opts = {}) {
    if (container._kontaktLoading) return;
    container._kontaktLoading = true;
    try {
      await render(apiBase, lead, container, opts);
    } catch (err) {
      container.innerHTML = `<p class="lk-empty-note">Błąd wczytywania: ${err.message}</p>`;
    } finally {
      container._kontaktLoading = false;
    }
  }

  return { load };
})();
