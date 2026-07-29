// ── Meta Conversions API — Conversion Leads (CRM) ────────────────────────────
// Dosyłamy do Meta postęp leada w NASZYM lejku, żeby kampania Lead Ads
// optymalizowała się pod jakość, nie pod samo wypełnienie formularza:
//   "Wycena wysłana" — lead wszedł na etap oferty (etap, pod który już
//                      optymalizuje się żywa kampania → dobre dopasowanie).
//   "Sprzedane"      — klient zapłacił (najlepszy sygnał + seed lookalike).
//
// Dopasowanie po user_data.lead_id = "Facebook Leads ID" leada (leadgen_id z
// Lead Ads). BEZ niego Meta nie sklei konwersji z reklamą — więc bez niego nie
// wysyłamy nic (lead spoza reklamy = brak czego dopasować).
//
// Spec Meta (Conversion Leads / CRM integration):
//   - action_source MUSI być "system_generated",
//   - event_name to dowolna nazwa naszego etapu, ale MUSI zgadzać się 1:1 z
//     lejkiem w Events Managerze ("Wycena wysłana" jest już wybrana w kampanii),
//   - lead_id numerycznie, wprost w user_data (NIE hashowany),
//   - em/ph (opcjonalne, wzmacniają match) — znormalizowane + SHA-256.
// Wyłącznik: brak META_CAPI_TOKEN/META_DATASET_ID albo META_CAPI_DISABLED=1.
const crypto = require('crypto');

const GRAPH_VERSION = 'v21.0';

// Nazwy etapów = stringi z lejka Meta. Env pozwala dopiąć bez zmiany kodu,
// gdyby nazwa po stronie Meta była inna niż nasz domyślny zapis.
const STAGE_WYCENA_WYSLANA = process.env.META_STAGE_WYCENA || 'Wycena wysłana';
const STAGE_SPRZEDANE = process.env.META_STAGE_SPRZEDANE || 'Sprzedane';
// Wczesny, wysokowolumenowy etap: doszło do realnej rozmowy i lead NIE jest
// odmową/złym numerem. Pod niego optymalizuje się kampania (zamiast pod rzadką
// "Wycenę wysłaną"), więc Meta ma z czego się uczyć zamiast pokazywać 0.
const STAGE_KONTAKT_JAKOSCIOWY = process.env.META_STAGE_KONTAKT || 'Kontakt jakościowy';

// Statusy leada, które NIE liczą się jako jakościowy kontakt: brak realnej
// rozmowy albo temat martwy. Wszystko poza nimi (Po pierwszym tel, Lekko
// zainteresowany, Przyszłościowy, Zadzwonić jeszcze raz, Wycena wysłana,
// Sprzedane) = dobry kontakt, który chcemy zgłosić Mecie.
const NIE_KONTAKT_JAKOSCIOWY = new Set(['Nowy', 'Nie odebrał', 'Stracony', 'Błędne dane']);
function isQualifiedContactStatus(status) {
  return Boolean(status) && !NIE_KONTAKT_JAKOSCIOWY.has(String(status).trim());
}

function enabled() {
  return Boolean(process.env.META_CAPI_TOKEN && process.env.META_DATASET_ID)
    && process.env.META_CAPI_DISABLED !== '1';
}

function sha256(value) {
  const norm = String(value == null ? '' : value).trim().toLowerCase();
  if (!norm) return null;
  return crypto.createHash('sha256').update(norm).digest('hex');
}

// Telefon dla Meta: same cyfry z kodem kraju, bez '+', bez zer wiodących. Lead
// trzyma PL 9-cyfrowy albo z 48; wycena — E.164. Normalizujemy do 48XXXXXXXXX.
function hashPhone(raw) {
  let d = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 9) d = `48${d}`;
  d = d.replace(/^0+/, '');
  return d ? crypto.createHash('sha256').update(d).digest('hex') : null;
}

// Surowy POST jednego zdarzenia do /{dataset}/events. Rzuca przy błędzie —
// wołający (notifyQuoteSent/notifyPurchase) łapią, żeby nie wywalić flow.
async function postEvent({ eventName, leadgenId, email, phone, value, currency = 'PLN', eventTime }) {
  const leadId = String(leadgenId == null ? '' : leadgenId).replace(/\D/g, '');
  if (!leadId) return { skipped: 'no-leadgen-id' };

  const user_data = { lead_id: Number(leadId) };
  const em = sha256(email); if (em) user_data.em = [em];
  const ph = hashPhone(phone); if (ph) user_data.ph = [ph];

  const custom_data = { lead_event_source: 'LumLum CRM', event_source: 'crm' };
  const v = Number(value);
  if (Number.isFinite(v) && v > 0) {
    custom_data.value = Math.round(v * 100) / 100;
    custom_data.currency = currency;
  }

  const event = {
    event_name: eventName,
    event_time: eventTime || Math.floor(Date.now() / 1000),
    action_source: 'system_generated',
    user_data,
    custom_data,
  };

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.META_DATASET_ID}/events`;
  const payload = { data: [event], access_token: process.env.META_CAPI_TOKEN };
  // Test Events (Events Manager → zakładka Testowanie): ustaw META_TEST_EVENT_CODE,
  // żeby zdarzenia szły do podglądu i NIE liczyły się do optymalizacji.
  if (process.env.META_TEST_EVENT_CODE) payload.test_event_code = process.env.META_TEST_EVENT_CODE;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw new Error(`Meta CAPI ${eventName} → ${res.status}: ${JSON.stringify(body.error || body).slice(0, 300)}`);
  }
  return { ok: true, events_received: body.events_received };
}

// Lead z "Leady B2C" po wycenie: po ID Leada (wyceny.lead_id), a gdy brak — po
// telefonie. Zwraca wiersz z Facebook Leads ID / Email / Phone number albo null.
async function leadFromWycena(db, wycena) {
  let lead = null;
  const id = Number(wycena && wycena.lead_id);
  if (Number.isFinite(id)) {
    const { data } = await db.from('Leady B2C')
      .select('"Facebook Leads ID", "Email", "Phone number"').eq('ID Leada', id).limit(1);
    lead = data && data[0];
  }
  if (!lead) {
    const digits = (wycena && (wycena.telefon_digits
      || String(wycena.telefon_e164 || '').replace(/\D/g, '').replace(/^48/, ''))) || '';
    if (digits) {
      const cands = [Number(digits), Number(`48${digits}`)].filter(Number.isFinite);
      const { data } = await db.from('Leady B2C')
        .select('"Facebook Leads ID", "Email", "Phone number"').in('Phone number', cands).limit(1);
      lead = data && data[0];
    }
  }
  return lead || null;
}

// Idempotencja: ślad w wyceny_events (raz na wycenę na etap). Zwraca true, jeśli
// dany etap już poszedł do Meta dla tej wyceny.
async function alreadySent(db, wycenaId, kind) {
  if (!wycenaId) return false;
  const { data } = await db.from('wyceny_events')
    .select('id').eq('wycena_id', wycenaId).eq('kind', kind).limit(1);
  return Boolean(data && data.length);
}

async function markSent(db, wycenaId, kind, payload) {
  if (!wycenaId) return;
  const { error } = await db.from('wyceny_events').insert({ wycena_id: wycenaId, kind, payload: payload || null });
  if (error) console.error(`Meta CAPI ślad ${kind} wyceny ${wycenaId}:`, error.message);
}

// Idempotencja na poziomie LEADA (nie wyceny): ślad w meta_lead_events, raz na
// leada na dany etap. Osobno od wyceny_events, bo "Kontakt jakościowy" pada
// jeszcze zanim istnieje jakakolwiek wycena.
async function alreadySentLead(db, leadId, kind) {
  if (leadId == null) return false;
  const { data } = await db.from('meta_lead_events')
    .select('id').eq('lead_id', leadId).eq('kind', kind).limit(1);
  return Boolean(data && data.length);
}

async function markSentLead(db, leadId, kind, payload) {
  if (leadId == null) return;
  const { error } = await db.from('meta_lead_events').insert({ lead_id: leadId, kind, payload: payload || null });
  // 23505 = unique_violation: inny równoległy webhook zdążył pierwszy — OK.
  if (error && error.code !== '23505') console.error(`Meta CAPI ślad ${kind} leada ${leadId}:`, error.message);
}

// "Wycena wysłana" — wołane z linkWycenaToLead, gdzie mamy już wiersz leada
// (z Facebook Leads ID). Best-effort, NIGDY nie rzuca.
async function notifyQuoteSent(db, lead, wycena) {
  try {
    if (!enabled()) return;
    const leadgenId = lead && lead['Facebook Leads ID'];
    if (!leadgenId) return;                          // nie z Lead Ads → nic do dopasowania
    const wycenaId = wycena && wycena.id;
    if (await alreadySent(db, wycenaId, 'meta.wycena_wyslana')) return;
    const r = await postEvent({
      eventName: STAGE_WYCENA_WYSLANA,
      leadgenId,
      email: (wycena && wycena.email) || (lead && lead.Email),
      phone: (wycena && wycena.telefon_e164) || (lead && lead['Phone number']),
    });
    if (r && r.ok) await markSent(db, wycenaId, 'meta.wycena_wyslana', { events_received: r.events_received, leadgen_id: String(leadgenId) });
  } catch (err) {
    console.error('Meta CAPI Wycena wysłana:', err.message);
  }
}

// "Sprzedane" — wołane ze wszystkich punktów paid=true pipeline. Sam dociąga
// leada z wyceny. value = kwota, którą klient realnie zapłacił. NIGDY nie rzuca.
async function notifyPurchase(db, wycena, value) {
  try {
    if (!enabled()) return;
    const wycenaId = wycena && wycena.id;
    if (await alreadySent(db, wycenaId, 'meta.sprzedane')) return;
    const lead = await leadFromWycena(db, wycena);
    const leadgenId = lead && lead['Facebook Leads ID'];
    if (!leadgenId) return;
    const r = await postEvent({
      eventName: STAGE_SPRZEDANE,
      leadgenId,
      email: (wycena && wycena.email) || (lead && lead.Email),
      phone: (wycena && wycena.telefon_e164) || (lead && lead['Phone number']),
      value,
    });
    if (r && r.ok) await markSent(db, wycenaId, 'meta.sprzedane', { events_received: r.events_received, leadgen_id: String(leadgenId), value: value == null ? null : Number(value) });
  } catch (err) {
    console.error('Meta CAPI Sprzedane:', err.message);
  }
}

// "Kontakt jakościowy" — wczesny sygnał dla Lead Ads. Wołane z webhooka Zadarmy
// i z ręcznej rozmowy, PO zapisie statusu leada, gdy: (1) była realna rozmowa,
// (2) status po rozmowie jest jakościowy (isQualifiedContactStatus), (3) lead
// pochodzi z reklamy (ma Facebook Leads ID — inaczej Meta nie ma czego
// dopasować). Raz na leada (dedup meta_lead_events). NIGDY nie rzuca.
async function notifyQualifiedContact(db, lead, { statusAfter, phone, email } = {}) {
  try {
    if (!enabled()) return;
    if (!isQualifiedContactStatus(statusAfter)) return;
    const leadgenId = lead && lead['Facebook Leads ID'];
    if (!leadgenId) return;                          // nie z Lead Ads → nic do dopasowania
    const leadId = lead && lead['ID Leada'];
    if (await alreadySentLead(db, leadId, 'meta.kontakt_jakosciowy')) return;
    const r = await postEvent({
      eventName: STAGE_KONTAKT_JAKOSCIOWY,
      leadgenId,
      email: email || (lead && lead.Email),
      phone: phone || (lead && lead['Phone number']),
    });
    if (r && r.ok) {
      await markSentLead(db, leadId, 'meta.kontakt_jakosciowy', {
        events_received: r.events_received, leadgen_id: String(leadgenId), status: statusAfter,
      });
    }
  } catch (err) {
    console.error('Meta CAPI Kontakt jakościowy:', err.message);
  }
}

module.exports = {
  notifyQuoteSent, notifyPurchase, notifyQualifiedContact, postEvent, enabled,
  isQualifiedContactStatus,
  STAGE_WYCENA_WYSLANA, STAGE_SPRZEDANE, STAGE_KONTAKT_JAKOSCIOWY,
};
