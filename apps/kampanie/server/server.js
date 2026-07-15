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
const ai = require('./ai');
const { runKampanieWorker } = require('./worker');

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

async function pobierzKampanie(db, id) {
  const { data, error } = await db.from('kampanie').select('*').eq('id', id).limit(1);
  if (error) throw error;
  if (!data || !data.length) return null;
  return data[0];
}

async function liczniki(db, kampaniaIds) {
  const wynik = new Map(kampaniaIds.map((id) => [id, { pending: 0, generated: 0, approved: 0, sent: 0, failed: 0, replied: 0, closed: 0, optout: 0, skipped: 0, razem: 0 }]));
  if (!kampaniaIds.length) return wynik;
  const { data, error } = await db.from('kampanie_odbiorcy')
    .select('kampania_id, status').in('kampania_id', kampaniaIds);
  if (error) throw error;
  (data || []).forEach((r) => {
    const l = wynik.get(r.kampania_id);
    if (!l) return;
    l[r.status] = (l[r.status] || 0) + 1;
    l.razem++;
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
      wykluczeni: pop.wykluczeni,
      probka: pop.odbiorcy.slice(0, 20).map((o) => ({
        telefon: o.telefon, imie: o.imie, kwota: o.kontekst.kwota, wiek_dni: o.kontekst.wiek_dni,
        liczba_wycen: o.kontekst.liczba_wycen, wycena_id: o.wycena_id,
      })),
    });
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
    const { data: odbiorcy, error } = await q;
    if (error) throw error;
    const stat = await liczniki(db, [kampania.id]);
    res.json({ kampania, liczniki: stat.get(kampania.id), odbiorcy: odbiorcy || [] });
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
    if (req.body.status === 'archived' && ['done', 'draft'].includes(kampania.status)) patch.status = 'archived';
    const { data, error } = await db.from('kampanie').update(patch).eq('id', kampania.id).select('*');
    if (error) throw error;
    res.json({ kampania: data[0] });
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
        const gen = await ai.generujTresc(kampania, row.kontekst);
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
    if (!['sampling', 'review'].includes(kampania.status)) {
      return res.status(400).json({ error: `Próbkę generuje się po zamrożeniu populacji (jest: ${kampania.status})` });
    }
    const { data: pending, error } = await db.from('kampanie_odbiorcy')
      .select('*').eq('kampania_id', kampania.id).eq('status', 'pending').order('id');
    if (error) throw error;
    if (!pending || !pending.length) return res.status(400).json({ error: 'Brak odbiorców do próbki (populacja pusta?)' });
    const probka = wybierzProbke(pending, kampania.proba_size || 8);
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
