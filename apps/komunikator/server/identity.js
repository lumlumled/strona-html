// ── Tożsamość klienta Komunikatora ──────────────────────────────────────────
// Jedno miejsce, w którym system decyduje "czyj to kontakt": tworzenie
// klienta LL-XXXXX przy pierwszym zdarzeniu, dopasowanie po twardych
// identyfikatorach (fb/ig/wa/phone/email — NIGDY po imieniu ani treści),
// wzbogacanie profilu o nowe identyfikatory i bezpiecznik scalania: konflikt
// (identyfikator należy do innego klienta) nie scala automatycznie, tylko
// zwraca konflikt, z którego webhook robi kom_merge_proposals.
//
// Moduł jest czystą logiką nad wstrzykniętym klientem Supabase (db) — dzięki
// temu testuje się na atrapie bez sieci (identity.test.js).

// Normalizacja: jedna postać identyfikatora w bazie, żeby unique(type,value)
// faktycznie łapał duplikaty. Telefon = same cyfry z prefiksem kraju (48...),
// email = lowercase; ID platformy Meta (fb/ig/wa, np. IGSID/PSID) = surowy string.
function normalize(type, value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (type === 'phone') {
    let digits = s.replace(/\D/g, '');
    // 00-prefiks międzynarodowy → bez zer; 9 cyfr = polski numer bez prefiksu.
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.length === 9) digits = `48${digits}`;
    return digits;
  }
  if (type === 'email') return s.toLowerCase();
  return s;
}

const IDENTITY_TYPES = new Set(['fb', 'ig', 'wa', 'tt', 'phone', 'email']);

// Wyłuskuje twarde identyfikatory (email, telefon) z treści wiadomości —
// klient z Messengera/IG często podaje mail albo numer wprost w rozmowie
// ("mój mail to ...", "tel 604 650 590"), a kanał daje tylko fb/ig id. Dzięki
// temu kontakt zyskuje email/telefon i dopina się do wyceny/leada.
//
// KONSERWATYWNIE dla telefonu, żeby nie łapać losowych 9-cyfrowych ciągów
// (numery zamówień, ilości): akceptujemy numer tylko z wyraźnym sygnałem —
// prefiks +48/48, słowo tel/nr/numer/telefon/kom, albo format grupowany
// (3-3-3 z separatorami). Email jest jednoznaczny. Zwraca { emails, phones }
// (telefony znormalizowane do 48XXXXXXXXX, maile lowercase).
function extractContacts(text) {
  const s = String(text || '');
  const emails = new Set();
  const phones = new Set();

  const emailRe = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  let m;
  while ((m = emailRe.exec(s))) emails.add(m[0].toLowerCase());

  // Grupa 1: sygnał telefonu (prefiks 48 lub słowo tel/telefon/kom — NIE "nr"
  // ani "numer": to bywa numer zamówienia); grupa 2: ciąg cyfr numeru.
  const phoneRe = /(\+?48|telefon|tel\.?|kom[oó]rka|kom\.?)?[\s:._-]*((?:\d[\s.-]?){8}\d)/gi;
  while ((m = phoneRe.exec(s))) {
    const signal = Boolean(m[1]);
    const raw = m[2].trim();
    const grouped = /^\d{3}[\s.-]\d{3}[\s.-]\d{3}$/.test(raw);
    if (!signal && !grouped) continue;          // bez sygnału i bez formatu → pomiń
    let d = raw.replace(/\D/g, '');
    if (d.length === 11 && d.startsWith('48')) d = d.slice(2);
    if (d.length !== 9) continue;
    phones.add(`48${d}`);
  }
  return { emails: [...emails], phones: [...phones] };
}

function assertType(type) {
  if (!IDENTITY_TYPES.has(type)) throw new Error(`Nieznany typ tożsamości: ${type}`);
}

async function findIdentity(db, type, value) {
  const { data, error } = await db
    .from('kom_customer_identities')
    .select('*')
    .eq('type', type)
    .eq('value', value)
    .limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

// Podąża za łańcuchem merged_into do "żywego" klienta — po scaleniu stare
// tożsamości mogą jeszcze wskazywać przegrany rekord.
async function loadCustomer(db, customerId) {
  let id = customerId;
  for (let hop = 0; hop < 5; hop += 1) {
    const { data, error } = await db.from('kom_customers').select('*').eq('id', id).limit(1);
    if (error) throw error;
    const customer = data && data[0];
    if (!customer) return null;
    if (!customer.merged_into) return customer;
    id = customer.merged_into;
  }
  throw new Error('Cykl merged_into w kom_customers');
}

// Zwraca { customer, created } — znajduje klienta po identyfikatorze albo
// tworzy nowego z tym jednym identyfikatorem (pierwsze zdarzenie z kanału).
async function resolveCustomer(db, { type, value, displayName = null, source = 'webhook' }) {
  assertType(type);
  const clean = normalize(type, value);
  if (!clean) throw new Error(`Pusta wartość tożsamości ${type}`);

  const existing = await findIdentity(db, type, clean);
  if (existing) {
    const customer = await loadCustomer(db, existing.customer_id);
    if (!customer) throw new Error(`Tożsamość ${type}:${clean} wskazuje nieistniejącego klienta`);
    return { customer, created: false };
  }

  const { data: created, error: insertErr } = await db
    .from('kom_customers')
    .insert({ display_name: displayName })
    .select('*');
  if (insertErr) throw insertErr;
  const customer = created[0];

  const { error: idErr } = await db
    .from('kom_customer_identities')
    .insert({ customer_id: customer.id, type, value: clean, source, confirmed: source !== 'ai_extracted' });
  if (idErr) {
    // Wyścig dwóch webhooków o ten sam identyfikator: unique(type,value)
    // przepuścił tylko jednego — dołączamy do zwycięzcy.
    if (/duplicate|unique/i.test(idErr.message)) {
      const winner = await findIdentity(db, type, clean);
      if (winner) return { customer: await loadCustomer(db, winner.customer_id), created: false };
    }
    throw idErr;
  }
  return { customer, created: true };
}

// Dopina nowy identyfikator do istniejącego klienta.
// Zwraca: { status: 'added' } | { status: 'already_own' }
//       | { status: 'conflict', otherCustomer } ← bezpiecznik: NIE scalamy.
async function enrichCustomer(db, customerId, { type, value, source = 'ai_extracted' }) {
  assertType(type);
  const clean = normalize(type, value);
  if (!clean) throw new Error(`Pusta wartość tożsamości ${type}`);

  const existing = await findIdentity(db, type, clean);
  if (existing) {
    const owner = await loadCustomer(db, existing.customer_id);
    const self = await loadCustomer(db, customerId);
    if (owner && self && owner.id === self.id) return { status: 'already_own' };
    return { status: 'conflict', otherCustomer: owner };
  }

  const { error } = await db
    .from('kom_customer_identities')
    .insert({ customer_id: customerId, type, value: clean, source, confirmed: source !== 'ai_extracted' });
  if (error) {
    if (/duplicate|unique/i.test(error.message)) {
      // Przegrany wyścig — potraktuj jak konflikt/already_own przy ponownym odczycie.
      return enrichCustomer(db, customerId, { type, value, source });
    }
    throw error;
  }
  return { status: 'added' };
}

// Wątek kanału: istniejący (channel, external_thread_id) albo nowy.
// Zwraca { thread, created }.
async function attachThread(db, customer, channel, externalThreadId) {
  const { data: found, error: findErr } = await db
    .from('kom_threads')
    .select('*')
    .eq('channel', channel)
    .eq('external_thread_id', String(externalThreadId))
    .limit(1);
  if (findErr) throw findErr;
  if (found && found[0]) return { thread: found[0], created: false };

  const { data, error } = await db
    .from('kom_threads')
    .insert({ customer_id: customer.id, channel, external_thread_id: String(externalThreadId) })
    .select('*');
  if (error) {
    if (/duplicate|unique/i.test(error.message)) return attachThread(db, customer, channel, externalThreadId);
    throw error;
  }
  return { thread: data[0], created: true };
}

// Propozycja scalenia do potwierdzenia przez Antoniego w panelu.
async function proposeMerge(db, { threadId, candidateId, reason, evidence, confidence = null }) {
  // Nie duplikuj identycznej wiszącej propozycji (webhook może przyjść N razy).
  const { data: pending, error: findErr } = await db
    .from('kom_merge_proposals')
    .select('id')
    .eq('thread_id', threadId)
    .eq('candidate_id', candidateId)
    .eq('status', 'pending')
    .limit(1);
  if (findErr) throw findErr;
  if (pending && pending[0]) return pending[0];

  const { data, error } = await db
    .from('kom_merge_proposals')
    .insert({ thread_id: threadId, candidate_id: candidateId, reason, evidence, confidence })
    .select('*');
  if (error) throw error;
  return data[0];
}

// Scala klienta wątku w kandydata: wątki, tożsamości, pamięć i obietnice
// przechodzą na zwycięzcę; przegrany zostaje z merged_into (odwracalność
// = wiemy, co skąd przyszło). Zwraca zwycięzcę.
async function confirmMerge(db, proposalId) {
  const { data: props, error: propErr } = await db
    .from('kom_merge_proposals')
    .select('*')
    .eq('id', proposalId)
    .limit(1);
  if (propErr) throw propErr;
  const proposal = props && props[0];
  if (!proposal) throw new Error('Nie znaleziono propozycji scalenia');
  if (proposal.status !== 'pending') throw new Error('Propozycja już rozstrzygnięta');

  const { data: threads, error: thErr } = await db
    .from('kom_threads')
    .select('*')
    .eq('id', proposal.thread_id)
    .limit(1);
  if (thErr) throw thErr;
  const thread = threads && threads[0];
  if (!thread) throw new Error('Nie znaleziono wątku propozycji');

  const loser = await loadCustomer(db, thread.customer_id);
  const winner = await loadCustomer(db, proposal.candidate_id);
  if (!loser || !winner) throw new Error('Nie znaleziono klienta do scalenia');

  if (loser.id !== winner.id) {
    for (const table of ['kom_threads', 'kom_customer_identities', 'kom_memory', 'kom_commitments']) {
      const { error } = await db.from(table).update({ customer_id: winner.id }).eq('customer_id', loser.id);
      if (error) throw error;
    }
    const { error: mergeErr } = await db
      .from('kom_customers')
      .update({ merged_into: winner.id })
      .eq('id', loser.id);
    if (mergeErr) throw mergeErr;
  }

  const { error: doneErr } = await db
    .from('kom_merge_proposals')
    .update({ status: 'confirmed', decided_at: new Date().toISOString() })
    .eq('id', proposalId);
  if (doneErr) throw doneErr;
  return winner;
}

async function rejectMerge(db, proposalId) {
  const { error } = await db
    .from('kom_merge_proposals')
    .update({ status: 'rejected', decided_at: new Date().toISOString() })
    .eq('id', proposalId)
    .eq('status', 'pending');
  if (error) throw error;
}

module.exports = {
  normalize,
  extractContacts,
  resolveCustomer,
  enrichCustomer,
  attachThread,
  proposeMerge,
  confirmMerge,
  rejectMerge,
  loadCustomer,
};
