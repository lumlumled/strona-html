// ── Automat wyceny z wątku pisanego (WhatsApp/Messenger/IG) ─────────────────
// "Pełny automat" (decyzja Antoniego 2026-08-05): gdy w rozmowie padną KONKRETNE
// produkty+ilości, system sam:
//   1. znajduje leada po numerze/mailu, a jak go nie ma → tworzy realnego leada,
//   2. tworzy SZKIC wyceny dopasowany do numeru/maila (wspólny createWycena),
//   3. stempluje wątek metą auto_wycena (link+pozycje) i wrzuca notatkę
//      wewnętrzną z gotowym draftem odpowiedzi — sugestia użyje linku, a Antoni
//      wysyła jednym kliknięciem (do klienta nic nie idzie samo).
//
// Heavy AI (detekcja) NIE leci w budżecie 5 s webhooka — orchestrator woła cron
// runWorker (sweep) obok triage/media/autoreply. Kill-switch: KOM_AUTO_WYCENA=0
// wyłącza całość (domyślnie ON). Dedup: jedna wycena na numer + marker
// auto_wycena_id na wątku (nie mnożymy szkiców, nie reprocessujemy w kółko).

const { createWycena, leadPhoneCandidates, formularzLink, sumaPozycji } = require('../../shared/server/wyceny-endpoints');
const { detectWycenaFromThread } = require('./wycena-detect');

const LEADY_B2C_TABLE = 'Leady B2C';
const CHANNELS = new Set(['whatsapp', 'messenger', 'instagram']);

function enabled() {
  return process.env.KOM_AUTO_WYCENA !== '0';
}

// Format CRM = "DD.MM.YYYY" / "DD.MM.YYYY HH:mm" (jak warsawDateStr/…TimeStr w
// backlogu). NIE ISO — panel parsuje po kropkach, więc trzymamy ten sam format.
function warsawParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Warsaw', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = f.formatToParts(d).reduce((acc, x) => { acc[x.type] = x.value; return acc; }, {});
  return { y: p.year, m: p.month, d: p.day, hh: p.hour === '24' ? '00' : p.hour, mm: p.minute };
}
const warsawDate = (d) => { const p = warsawParts(d); return `${p.d}.${p.m}.${p.y}`; };
const warsawDateTime = (d) => { const p = warsawParts(d); return `${p.d}.${p.m}.${p.y} ${p.hh}:${p.mm}`; };

// Telefon (48XXXXXXXXX) + mail z tożsamości komunikatora. WhatsApp podaje numer
// z automatu, więc dla tego kanału telefon jest prawie zawsze.
async function contactFromCustomer(db, customerId) {
  const { data } = await db.from('kom_customer_identities').select('type,value').eq('customer_id', customerId);
  const ids = data || [];
  const phone = (ids.find((i) => i.type === 'phone') || {}).value || null;
  const email = (ids.find((i) => i.type === 'email') || {}).value || null;
  return { phone, email };
}

// Konserwatywne wycenienie pozycji z cennika: cena TYLKO przy pewnym dopasowaniu
// nazwy (ilike, dokładna nazwa). Reszta zostaje pusta do uzupełnienia przez
// handlowca — wolimy niedopowiedzenie niż złą cenę wysłaną klientowi.
async function priceFromCennik(db, items) {
  let allPriced = items.length > 0;
  for (const it of items) {
    if (it.price !== '' && it.price != null) continue;
    const { data } = await db.from('sku_cennik')
      .select('sku,price_brutto,unit').ilike('nazwa', it.name).limit(1);
    const hit = data && data[0];
    if (hit && hit.price_brutto != null) {
      it.price = Number(hit.price_brutto);
      if (hit.sku && !it.SKU) it.SKU = hit.sku;
      if (hit.unit && !it.unit) it.unit = hit.unit;
    } else {
      allPriced = false;
    }
  }
  return { items, allPriced };
}

// Lead po telefonie; brak → nowy realny lead (konkretna wycena = kwalifikowany
// lead, wchodzi do lejka, nie do kontakty_organic). ID Leada z sekwencji ręcznej
// (max+1, jak webhook Zadarmy). Zwraca { lead, created }.
async function findOrCreateLead(db, { phone, email, displayName }) {
  const nine = String(phone || '').replace(/\D/g, '').replace(/^48/, '');
  const cands = leadPhoneCandidates(phone);
  if (cands.length) {
    const { data } = await db.from(LEADY_B2C_TABLE)
      .select('"ID Leada","Deal stage","Phone number","Owner","Name"')
      .in('Phone number', cands).limit(1);
    if (data && data[0]) return { lead: data[0], created: false };
  }
  const { data: maxRow } = await db.from(LEADY_B2C_TABLE)
    .select('"ID Leada"').order('"ID Leada"', { ascending: false }).limit(1).single();
  const nextId = (Number(maxRow && maxRow['ID Leada']) || 0) + 1;
  const now = new Date();
  const { data: inserted, error } = await db.from(LEADY_B2C_TABLE).insert({
    'ID Leada': nextId,
    'Phone number': Number(nine) || null,
    'Name': displayName || null,
    'Email': email || null,
    'Deal stage': 'Nowy',
    'Źródło': 'WhatsApp - wykryta wycena',
    'Owner': 'Antoni',
    'Date': warsawDate(now),
    'Ostatni kontakt': warsawDateTime(now),
  }).select('"ID Leada","Deal stage","Name"').single();
  if (error) throw new Error(`Nowy lead z WhatsApp: ${error.message}`);
  return { lead: inserted, created: true };
}

// Push „Nowy lead z WhatsApp" — wzorzec 1:1 z notify-push (adminzy + env
// KOM_NOTIFY). Backlogowe notifyNewLead nie jest eksportowane, a lead tworzymy
// tutaj, więc pingujemy własnym pushem. Best-effort: nigdy nie wywala automatu.
async function notifyLeadCreated(db, { leadId, publicId, name, phone }) {
  try {
    const push = require('../../shared/server/push');
    if (!push || !push.notifyUser) return;
    const wanted = new Set(String(process.env.KOM_NOTIFY || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    const { data: users } = await db.from('app_users').select('id,name,role').eq('active', true);
    const targets = (users || []).filter((u) => u.role === 'admin'
      || wanted.has(String(u.name || '').trim().toLowerCase()));
    const url = publicId ? `/wiadomosci/?klient=${encodeURIComponent(publicId)}` : '/wiadomosci/';
    for (const u of targets) {
      await push.notifyUser(() => db, u.id, {
        title: 'Nowy lead z WhatsApp',
        body: `${name || phone || 'Klient'} - automat wykrył wycenę`,
        url,
        tag: `new-lead-${leadId}`,
      });
    }
  } catch (err) {
    console.warn('Push nowego leada (auto-wycena) nie wyszedł:', err.message);
  }
}

// Draft odpowiedzi w Twoim stylu (tylko 😊, bez długiego myślnika, numer
// 604 650 590). allPriced → dopisuje sumę; częściowa wycena → bez kwoty.
function composeDraft(pozycje, kwota, allPriced, link) {
  const lista = pozycje.map((p) => {
    const ilosc = p.unit === 'm' || /taśm/i.test(p.name) ? `${p.quantity}m` : `${p.quantity} szt`;
    return `- ${ilosc} ${p.name}`;
  }).join('\n');
  const kwotaLinia = allPriced && kwota ? `\n\nRazem: ${kwota} zł` : '';
  return `Cześć! Przygotowałem dla Ciebie wycenę 😊\n\n${lista}${kwotaLinia}\n\nSzczegóły i płatność tutaj: ${link}\n\nDaj znać, czy wszystko się zgadza. W razie pytań jestem pod 604 650 590 😊`;
}

// Czy numer ma już jakąś NIEstraconą wycenę — jeśli tak, nie dorabiamy drugiej
// (handlowiec/automat już coś przygotował). telefon_digits w `wyceny` = 9 cyfr.
async function hasWycena(db, phone) {
  const nine = String(phone || '').replace(/\D/g, '').replace(/^48/, '');
  if (!nine) return true; // brak numeru = nie ma jak dopasować/wysłać → traktuj jak "nie rób"
  const { data } = await db.from('wyceny')
    .select('id,status').eq('telefon_digits', nine).limit(5);
  return (data || []).some((w) => w.status !== 'Stracone');
}

// Pełny pipeline dla JEDNEGO wątku. Zwraca { created, reason?, wycena_id?,
// lead_id?, lead_created? }. Nie rzuca w górę — sweep łapie błędy per wątek.
async function maybeCreateWycena(db, { thread, customer }) {
  if (!enabled()) return { created: false, reason: 'disabled' };
  if (!CHANNELS.has(thread.channel)) return { created: false, reason: 'channel' };

  const { phone, email } = await contactFromCustomer(db, customer.id);
  if (!phone && !email) return { created: false, reason: 'no_contact' };
  if (await hasWycena(db, phone)) return { created: false, reason: 'existing_wycena' };

  const { pozycje, cena, analysis } = await detectWycenaFromThread(db, thread.id);
  if (!pozycje.length) return { created: false, reason: 'no_products' };

  const { items, allPriced } = await priceFromCennik(db, pozycje);
  const kwota = allPriced ? sumaPozycji(items) : null;

  const displayName = customer.display_name || null;
  const { lead, created: leadCreated } = await findOrCreateLead(db, { phone, email, displayName });

  const wycena = await createWycena(db, {
    fields: {
      telefon_e164: phone ? `+${String(phone).replace(/^\+/, '')}` : undefined,
      email: email || undefined,
      imie_nazwisko: displayName || undefined,
      items,
      kwota_proponowana_brutto: kwota != null ? kwota : undefined,
      lead_id: String(lead['ID Leada']),
    },
    source: 'komunikator-auto',
    actorName: 'Antoni',
  });

  const link = formularzLink(wycena);
  const draft = composeDraft(items, kwota, allPriced, link);

  // Stempel na wątku: sugestia dostanie link+pozycje (draft z linkiem "jednym
  // klikiem"), a marker auto_wycena_id blokuje ponowne tworzenie.
  const meta = {
    ...(thread.meta || {}),
    auto_wycena: { wycena_id: wycena.id, lead_id: String(lead['ID Leada']), link, kwota, all_priced: allPriced, draft, created_at: new Date().toISOString() },
    auto_wycena_checked_at: new Date().toISOString(),
  };
  await db.from('kom_threads').update({ meta, auto_wycena_id: wycena.id }).eq('id', thread.id);

  // Ping „nowy lead" tylko gdy realnie go utworzyliśmy (istniejący już był
  // widoczny). Wycena ma osobny push (notifyWycenaCreated w createWycena).
  if (leadCreated) {
    await notifyLeadCreated(db, { leadId: lead['ID Leada'], publicId: customer.public_id, name: displayName, phone });
  }

  // Notatka wewnętrzna: ślad w wątku + gotowy draft do skopiowania/wysłania.
  // Supabase nie rzuca na błąd DB (zwraca {error}), a builder nie ma .catch —
  // czytamy błąd z wyniku (best-effort, notatka nie może wywalić automatu).
  const { error: noteErr } = await db.from('kom_messages').insert({
    thread_id: thread.id,
    direction: 'internal',
    sent_by: 'ai_auto',
    body: `🧾 Automat utworzył szkic wyceny #${wycena.id}${leadCreated ? ` i nowego leada #${lead['ID Leada']}` : ` (lead #${lead['ID Leada']})`}.\nPozycje: ${items.map((p) => p.name).join(', ')}.${allPriced && kwota ? ` Razem ${kwota} zł.` : ' (ceny do uzupełnienia)'}\nLink dla klienta: ${link}\n\nProponowany draft odpowiedzi:\n${draft}`,
    meta: { auto_wycena: true, wycena_id: wycena.id },
  });
  if (noteErr) console.error('Notatka auto-wyceny:', noteErr.message);

  return { created: true, wycena_id: wycena.id, lead_id: String(lead['ID Leada']), lead_created: leadCreated, all_priced: allPriced, cena: cena || null };
}

// Cron: znajdź wątki z intencją wyceny, jeszcze bez auto-wyceny, i przerób
// kilka. Reprocess dozwolony, gdy jest nowsza wiadomość niż ostatni check
// (klient mógł dodać produkty po pierwszym sprawdzeniu). Bezpiecznie mały limit
// — reszta poczeka na kolejny takt.
async function sweep(db, { limit = 5 } = {}) {
  if (!enabled()) return { ok: true, skipped: 'disabled' };
  const { data: threads, error } = await db.from('kom_threads')
    .select('*')
    .eq('wycena_intent', true)
    .is('auto_wycena_id', null)
    .in('channel', [...CHANNELS])
    .order('last_message_at', { ascending: false })
    .limit(30);
  if (error) throw error;

  const identity = require('./identity');
  const result = { ok: true, created: 0, skipped: 0, failed: 0 };
  let done = 0;
  for (const thread of threads || []) {
    if (done >= limit) break;
    // Reprocess-guard: jeśli sprawdzaliśmy po ostatniej wiadomości, pomiń.
    const checkedAt = thread.meta && thread.meta.auto_wycena_checked_at;
    if (checkedAt && thread.last_message_at && new Date(checkedAt) >= new Date(thread.last_message_at)) continue;
    done += 1;
    try {
      const customer = await identity.loadCustomer(db, thread.customer_id);
      if (!customer) { result.skipped += 1; continue; }
      const out = await maybeCreateWycena(db, { thread, customer });
      if (out.created) result.created += 1;
      else {
        result.skipped += 1;
        // Zapamiętaj, że sprawdziliśmy (nie reprocessuj do nowej wiadomości).
        if (out.reason === 'no_products') {
          const meta = { ...(thread.meta || {}), auto_wycena_checked_at: new Date().toISOString() };
          const { error: markErr } = await db.from('kom_threads').update({ meta }).eq('id', thread.id);
          if (markErr) console.error(`Znacznik auto_wycena_checked_at (${thread.id}):`, markErr.message);
        }
      }
    } catch (err) {
      result.failed += 1;
      console.error(`Auto-wycena wątku ${thread.id}:`, err.message);
    }
  }
  return result;
}

module.exports = { maybeCreateWycena, sweep, composeDraft, priceFromCennik, findOrCreateLead, contactFromCustomer, hasWycena };
