// Panel Kampanie (lumlum.dev/kampanie) — mądra wysyłka SMS/mail do starych
// otwartych wycen (docs/plan-kampanie.md). Kreator konwersacyjny: Antoni
// opisuje kampanię swobodnym tekstem, AI interpretuje (filtr/instrukcje),
// generuje próbkę do przeglądu; poprawki próbek UCZĄ generator (korekty),
// po akceptacji reszta generuje się i wysyła w tle (worker pg_cron, paczki
// dzienne). Wysyłka przez wspólny apps/shared/server/kontakt-send.js.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { getClient } = require('./supabase');
const { createAuth, clientPayload, panelLinks } = require('../../shared/server/auth');
const { servePushWorker, registerPushEndpoints } = require('../../shared/server/push');
const { callZadarma } = require('../../backlog-b2c/server/zadarma');
const { zbudujPopulacje, zamrozPopulacje, telefonKlucz } = require('./populacja');
const { cenaFinalna } = require('../../shared/server/wyceny-cena');
const ai = require('./ai');
const { runKampanieWorker, wyslijPaczke, wyslaneDzisTotal } = require('./worker');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Patrz apps/backlog-b2c/server/server.js — bez no-store Vercel CDN
// cache'owałby odpowiedzi po zalogowaniu i serwował je każdemu.
app.use((req, res, next) => {
  if (!req.path.startsWith('/assets/')) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});

app.get('/assets/:file', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'assets', req.params.file));
});

app.get('/shared/:file', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'shared', req.params.file));
});

const auth = createAuth({
  getClient,
  panelKey: 'kampanie',
  loginTitle: 'Kampanie',
  publicPrefixes: ['/api/cron/', '/api/webhooks/'],
});
servePushWorker(app);
auth.register(app);
registerPushEndpoints(app, { getClient });

function handleError(res, err, status = 400) {
  console.error(err);
  res.status(status).json({ error: err.message || 'Wewnętrzny błąd serwera' });
}

// Ten sam wzorzec autoryzacji crona co komunikator/backlog: Bearer CRON_SECRET
// albo ?secret= (ręczne odpalenie).
function isCronAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.authorization === `Bearer ${secret}` || req.query.secret === secret;
}

const KANALY = new Set(['sms', 'email']);
const EDYTOWALNE = ['nazwa', 'limit_dzienny', 'godzina_od', 'godzina_do', 'max_segmenty', 'bez_polskich_znakow', 'nadawca'];

// Rabat czasowy kampanii: procent (1-90) albo kwota (10-100000 zł) + data
// ważności w przyszłości. Zwraca { rabat } / { error } / {} gdy brak.
function walidujRabat(b) {
  if (!b || (!b.wartosc && !b.wazny_do)) return {};
  const typ = b.typ === 'kwota' ? 'kwota' : 'procent';
  const wartosc = Math.round(Number(b.wartosc));
  if (typ === 'procent' && !(wartosc >= 1 && wartosc <= 90)) return { error: 'Rabat procentowy: 1-90%' };
  if (typ === 'kwota' && !(wartosc >= 10 && wartosc <= 100000)) return { error: 'Rabat kwotowy: 10-100000 zł' };
  const waznyDo = String(b.wazny_do || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(waznyDo)) return { error: 'Rabat wymaga daty ważności (YYYY-MM-DD)' };
  if (Date.parse(`${waznyDo}T23:59:59`) < Date.now()) return { error: 'Data ważności rabatu już minęła' };
  return { rabat: { typ, wartosc, wazny_do: waznyDo } };
}

async function pobierzKampanie(db, id) {
  const { data, error } = await db.from('kampanie').select('*').eq('id', id).limit(1);
  if (error) throw error;
  if (!data || !data.length) return null;
  return data[0];
}

async function liczniki(db, kampaniaIds) {
  const wynik = new Map(kampaniaIds.map((id) => [id, { pending: 0, generated: 0, approved: 0, sent: 0, failed: 0, replied: 0, closed: 0, optout: 0, skipped: 0, razem: 0, podejrzani: 0 }]));
  if (!kampaniaIds.length) return wynik;
  const { data, error } = await db.from('kampanie_odbiorcy')
    .select('kampania_id, status, podejrzany').in('kampania_id', kampaniaIds);
  if (error) throw error;
  (data || []).forEach((r) => {
    const l = wynik.get(r.kampania_id);
    if (!l) return;
    l[r.status] = (l[r.status] || 0) + 1;
    l.razem++;
    // podejrzani czekający na decyzję (terminalni już nie blokują niczego)
    if (r.podejrzany && ['pending', 'generated', 'approved'].includes(r.status)) l.podejrzani++;
  });
  return wynik;
}

// ── Kreator ──────────────────────────────────────────────────────────────────

// AI czyta swobodny (dyktowany) opis i proponuje ustawienia + od razu liczy
// populację dla wyciągniętego filtru — Antoni widzi "zrozumiałem: SMS do
// wycen >60 dni, ~83 osoby na 190k zł" i może poprawić pola przed utworzeniem.
app.post('/api/kampanie/interpretuj', async (req, res) => {
  try {
    const opis = String(req.body?.opis || '').trim();
    if (opis.length < 10) return res.status(400).json({ error: 'Opisz kampanię (kilka zdań)' });
    const szablon = String(req.body?.szablon || '').trim() || null;
    const inter = await ai.interpretujBrief(opis, szablon);
    const kanal = KANALY.has(inter.kanal) ? inter.kanal : 'sms';
    const minWiekDni = Number(inter.min_wiek_dni) > 0 ? Number(inter.min_wiek_dni) : 30;
    const db = getClient();
    const pop = await zbudujPopulacje(db, { minWiekDni, kanal });
    res.json({
      interpretacja: { ...inter, kanal, min_wiek_dni: minWiekDni },
      populacja: {
        liczba: pop.liczba,
        suma_kwot: pop.suma_kwot,
        podejrzani: pop.podejrzani,
        wykluczeni: pop.wykluczeni,
        probka: pop.odbiorcy.slice(0, 20).map((o) => ({
          telefon: o.telefon, imie: o.imie, kwota: o.kontekst.kwota, wiek_dni: o.kontekst.wiek_dni,
          liczba_wycen: o.kontekst.liczba_wycen, wycena_id: o.wycena_id,
        })),
      },
    });
  } catch (err) { handleError(res, err, 502); }
});

// Podgląd populacji bez zapisu (live przy zmianie pól kreatora).
app.get('/api/kampanie/populacja', async (req, res) => {
  try {
    const db = getClient();
    const pop = await zbudujPopulacje(db, {
      minWiekDni: Number(req.query.min_wiek_dni) || 30,
      owner: String(req.query.owner || '').trim() || null,
      kanal: KANALY.has(req.query.kanal) ? req.query.kanal : 'sms',
    });
    res.json({
      liczba: pop.liczba,
      suma_kwot: pop.suma_kwot,
      podejrzani: pop.podejrzani,
      wykluczeni: pop.wykluczeni,
      probka: pop.odbiorcy.slice(0, 20).map((o) => ({
        telefon: o.telefon, imie: o.imie, kwota: o.kontekst.kwota, wiek_dni: o.kontekst.wiek_dni,
        liczba_wycen: o.kontekst.liczba_wycen, wycena_id: o.wycena_id,
      })),
    });
  } catch (err) { handleError(res, err, 502); }
});

// Wyszukiwarka odbiorców: numer telefonu (pełny lub fragment) albo imię.
// Szuka w wycenach i Leady B2C, skleja po telefonie — do ręcznego dodawania
// konkretnych osób do kampanii (w tym testu na własny numer).
app.get('/api/kampanie/szukaj', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 3) return res.json({ wyniki: [] });
    const db = getClient();
    const digits = q.replace(/\D/g, '');
    const poTelefonie = new Map();
    const dodaj = (tel, patch) => {
      const klucz = telefonKlucz(tel);
      if (klucz.length < 9) return;
      const w = poTelefonie.get(klucz) || { telefon: klucz, imie: null, lead_id: null, wycena_id: null, kwota: null, wycen_otwartych: 0 };
      poTelefonie.set(klucz, { ...w, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v != null && v !== 0)) });
    };

    if (digits.length >= 4) {
      const { data: wyc } = await db.from('wyceny')
        .select('id, imie_nazwisko, telefon_digits, status, typ, kwota_proponowana_brutto, kwota_sprzedazy_brutto, rabat24h_kwota, rabat24h_wazny_do, created_at')
        .ilike('telefon_digits', `%${digits}%`)
        .order('created_at', { ascending: false }).limit(20);
      (wyc || []).forEach((w) => dodaj(w.telefon_digits, {
        imie: String(w.imie_nazwisko || '').trim() || null,
        wycena_id: w.typ === 'WYCENA' && w.status === 'Open' ? w.id : null,
        kwota: w.typ === 'WYCENA' && w.status === 'Open' ? cenaFinalna(w) : null,
        wycen_otwartych: w.typ === 'WYCENA' && w.status === 'Open' ? 1 : 0,
      }));
      if (digits.length >= 9) {
        const { data: leady } = await db.from('Leady B2C')
          .select('"ID Leada", "Name", "Phone number"')
          .eq('Phone number', Number(telefonKlucz(digits))).limit(3);
        (leady || []).forEach((l) => dodaj(String(l['Phone number']), {
          imie: String(l['Name'] || '').trim() || null,
          lead_id: String(l['ID Leada']),
        }));
      }
    }
    if (digits.length < q.length) {
      // w zapytaniu są litery — szukamy po imieniu
      const [{ data: leady }, { data: wyc }] = await Promise.all([
        db.from('Leady B2C').select('"ID Leada", "Name", "Phone number"').ilike('Name', `%${q}%`).limit(10),
        db.from('wyceny').select('id, imie_nazwisko, telefon_digits, status, typ, kwota_proponowana_brutto, kwota_sprzedazy_brutto, rabat24h_kwota, rabat24h_wazny_do, created_at')
          .ilike('imie_nazwisko', `%${q}%`).order('created_at', { ascending: false }).limit(10),
      ]);
      (leady || []).forEach((l) => dodaj(String(l['Phone number']), {
        imie: String(l['Name'] || '').trim() || null, lead_id: String(l['ID Leada']),
      }));
      (wyc || []).forEach((w) => dodaj(w.telefon_digits, {
        imie: String(w.imie_nazwisko || '').trim() || null,
        wycena_id: w.typ === 'WYCENA' && w.status === 'Open' ? w.id : null,
        kwota: w.typ === 'WYCENA' && w.status === 'Open' ? cenaFinalna(w) : null,
      }));
    }
    res.json({ wyniki: [...poTelefonie.values()].slice(0, 12), goly_numer: digits.length >= 9 && !poTelefonie.size ? telefonKlucz(digits) : null });
  } catch (err) { handleError(res, err, 502); }
});

// Ręczny optout (globalny — telefon nie dostanie już żadnej kampanii).
app.post('/api/kampanie/optout', async (req, res) => {
  try {
    const telefon = telefonKlucz(req.body?.telefon);
    if (telefon.length < 9) return res.status(400).json({ error: 'Podaj poprawny numer' });
    const db = getClient();
    const { error } = await db.from('kampanie_optout').upsert({
      telefon, powod: String(req.body?.powod || 'recznie').slice(0, 200), zrodlo: 'panel',
    });
    if (error) throw error;
    await db.from('kampanie_odbiorcy').update({ status: 'optout', updated_at: new Date().toISOString() })
      .eq('telefon', telefon).in('status', ['pending', 'generated', 'approved']);
    res.json({ ok: true });
  } catch (err) { handleError(res, err, 502); }
});

// ── Kampanie CRUD ────────────────────────────────────────────────────────────

app.get('/api/kampanie', async (req, res) => {
  try {
    const db = getClient();
    const { data: rows, error } = await db.from('kampanie').select('*').neq('status', 'archived').order('id', { ascending: false });
    if (error) throw error;
    const stat = await liczniki(db, (rows || []).map((k) => k.id));
    res.json({ kampanie: (rows || []).map((k) => ({ ...k, liczniki: stat.get(k.id) })) });
  } catch (err) { handleError(res, err, 502); }
});

app.post('/api/kampanie', async (req, res) => {
  try {
    const b = req.body || {};
    const brief = String(b.brief || '').trim();
    if (!brief) return res.status(400).json({ error: 'Brak opisu kampanii' });
    const kanal = KANALY.has(b.kanal) ? b.kanal : 'sms';
    const db = getClient();
    const insert = {
      nazwa: String(b.nazwa || '').trim() || `Kampania ${new Date().toISOString().slice(0, 10)}`,
      kanal,
      brief,
      szablon: String(b.szablon || '').trim() || null,
      interpretacja: b.interpretacja && typeof b.interpretacja === 'object' ? b.interpretacja : null,
      nadawca: String(b.nadawca || 'lorenzo').trim().toLowerCase(),
      owner: (req.user && req.user.name) || 'Antoni',
      filtr: {
        min_wiek_dni: Number(b.filtr?.min_wiek_dni) > 0 ? Number(b.filtr.min_wiek_dni) : 30,
        owner: String(b.filtr?.owner || '').trim() || null,
      },
      limit_dzienny: Math.min(200, Math.max(1, Number(b.limit_dzienny) || 25)),
      godzina_od: Math.min(20, Math.max(6, Number(b.godzina_od) || 9)),
      godzina_do: Math.min(21, Math.max(7, Number(b.godzina_do) || 17)),
      bez_polskich_znakow: b.bez_polskich_znakow !== false,
      max_segmenty: Math.min(4, Math.max(1, Number(b.max_segmenty) || 2)),
      proba_size: Math.min(15, Math.max(3, Number(b.proba_size) || 8)),
      created_by: (req.user && req.user.name) || null,
    };
    // sekwencja follow-upów: {po_dniach, brief} albo null (wyłączona)
    if (b.sekwencja && Number(b.sekwencja.po_dniach) >= 1) {
      insert.sekwencja = {
        po_dniach: Math.min(60, Math.round(Number(b.sekwencja.po_dniach))),
        brief: String(b.sekwencja.brief || '').trim().slice(0, 500) || null,
      };
    }
    // rabat czasowy: {typ procent|kwota, wartosc, wazny_do YYYY-MM-DD} albo null
    const rabatWal = walidujRabat(b.rabat);
    if (rabatWal.error) return res.status(400).json({ error: rabatWal.error });
    if (rabatWal.rabat) insert.rabat = rabatWal.rabat;
    // tryb "wybrani ręcznie": bez filtra populacji, odbiorców dodaje się
    // pojedynczo z wyszukiwarki
    if (b.tryb === 'reczny') insert.filtr = null;
    const { data, error } = await db.from('kampanie').insert(insert).select('*');
    if (error) throw error;
    res.json({ kampania: data[0] });
  } catch (err) { handleError(res, err, 502); }
});

app.get('/api/kampanie/:id(\\d+)', async (req, res) => {
  try {
    const db = getClient();
    const kampania = await pobierzKampanie(db, req.params.id);
    if (!kampania) return res.status(404).json({ error: 'Nie ma takiej kampanii' });
    let q = db.from('kampanie_odbiorcy').select('*').eq('kampania_id', kampania.id)
      .order('sample', { ascending: false }).order('id', { ascending: true })
      .limit(Math.min(500, Number(req.query.limit) || 300));
    if (req.query.status) q = q.eq('status', String(req.query.status));
    if (req.query.podejrzany === '1') q = q.eq('podejrzany', true).in('status', ['pending', 'generated', 'approved']);
    const { data: odbiorcy, error } = await q;
    if (error) throw error;
    const stat = await liczniki(db, [kampania.id]);
    res.json({ kampania, liczniki: stat.get(kampania.id), odbiorcy: odbiorcy || [] });
  } catch (err) { handleError(res, err, 502); }
});

// Usunięcie kampanii (cascade zabiera odbiorców). Ślady zewnętrzne
// (kom_messages, Historia rozmów, history_log wycen) celowo ZOSTAJĄ -
// SMS-y naprawdę wyszły. Aktywną kampanię usunięcie po prostu przerywa.
app.delete('/api/kampanie/:id(\\d+)', async (req, res) => {
  try {
    const db = getClient();
    const kampania = await pobierzKampanie(db, req.params.id);
    if (!kampania) return res.status(404).json({ error: 'Nie ma takiej kampanii' });
    const { error } = await db.from('kampanie').delete().eq('id', kampania.id);
    if (error) throw error;
    res.json({ ok: true, usunieta: kampania.nazwa });
  } catch (err) { handleError(res, err, 502); }
});

// Zbiorcze uwagi do WSZYSTKICH wiadomości kampanii - zamiast poprawiać
// 10 próbek ręcznie, jedna uwaga trafia do reguł (korekty.reguly) i generator
// stosuje ją przy przegenerowaniu próbki oraz przy całej reszcie wysyłki.
app.post('/api/kampanie/:id(\\d+)/uwagi', async (req, res) => {
  try {
    const db = getClient();
    const kampania = await pobierzKampanie(db, req.params.id);
    if (!kampania) return res.status(404).json({ error: 'Nie ma takiej kampanii' });
    const tekst = String(req.body?.tekst || '').trim();
    if (tekst.length < 3) return res.status(400).json({ error: 'Napisz uwagę' });
    if (/[—–]/.test(tekst)) return res.status(400).json({ error: 'Zakazany myślnik — / – (używamy "-")' });
    const stare = kampania.korekty || { pary: [], reguly: [] };
    const korekty = {
      pary: stare.pary || [],
      reguly: [...(stare.reguly || []), tekst].slice(-12),
    };
    const { error } = await db.from('kampanie').update({ korekty, updated_at: new Date().toISOString() }).eq('id', kampania.id);
    if (error) throw error;
    res.json({ ok: true, korekty });
  } catch (err) { handleError(res, err, 502); }
});

app.patch('/api/kampanie/:id(\\d+)', async (req, res) => {
  try {
    const db = getClient();
    const kampania = await pobierzKampanie(db, req.params.id);
    if (!kampania) return res.status(404).json({ error: 'Nie ma takiej kampanii' });
    const patch = { updated_at: new Date().toISOString() };
    for (const pole of EDYTOWALNE) {
      if (req.body[pole] !== undefined) patch[pole] = req.body[pole];
    }
    // sanityzacja jak przy tworzeniu (edycja parametrów działa też na
    // aktywnej kampanii - worker czyta świeże wartości przy każdym przebiegu)
    if (patch.nazwa !== undefined) patch.nazwa = String(patch.nazwa || '').trim() || kampania.nazwa;
    if (patch.limit_dzienny !== undefined) patch.limit_dzienny = Math.min(200, Math.max(1, Number(patch.limit_dzienny) || 25));
    if (patch.godzina_od !== undefined) patch.godzina_od = Math.min(20, Math.max(6, Number(patch.godzina_od) || 9));
    if (patch.godzina_do !== undefined) patch.godzina_do = Math.min(21, Math.max(7, Number(patch.godzina_do) || 17));
    if (patch.max_segmenty !== undefined) patch.max_segmenty = Math.min(4, Math.max(1, Number(patch.max_segmenty) || 2));
    if (patch.bez_polskich_znakow !== undefined) patch.bez_polskich_znakow = patch.bez_polskich_znakow !== false;
    if (patch.nadawca !== undefined) patch.nadawca = String(patch.nadawca || 'lorenzo').trim().toLowerCase();
    if (req.body.sekwencja !== undefined) {
      patch.sekwencja = req.body.sekwencja && Number(req.body.sekwencja.po_dniach) >= 1
        ? { po_dniach: Math.min(60, Math.round(Number(req.body.sekwencja.po_dniach))), brief: String(req.body.sekwencja.brief || '').trim().slice(0, 500) || null }
        : null;
    }
    if (req.body.rabat !== undefined) {
      const rabatWal = walidujRabat(req.body.rabat);
      if (rabatWal.error) return res.status(400).json({ error: rabatWal.error });
      patch.rabat = rabatWal.rabat || null;
    }
    if (req.body.status === 'archived' && ['done', 'draft'].includes(kampania.status)) patch.status = 'archived';
    const { data, error } = await db.from('kampanie').update(patch).eq('id', kampania.id).select('*');
    if (error) throw error;
    res.json({ kampania: data[0] });
  } catch (err) { handleError(res, err, 502); }
});

// ── Ręczni odbiorcy ──────────────────────────────────────────────────────────

// Buduje odbiorcę z samego numeru: dociąga otwarte wyceny tego telefonu
// (pełny kontekst jak z populacji) i leada (imię, kwota/produkty z arkusza),
// więc ręcznie dodana osoba dostaje tak samo spersonalizowaną wiadomość.
async function zbudujRecznegoOdbiorce(db, { telefon, imie, leadId }) {
  const tel = telefonKlucz(telefon);
  if (tel.length < 9) throw new Error('Podaj poprawny numer telefonu');

  const { data: wyceny } = await db.from('wyceny')
    .select('id, imie_nazwisko, telefon_digits, email, lead_id, items, kwota_proponowana_brutto, kwota_sprzedazy_brutto, rabat24h_kwota, rabat24h_wazny_do, komentarz, opis_zamowienia, created_at')
    .eq('typ', 'WYCENA').eq('status', 'Open')
    .in('telefon_digits', [tel, `48${tel}`])
    .order('created_at', { ascending: false });

  let lead = null;
  if (leadId) {
    const { data } = await db.from('Leady B2C').select('"ID Leada", "Name", "Kwota wyceny", "Produkty z wyceny"').eq('ID Leada', Number(leadId)).limit(1);
    lead = data && data[0];
  } else {
    const { data } = await db.from('Leady B2C').select('"ID Leada", "Name", "Kwota wyceny", "Produkty z wyceny"').eq('Phone number', Number(tel)).limit(1);
    lead = data && data[0];
  }

  const najnowsza = (wyceny || [])[0] || null;
  const imieFinal = String(imie || '').trim()
    || (najnowsza && String(najnowsza.imie_nazwisko || '').trim())
    || (lead && String(lead['Name'] || '').trim()) || null;

  if (najnowsza) {
    const kwota = cenaFinalna(najnowsza);
    return {
      telefon: tel,
      email: String(najnowsza.email || '').trim().toLowerCase() || null,
      imie: imieFinal,
      lead_id: lead ? String(lead['ID Leada']) : (najnowsza.lead_id ? String(Number(najnowsza.lead_id)) : null),
      wycena_id: najnowsza.id,
      wyceny_ids: wyceny.map((w) => w.id),
      kontekst: {
        imie: imieFinal,
        items: (Array.isArray(najnowsza.items) ? najnowsza.items : []).map((it) => ({ name: it.name || '', quantity: it.quantity || 1, unit: it.unit || 'szt' })),
        kwota: Number.isFinite(Number(kwota)) ? Number(kwota) : null,
        komentarz: String(najnowsza.komentarz || '').trim() || null,
        opis: String(najnowsza.opis_zamowienia || '').trim() || null,
        wiek_dni: Math.floor((Date.now() - Date.parse(najnowsza.created_at)) / 86400000),
        wycena_created_at: najnowsza.created_at,
        liczba_wycen: wyceny.length,
        ma_rabat: Number(najnowsza.rabat24h_kwota) > 0,
      },
    };
  }

  const kwotaLeada = lead ? Number(String(lead['Kwota wyceny'] || '').replace(/[^\d.]/g, '')) : NaN;
  return {
    telefon: tel,
    email: null,
    imie: imieFinal,
    lead_id: lead ? String(lead['ID Leada']) : null,
    wycena_id: null,
    wyceny_ids: [],
    kontekst: {
      imie: imieFinal,
      items: [],
      kwota: Number.isFinite(kwotaLeada) && kwotaLeada > 0 ? kwotaLeada : null,
      opis: lead && String(lead['Produkty z wyceny'] || '').trim() || null,
      komentarz: null,
      wiek_dni: null,
      liczba_wycen: 0,
    },
  };
}

// Ręczne dodanie konkretnej osoby (z wyszukiwarki albo goły numer — np. test
// do siebie). Działa też na aktywnej kampanii: pending podchwyci worker.
app.post('/api/kampanie/:id(\\d+)/odbiorcy', async (req, res) => {
  try {
    const db = getClient();
    const kampania = await pobierzKampanie(db, req.params.id);
    if (!kampania) return res.status(404).json({ error: 'Nie ma takiej kampanii' });
    if (!['draft', 'sampling', 'review', 'active'].includes(kampania.status)) {
      return res.status(400).json({ error: `Nie można dodawać odbiorców w statusie ${kampania.status}` });
    }
    const odbiorca = await zbudujRecznegoOdbiorce(db, {
      telefon: req.body?.telefon, imie: req.body?.imie, leadId: req.body?.lead_id,
    });
    const { data: opt } = await db.from('kampanie_optout').select('telefon').eq('telefon', odbiorca.telefon).limit(1);
    if (opt && opt.length) return res.status(400).json({ error: 'Ten numer jest wypisany (optout)' });
    if (kampania.kanal === 'email' && !odbiorca.email) {
      return res.status(400).json({ error: 'Kampania mailowa, a ta osoba nie ma adresu e-mail' });
    }
    const { data, error } = await db.from('kampanie_odbiorcy')
      .insert({ kampania_id: kampania.id, ...odbiorca, zrodlo: 'reczny' })
      .select('*');
    if (error) {
      if (String(error.message).includes('duplicate') || error.code === '23505') {
        return res.status(400).json({ error: 'Ten numer już jest w tej kampanii' });
      }
      throw error;
    }
    res.json({ odbiorca: data[0] });
  } catch (err) { handleError(res, err, 502); }
});

// ── Populacja + próbka + akceptacja ─────────────────────────────────────────

app.post('/api/kampanie/:id(\\d+)/populacja', async (req, res) => {
  try {
    const db = getClient();
    const kampania = await pobierzKampanie(db, req.params.id);
    if (!kampania) return res.status(404).json({ error: 'Nie ma takiej kampanii' });
    if (!['draft', 'sampling'].includes(kampania.status)) {
      return res.status(400).json({ error: `Populację zamraża się w statusie draft (jest: ${kampania.status})` });
    }
    if (!kampania.filtr) return res.status(400).json({ error: 'Kampania z ręcznie wybranymi odbiorcami - dodawaj ich wyszukiwarką' });
    const wynik = await zamrozPopulacje(db, kampania);
    await db.from('kampanie').update({ status: 'sampling', updated_at: new Date().toISOString() }).eq('id', kampania.id);
    res.json(wynik);
  } catch (err) { handleError(res, err, 502); }
});

// Wybór próbki: celowo mieszamy odbiorców Z imieniem i BEZ — Antoni ma
// zobaczyć oba warianty treści zanim zaakceptuje resztę.
function wybierzProbke(rows, n) {
  const zImieniem = rows.filter((r) => r.imie);
  const bez = rows.filter((r) => !r.imie);
  const wybrane = [];
  const polowa = Math.ceil(n / 2);
  wybrane.push(...zImieniem.slice(0, polowa));
  wybrane.push(...bez.slice(0, n - wybrane.length));
  if (wybrane.length < n) wybrane.push(...zImieniem.slice(polowa, polowa + (n - wybrane.length)));
  return wybrane.slice(0, n);
}

async function generujProbke(db, kampania, rows) {
  const wyniki = [];
  const CONCURRENCY = 3;
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const paczka = rows.slice(i, i + CONCURRENCY);
    const wygenerowane = await Promise.all(paczka.map(async (row) => {
      try {
        const gen = await ai.generujTresc(kampania, row.kontekst, { wycenaId: row.wycena_id });
        await db.from('kampanie_odbiorcy').update({
          tresc: gen.tresc, temat: gen.temat, segmenty: gen.segmenty,
          sample: true, status: 'generated', blad: null, updated_at: new Date().toISOString(),
        }).eq('id', row.id);
        return { ...row, ...gen, sample: true, status: 'generated' };
      } catch (err) {
        await db.from('kampanie_odbiorcy').update({
          sample: true, blad: err.message.slice(0, 400), updated_at: new Date().toISOString(),
        }).eq('id', row.id);
        return { ...row, sample: true, blad: err.message };
      }
    }));
    wyniki.push(...wygenerowane);
  }
  return wyniki;
}

app.post('/api/kampanie/:id(\\d+)/probka', async (req, res) => {
  try {
    const db = getClient();
    const kampania = await pobierzKampanie(db, req.params.id);
    if (!kampania) return res.status(404).json({ error: 'Nie ma takiej kampanii' });
    if (!['draft', 'sampling', 'review'].includes(kampania.status)) {
      return res.status(400).json({ error: `Próbkę generuje się przed startem kampanii (jest: ${kampania.status})` });
    }
    const { data: pending, error } = await db.from('kampanie_odbiorcy')
      .select('*').eq('kampania_id', kampania.id).eq('status', 'pending').order('id');
    if (error) throw error;
    if (!pending || !pending.length) return res.status(400).json({ error: 'Brak odbiorców do próbki (populacja pusta?)' });
    // próbka ma reprezentować to, co faktycznie wyjdzie - podejrzani
    // (czekający na zatwierdzenie) wchodzą do niej tylko gdy nie ma innych
    const czysci = pending.filter((r) => !r.podejrzany);
    const probka = wybierzProbke(czysci.length ? czysci : pending, kampania.proba_size || 8);
    const wyniki = await generujProbke(db, kampania, probka);
    await db.from('kampanie').update({ status: 'review', updated_at: new Date().toISOString() }).eq('id', kampania.id);
    res.json({ probka: wyniki });
  } catch (err) { handleError(res, err, 502); }
});

// Przegenerowanie próbki z uwzględnieniem korekt — iteracja aż Antoni
// będzie zadowolony ("uczy się i poprawia kolejne wiadomości").
app.post('/api/kampanie/:id(\\d+)/probka/przegeneruj', async (req, res) => {
  try {
    const db = getClient();
    const kampania = await pobierzKampanie(db, req.params.id);
    if (!kampania) return res.status(404).json({ error: 'Nie ma takiej kampanii' });
    if (kampania.status !== 'review') return res.status(400).json({ error: 'Przegenerować można tylko w przeglądzie próbki' });
    const { data: rows, error } = await db.from('kampanie_odbiorcy')
      .select('*').eq('kampania_id', kampania.id).eq('sample', true)
      .in('status', ['generated', 'pending']).order('id');
    if (error) throw error;
    const wyniki = await generujProbke(db, kampania, rows || []);
    res.json({ probka: wyniki, korekty: kampania.korekty });
  } catch (err) { handleError(res, err, 502); }
});

// Edycja treści odbiorcy. W przeglądzie próbki edycja = KOREKTA: zapisujemy
// parę przed/po i prosimy AI o regułę — generator reszty dostaje jedno i drugie.
app.patch('/api/kampanie/:id(\\d+)/odbiorcy/:oid(\\d+)', async (req, res) => {
  try {
    const db = getClient();
    const kampania = await pobierzKampanie(db, req.params.id);
    if (!kampania) return res.status(404).json({ error: 'Nie ma takiej kampanii' });
    const { data: rows, error } = await db.from('kampanie_odbiorcy')
      .select('*').eq('id', req.params.oid).eq('kampania_id', kampania.id).limit(1);
    if (error) throw error;
    const row = rows && rows[0];
    if (!row) return res.status(404).json({ error: 'Nie ma takiego odbiorcy' });
    if (!['generated', 'approved', 'pending', 'failed'].includes(row.status)) {
      return res.status(400).json({ error: `Nie można edytować odbiorcy w statusie ${row.status}` });
    }

    const nowa = String(req.body?.tresc || '').trim();
    const walidacja = ai.walidujTresc(nowa, {
      kontekst: row.kontekst,
      bezPolskich: kampania.bez_polskich_znakow,
      maxSegmenty: kampania.max_segmenty,
      kanal: kampania.kanal,
    });
    // ręczna edycja: twarde odrzuty tylko na em dash i pustkę — Antoni może
    // świadomie napisać coś "generycznego", to jego decyzja
    if (!nowa) return res.status(400).json({ error: 'Pusta treść' });
    if (/[—–]/.test(nowa)) return res.status(400).json({ error: 'Zakazany myślnik — / –, użyj "-"' });

    const patch = {
      tresc: walidacja.tresc,
      segmenty: walidacja.segmenty,
      updated_at: new Date().toISOString(),
    };
    if (req.body?.temat !== undefined) patch.temat = String(req.body.temat || '').trim() || null;
    if (row.status === 'failed') { patch.status = 'approved'; patch.blad = null; }

    // korekta uczy kampanię: para przed/po + reguła od AI
    let korekty = kampania.korekty || { pary: [], reguly: [] };
    const uczyMy = kampania.status === 'review' && row.sample && row.tresc && row.tresc !== walidacja.tresc;
    if (uczyMy) {
      korekty = {
        pary: [...(korekty.pary || []), { przed: row.tresc, po: walidacja.tresc, odbiorca_id: row.id }].slice(-10),
        reguly: [...(korekty.reguly || [])],
      };
      const regula = await ai.regulaZKorekty(row.tresc, walidacja.tresc);
      if (regula && !korekty.reguly.includes(regula)) korekty.reguly = [...korekty.reguly, regula].slice(-10);
      await db.from('kampanie').update({ korekty, updated_at: new Date().toISOString() }).eq('id', kampania.id);
    }

    const { data: upd, error: updErr } = await db.from('kampanie_odbiorcy').update(patch).eq('id', row.id).select('*');
    if (updErr) throw updErr;
    res.json({ odbiorca: upd[0], segmenty: walidacja.segmenty, ostrzezenia: walidacja.bledy, korekty: uczyMy ? korekty : undefined });
  } catch (err) { handleError(res, err, 502); }
});

// Zatwierdzenie podejrzanego case'u - wraca do normalnej kolejki wysyłki.
app.post('/api/kampanie/:id(\\d+)/odbiorcy/:oid(\\d+)/zatwierdz', async (req, res) => {
  try {
    const db = getClient();
    const { data, error } = await db.from('kampanie_odbiorcy')
      .update({ podejrzany: false, updated_at: new Date().toISOString() })
      .eq('id', req.params.oid).eq('kampania_id', req.params.id).eq('podejrzany', true).select('*');
    if (error) throw error;
    if (!data || !data.length) return res.status(404).json({ error: 'Brak podejrzanego odbiorcy' });
    res.json({ odbiorca: data[0] });
  } catch (err) { handleError(res, err, 502); }
});

// Pominięcie odbiorcy (podejrzany-śmieć albo świadoma decyzja) - nie wysyłamy.
app.post('/api/kampanie/:id(\\d+)/odbiorcy/:oid(\\d+)/pomin', async (req, res) => {
  try {
    const db = getClient();
    const { data, error } = await db.from('kampanie_odbiorcy')
      .update({ status: 'skipped', blad: 'pominięty ręcznie', updated_at: new Date().toISOString() })
      .eq('id', req.params.oid).eq('kampania_id', req.params.id)
      .in('status', ['pending', 'generated', 'approved']).select('*');
    if (error) throw error;
    if (!data || !data.length) return res.status(404).json({ error: 'Nie można pominąć tego odbiorcy' });
    res.json({ odbiorca: data[0] });
  } catch (err) { handleError(res, err, 502); }
});

app.post('/api/kampanie/:id(\\d+)/odbiorcy/:oid(\\d+)/ponow', async (req, res) => {
  try {
    const db = getClient();
    const { data: rows, error } = await db.from('kampanie_odbiorcy')
      .select('*').eq('id', req.params.oid).eq('kampania_id', req.params.id).eq('status', 'failed').limit(1);
    if (error) throw error;
    if (!rows || !rows.length) return res.status(404).json({ error: 'Brak odbiorcy w statusie failed' });
    const row = rows[0];
    const { data: upd, error: updErr } = await db.from('kampanie_odbiorcy').update({
      status: row.tresc ? 'approved' : 'pending', blad: null, retry_count: 0, updated_at: new Date().toISOString(),
    }).eq('id', row.id).select('*');
    if (updErr) throw updErr;
    res.json({ odbiorca: upd[0] });
  } catch (err) { handleError(res, err, 502); }
});

// Akceptacja próbki = start kampanii: próbka approved, reszta (pending)
// generuje się w tle workerem i wychodzi w paczkach dziennych.
app.post('/api/kampanie/:id(\\d+)/akceptuj', async (req, res) => {
  try {
    const db = getClient();
    const kampania = await pobierzKampanie(db, req.params.id);
    if (!kampania) return res.status(404).json({ error: 'Nie ma takiej kampanii' });
    if (kampania.status !== 'review') return res.status(400).json({ error: 'Akceptuje się kampanię w przeglądzie próbki' });
    const { data: sample, error } = await db.from('kampanie_odbiorcy')
      .update({ status: 'approved', updated_at: new Date().toISOString() })
      .eq('kampania_id', kampania.id).eq('sample', true).eq('status', 'generated').select('id, segmenty');
    if (error) throw error;

    // szacunek kosztów na bazie próbki (stawka z env lub ~0.09 zł/segment)
    const { count: wszyscy } = await db.from('kampanie_odbiorcy')
      .select('id', { count: 'exact', head: true }).eq('kampania_id', kampania.id)
      .in('status', ['pending', 'approved', 'generated']);
    const srSeg = sample && sample.length
      ? sample.reduce((s, r) => s + (r.segmenty || 1), 0) / sample.length : 1;
    const stawka = Number(process.env.ZADARMA_SMS_STAWKA) || 0.09;
    const szacunek = {
      odbiorcy: wszyscy || 0,
      srednie_segmenty: Math.round(srSeg * 100) / 100,
      koszt_pln: Math.round((wszyscy || 0) * srSeg * stawka * 100) / 100,
    };
    const { data: upd, error: updErr } = await db.from('kampanie')
      .update({ status: 'active', szacunek, updated_at: new Date().toISOString() })
      .eq('id', kampania.id).select('*');
    if (updErr) throw updErr;
    res.json({ kampania: upd[0], approved_sample: (sample || []).length, szacunek });
  } catch (err) { handleError(res, err, 502); }
});

// "Wyślij teraz": natychmiastowa paczka bez czekania na cron i OKNO GODZIN
// (świadome kliknięcie właściciela). Limit dzienny dalej obowiązuje -
// to bezpiecznik przed zalaniem ludzi; wysyła zatwierdzone treści
// (approved), pending dogeneruje worker w tle.
app.post('/api/kampanie/:id(\\d+)/wyslij-teraz', async (req, res) => {
  try {
    const db = getClient();
    const kampania = await pobierzKampanie(db, req.params.id);
    if (!kampania) return res.status(404).json({ error: 'Nie ma takiej kampanii' });
    if (kampania.status !== 'active') return res.status(400).json({ error: 'Wysłać od razu można tylko aktywną kampanię (najpierw Akceptuj)' });
    const dzis = await wyslaneDzisTotal(db, kampania.id);
    const budzet = Math.max(0, (kampania.limit_dzienny || 25) - dzis);
    if (!budzet) return res.status(400).json({ error: `Limit dzienny wyczerpany (${dzis}/${kampania.limit_dzienny}) - zwiększ go w Ustawieniach albo poczekaj do jutra` });
    const wynik = await wyslijPaczke(db, getClient, kampania, Date.now() + 110000, budzet, { maxBatch: 30 });
    const stat = await liczniki(db, [kampania.id]);
    const l = stat.get(kampania.id);
    res.json({ ok: true, ...wynik, dzis: dzis + wynik.wyslane, limit: kampania.limit_dzienny, w_kolejce: (l.approved || 0) + (l.pending || 0) + (l.generated || 0) });
  } catch (err) { handleError(res, err, 502); }
});

app.post('/api/kampanie/:id(\\d+)/pauza', async (req, res) => {
  try {
    const db = getClient();
    const { data, error } = await db.from('kampanie')
      .update({ status: 'paused', updated_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('status', 'active').select('*');
    if (error) throw error;
    if (!data || !data.length) return res.status(400).json({ error: 'Pauzować można tylko aktywną kampanię' });
    res.json({ kampania: data[0] });
  } catch (err) { handleError(res, err, 502); }
});

app.post('/api/kampanie/:id(\\d+)/wznow', async (req, res) => {
  try {
    const db = getClient();
    const { data, error } = await db.from('kampanie')
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('status', 'paused').select('*');
    if (error) throw error;
    if (!data || !data.length) return res.status(400).json({ error: 'Wznowić można tylko wstrzymaną kampanię' });
    res.json({ kampania: data[0] });
  } catch (err) { handleError(res, err, 502); }
});

// Szacunek kosztu + saldo Zadarmy (ostrzeżenie w UI, bez twardej blokady).
app.get('/api/kampanie/:id(\\d+)/koszt', async (req, res) => {
  try {
    const db = getClient();
    const kampania = await pobierzKampanie(db, req.params.id);
    if (!kampania) return res.status(404).json({ error: 'Nie ma takiej kampanii' });
    const { data: rows, error } = await db.from('kampanie_odbiorcy')
      .select('status, segmenty').eq('kampania_id', kampania.id);
    if (error) throw error;
    const doWyslania = (rows || []).filter((r) => ['pending', 'generated', 'approved'].includes(r.status));
    const zSeg = (rows || []).filter((r) => r.segmenty);
    const srSeg = zSeg.length ? zSeg.reduce((s, r) => s + r.segmenty, 0) / zSeg.length : 1;
    const stawka = Number(process.env.ZADARMA_SMS_STAWKA) || 0.09;
    let saldo = null;
    try {
      const b = await callZadarma('/v1/info/balance/');
      if (b && b.status === 'success') saldo = { kwota: b.balance, waluta: b.currency };
    } catch (_) { /* saldo opcjonalne */ }
    res.json({
      do_wyslania: doWyslania.length,
      srednie_segmenty: Math.round(srSeg * 100) / 100,
      koszt_szacowany_pln: Math.round(doWyslania.length * srSeg * stawka * 100) / 100,
      saldo,
    });
  } catch (err) { handleError(res, err, 502); }
});

// ── Cron (pg_cron co 15 min; bramka godzin wysyłki w workerze) ──────────────
app.all('/api/cron/kampanie', async (req, res) => {
  try {
    if (!isCronAuthorized(req)) return res.status(401).json({ error: 'Brak autoryzacji' });
    const raport = await runKampanieWorker(getClient(), getClient);
    res.json({ ok: true, ...raport });
  } catch (err) { handleError(res, err, 502); }
});

const APP_HTML_TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');

app.get('/', (req, res) => {
  const html = APP_HTML_TEMPLATE.replace(
    '<head>',
    `<head>\n<script>window.API_BASE = ${JSON.stringify(req.baseUrl)};\n` +
    `window.LUMLUM_USER = ${JSON.stringify(clientPayload(req.user))};\n` +
    `window.LUMLUM_LINKS = ${JSON.stringify(panelLinks())};</script>`
  );
  res.type('html').send(html);
});

const PORT = process.env.PORT || 3012;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Panel Kampanie działa na http://localhost:${PORT}`);
  });
}

module.exports = app;
