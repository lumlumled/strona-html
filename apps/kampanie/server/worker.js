// ── Worker kampanii (pg_cron → /api/cron/kampanie, co 15 min całą dobę) ──────
// Bramka godzin wysyłki liczona TUTAJ w czasie Warszawy (pg_cron chodzi
// w UTC - twardy zakres godzin w harmonogramie rozjeżdża się na DST).
// Przebieg per kampania active: generacja pending→approved (paczka), wysyłka
// approved→sent do limitu dziennego, potem push podsumowania do ownera.
// Wysyłka = wspólna ścieżka sendSmsAndLog/sendMailAndLog (kom_messages +
// Historia rozmów leada) + dopis do wyceny.history_log KAŻDEJ wyceny odbiorcy
// (ślad także dla wycen bez leada).

const { sendSmsAndLog, sendMailAndLog, findLeadByIdLeada, warsawDateTimeStr } = require('../../shared/server/kontakt-send');
const { notifyUser } = require('../../shared/server/push');
const { generujTresc } = require('./ai');

const GEN_BATCH = 8;      // generacje AI na przebieg (~3 s/szt.)
const SEND_BATCH = 10;    // maks. wysyłek na przebieg (limit dzienny i tak tnie)
const SEND_SLEEP_MS = 1500;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function warsawHour(date = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Warsaw', hour12: false, hour: 'numeric' }).format(date)) % 24;
}

// Północ dzisiejszego dnia w Warszawie jako ISO UTC (do licznika dziennego).
function warsawMidnightIso(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const offset = ((Number(parts.hour) % 24) - date.getUTCHours() + 24) % 24; // 1 zimą, 2 latem
  const utcMs = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) - offset * 3600000;
  return new Date(utcMs).toISOString();
}

async function notifyByName(db, getClient, name, payload) {
  try {
    const { data } = await db.from('app_users').select('id').ilike('name', String(name || '').trim()).eq('active', true).limit(1);
    if (data && data.length) await notifyUser(getClient, data[0].id, payload);
  } catch (err) {
    console.warn('kampanie: push nie wyszedł:', err.message);
  }
}

// Dopis do history_log (TEXT, linie \n, konwencja wyceny-endpoints: append).
async function dopiszHistoryLog(db, wycenyIds, linia) {
  if (!Array.isArray(wycenyIds) || !wycenyIds.length) return;
  const { data: rows } = await db.from('wyceny').select('id, history_log').in('id', wycenyIds);
  for (const r of rows || []) {
    const nowy = [r.history_log, linia].filter(Boolean).join('\n');
    await db.from('wyceny').update({ history_log: nowy, updated_at: new Date().toISOString() }).eq('id', r.id);
  }
}

// Generacja: pending → approved (po akceptacji próbki reszta idzie bez
// ręcznego przeglądu - decyzja Antoniego; walidator pilnuje jakości).
async function generujPaczke(db, kampania, deadline) {
  const wynik = { wygenerowane: 0, porazki: 0 };
  const { data: rows, error } = await db.from('kampanie_odbiorcy')
    .select('*').eq('kampania_id', kampania.id).eq('status', 'pending')
    .order('id', { ascending: true }).limit(GEN_BATCH);
  if (error) throw error;
  for (const row of rows || []) {
    if (Date.now() > deadline) break;
    try {
      const gen = await generujTresc(kampania, row.kontekst);
      await db.from('kampanie_odbiorcy').update({
        tresc: gen.tresc, temat: gen.temat, segmenty: gen.segmenty,
        status: 'approved', blad: null, updated_at: new Date().toISOString(),
      }).eq('id', row.id).eq('status', 'pending');
      wynik.wygenerowane++;
    } catch (err) {
      const retry = (row.retry_count || 0) + 1;
      await db.from('kampanie_odbiorcy').update({
        retry_count: retry, blad: err.message.slice(0, 400),
        status: retry >= 3 ? 'failed' : 'pending',
        updated_at: new Date().toISOString(),
      }).eq('id', row.id);
      wynik.porazki++;
    }
  }
  return wynik;
}

// Wysyłka: approved → sent z limitem dziennym. Claim atomowy PRZED wysyłką
// (update where status='approved') - podwójny SMS jest gorszy niż fałszywy
// "sent"; błąd Zadarmy po claimie ląduje jako failed z opisem.
async function wyslijPaczke(db, getClient, kampania, deadline) {
  const wynik = { wyslane: 0, pominiete: 0, bledy: 0, dzis: 0 };
  const odPolnocy = warsawMidnightIso();
  const { count: wyslaneDzis, error: cntErr } = await db.from('kampanie_odbiorcy')
    .select('id', { count: 'exact', head: true })
    .eq('kampania_id', kampania.id).eq('status', 'sent').gte('wyslano_at', odPolnocy);
  if (cntErr) throw cntErr;
  wynik.dzis = wyslaneDzis || 0;
  const budzet = Math.max(0, (kampania.limit_dzienny || 25) - wynik.dzis);
  if (!budzet) return wynik;

  const { data: rows, error } = await db.from('kampanie_odbiorcy')
    .select('*').eq('kampania_id', kampania.id).eq('status', 'approved')
    .order('sample', { ascending: false }).order('id', { ascending: true })
    .limit(Math.min(budzet, SEND_BATCH));
  if (error) throw error;

  // nadawca maila: user o nazwie = kampania.nadawca (skrzynka z kom_mailboxes)
  let senderUserId = null;
  if (kampania.kanal === 'email') {
    const { data: u } = await db.from('app_users').select('id').ilike('name', kampania.nadawca).limit(1);
    senderUserId = u && u.length ? u[0].id : null;
  }

  let streak = 0;
  for (const row of rows || []) {
    if (Date.now() > deadline) break;

    // świeże bezpieczniki: optout + wycena wciąż otwarta
    const { data: opt } = await db.from('kampanie_optout').select('telefon').eq('telefon', row.telefon).limit(1);
    if (opt && opt.length) {
      await db.from('kampanie_odbiorcy').update({ status: 'optout', updated_at: new Date().toISOString() }).eq('id', row.id);
      wynik.pominiete++;
      continue;
    }
    if (row.wycena_id) {
      const { data: w } = await db.from('wyceny').select('status, typ').eq('id', row.wycena_id).limit(1);
      if (!w || !w.length || w[0].status !== 'Open' || w[0].typ !== 'WYCENA') {
        await db.from('kampanie_odbiorcy').update({
          status: 'skipped', blad: 'wycena nieaktywna przy wysyłce', updated_at: new Date().toISOString(),
        }).eq('id', row.id);
        wynik.pominiete++;
        continue;
      }
    }

    const { data: claimed, error: claimErr } = await db.from('kampanie_odbiorcy')
      .update({ status: 'sent', wyslano_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', row.id).eq('status', 'approved').select('id');
    if (claimErr) throw claimErr;
    if (!claimed || !claimed.length) continue;

    try {
      const lead = row.lead_id ? await findLeadByIdLeada(db, row.lead_id) : null;
      let koszt = null;
      if (kampania.kanal === 'email') {
        await sendMailAndLog(db, {
          email: row.email, temat: row.temat, tresc: row.tresc,
          senderUserId, senderName: kampania.nadawca, lead,
          zrodlo: 'kampania', metaExtra: { kampania_id: kampania.id, odbiorca_id: row.id },
        });
      } else {
        const w = await sendSmsAndLog(db, {
          telefonDigits: row.telefon, tresc: row.tresc,
          senderName: kampania.nadawca, lead, displayName: row.imie,
          zrodlo: 'kampania', metaExtra: { kampania_id: kampania.id, odbiorca_id: row.id },
        });
        koszt = w.koszt;
      }
      if (koszt != null) await db.from('kampanie_odbiorcy').update({ koszt }).eq('id', row.id);
      const skrot = String(row.tresc || '').replace(/\s+/g, ' ').slice(0, 100);
      await dopiszHistoryLog(db, row.wyceny_ids, `${warsawDateTimeStr()} - [Kampania #${kampania.id}] ${kampania.kanal === 'email' ? 'Mail' : 'SMS'} wyslany: "${skrot}"`);
      wynik.wyslane++;
      wynik.dzis++;
      streak = 0;
    } catch (err) {
      await db.from('kampanie_odbiorcy').update({
        status: 'failed', blad: err.message.slice(0, 400), updated_at: new Date().toISOString(),
      }).eq('id', row.id);
      wynik.bledy++;
      streak++;
      if (streak >= 3) {
        // 3 błędy z rzędu (np. odrzucony caller_id, brak salda) - pauza + alarm
        await db.from('kampanie').update({ status: 'paused', updated_at: new Date().toISOString() }).eq('id', kampania.id);
        await notifyByName(db, getClient, kampania.owner, {
          title: `Kampania "${kampania.nazwa}" wstrzymana`,
          body: `3 błędy wysyłki z rzędu: ${err.message.slice(0, 120)}`,
          url: '/kampanie/', tag: `kampania-${kampania.id}-alarm`,
        });
        wynik.pauza = true;
        break;
      }
    }
    await sleep(SEND_SLEEP_MS);
  }
  return wynik;
}

async function runKampanieWorker(db, getClient, { budgetMs = 110000 } = {}) {
  const deadline = Date.now() + budgetMs;
  const raport = { kampanie: [] };
  const { data: aktywne, error } = await db.from('kampanie').select('*').eq('status', 'active').order('id');
  if (error) throw error;

  for (const k of aktywne || []) {
    if (Date.now() > deadline) break;
    const wpis = { id: k.id, nazwa: k.nazwa };
    try {
      wpis.generacja = await generujPaczke(db, k, deadline);
      const hour = warsawHour();
      if (hour >= (k.godzina_od ?? 9) && hour < (k.godzina_do ?? 17)) {
        wpis.wysylka = await wyslijPaczke(db, getClient, k, deadline);
        if (wpis.wysylka.wyslane > 0) {
          const { count: all } = await db.from('kampanie_odbiorcy').select('id', { count: 'exact', head: true }).eq('kampania_id', k.id);
          const { count: sent } = await db.from('kampanie_odbiorcy').select('id', { count: 'exact', head: true }).eq('kampania_id', k.id).eq('status', 'sent');
          await notifyByName(db, getClient, k.owner, {
            title: `Kampania "${k.nazwa}": wysłano ${wpis.wysylka.wyslane}`,
            body: `Dziś ${wpis.wysylka.dzis}/${k.limit_dzienny}, łącznie ${sent || 0}/${all || 0}`,
            url: '/kampanie/', tag: `kampania-${k.id}-paczka`,
          });
        }
      } else {
        wpis.wysylka = { pozaOknem: true };
      }

      // koniec kampanii: nic do zrobienia (nikt nie czeka na generację/wysyłkę)
      const { count: wToku } = await db.from('kampanie_odbiorcy')
        .select('id', { count: 'exact', head: true })
        .eq('kampania_id', k.id).in('status', ['pending', 'approved', 'generated']);
      if (!wToku) {
        const { data: aktualna } = await db.from('kampanie').select('status').eq('id', k.id).limit(1);
        if (aktualna && aktualna[0] && aktualna[0].status === 'active') {
          await db.from('kampanie').update({ status: 'done', updated_at: new Date().toISOString() }).eq('id', k.id);
          const { count: sent } = await db.from('kampanie_odbiorcy').select('id', { count: 'exact', head: true }).eq('kampania_id', k.id).eq('status', 'sent');
          await notifyByName(db, getClient, k.owner, {
            title: `Kampania "${k.nazwa}" zakończona`,
            body: `Wysłano łącznie ${sent || 0} wiadomości. Odpowiedzi będą spływać na karty leadów.`,
            url: '/kampanie/', tag: `kampania-${k.id}-koniec`,
          });
          wpis.done = true;
        }
      }
    } catch (err) {
      wpis.error = err.message;
    }
    raport.kampanie.push(wpis);
  }
  return raport;
}

module.exports = { runKampanieWorker, generujPaczke, wyslijPaczke, warsawHour, warsawMidnightIso };
