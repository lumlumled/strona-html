// ── Populacja kampanii: stare otwarte wyceny → odbiorcy ──────────────────────
// Filtr "martwa otwarta wycena" identyczny jak watchdog (armWycena):
// typ='WYCENA' AND status='Open'. Dedupe po telefonie jest obowiązkowy -
// jeden klient potrafi mieć kilka otwartych wycen; dostaje JEDNĄ wiadomość
// (kontekst z najnowszej, pozostałe w wyceny_ids - auto-zamknięcie w Etapie 2
// zamyka wszystkie). Snapshot kontekstu idzie do AI i zostaje w wierszu,
// żeby treść odpowiadała temu, co klient faktycznie dostał.

const { cenaFinalna } = require('../../shared/server/wyceny-cena');

// Wycena poniżej tej kwoty (albo bez kwoty) to prawie na pewno błąd/śmieć -
// odbiorca dostaje flagę "podejrzany" i czeka na ręczne zatwierdzenie.
const PROG_KWOTY = Number(process.env.KAMPANIE_PROG_KWOTY) || 400;

function ocenPodejrzanego(kwota) {
  // cenaFinalna dla wyceny bez kwoty potrafi zwrócić 0 - to też "brak kwoty"
  if (kwota == null || !Number.isFinite(Number(kwota)) || Number(kwota) <= 0) {
    return { podejrzany: true, podejrzany_powod: 'brak kwoty wyceny' };
  }
  if (Number(kwota) < PROG_KWOTY) {
    return { podejrzany: true, podejrzany_powod: `kwota ${Math.round(Number(kwota))} zl - ponizej progu ${PROG_KWOTY} zl` };
  }
  return { podejrzany: false, podejrzany_powod: null };
}

// wyceny.telefon_digits bywa z prefiksem i bez - klucz dedupe to 9 ostatnich
// cyfr numeru krajowego (konwencja jak GET /api/rozmowy/szukaj).
function telefonKlucz(digits) {
  const d = String(digits || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('48')) return d.slice(2);
  return d;
}

function wiekDni(createdAt) {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

// Zwraca { odbiorcy, wykluczeni, liczba, suma_kwot } - bez zapisu.
async function zbudujPopulacje(db, { minWiekDni = 30, owner = null, kanal = 'sms' } = {}) {
  const cutoff = new Date(Date.now() - Math.max(0, Number(minWiekDni) || 0) * 86400000).toISOString();
  let q = db.from('wyceny')
    .select('id, imie_nazwisko, telefon_digits, email, lead_id, items, kwota_proponowana_brutto, kwota_sprzedazy_brutto, rabat24h_kwota, rabat24h_wazny_do, komentarz, opis_zamowienia, owner, created_at')
    .eq('typ', 'WYCENA')
    .eq('status', 'Open')
    .lt('created_at', cutoff)
    .order('created_at', { ascending: false });
  if (owner) q = q.eq('owner', owner);
  const { data: wyceny, error } = await q;
  if (error) throw error;

  const wykluczeni = { bez_kontaktu: 0, optout: 0, w_kampanii: 0 };

  // grupowanie po telefonie: pierwsza (najnowsza) wycena niesie kontekst
  const poTelefonie = new Map();
  for (const w of wyceny || []) {
    const tel = telefonKlucz(w.telefon_digits);
    const email = String(w.email || '').trim().toLowerCase();
    if (kanal === 'email' ? !email.includes('@') : tel.length < 9) {
      wykluczeni.bez_kontaktu++;
      continue;
    }
    const klucz = kanal === 'email' && tel.length < 9 ? email : tel;
    if (!poTelefonie.has(klucz)) {
      poTelefonie.set(klucz, { telefon: tel, email: email || null, wyceny: [w] });
    } else {
      poTelefonie.get(klucz).wyceny.push(w);
      if (!poTelefonie.get(klucz).email && email) poTelefonie.get(klucz).email = email;
    }
  }

  // wykluczenia: globalny optout + telefony w innej niezakończonej kampanii
  const { data: optoutRows, error: optErr } = await db.from('kampanie_optout').select('telefon');
  if (optErr) throw optErr;
  const optout = new Set((optoutRows || []).map((r) => telefonKlucz(r.telefon)));

  const { data: aktywne, error: kampErr } = await db.from('kampanie')
    .select('id').in('status', ['sampling', 'review', 'active', 'paused']);
  if (kampErr) throw kampErr;
  let zajete = new Set();
  if ((aktywne || []).length) {
    const { data: zajeteRows, error: zajErr } = await db.from('kampanie_odbiorcy')
      .select('telefon')
      .in('kampania_id', aktywne.map((k) => k.id))
      .not('status', 'in', '(skipped,optout)');
    if (zajErr) throw zajErr;
    zajete = new Set((zajeteRows || []).map((r) => telefonKlucz(r.telefon)));
  }

  // imiona: wycena.imie_nazwisko, a gdy brak - Name z powiązanego leada
  const leadIds = [...new Set(
    [...poTelefonie.values()].flatMap((g) => g.wyceny.map((w) => Number(w.lead_id)).filter(Number.isFinite))
  )];
  const imionaLeadow = new Map();
  for (let i = 0; i < leadIds.length; i += 100) {
    const { data: leady, error: leadErr } = await db.from('Leady B2C')
      .select('"ID Leada", "Name"').in('ID Leada', leadIds.slice(i, i + 100));
    if (leadErr) throw leadErr;
    (leady || []).forEach((l) => imionaLeadow.set(String(l['ID Leada']), String(l['Name'] || '').trim()));
  }

  const odbiorcy = [];
  let suma = 0;
  for (const g of poTelefonie.values()) {
    if (optout.has(g.telefon)) { wykluczeni.optout++; continue; }
    if (zajete.has(g.telefon)) { wykluczeni.w_kampanii++; continue; }
    const najnowsza = g.wyceny[0];
    const leadId = najnowsza.lead_id ? String(Number(najnowsza.lead_id)) : null;
    const imie = String(najnowsza.imie_nazwisko || '').trim()
      || (leadId && imionaLeadow.get(leadId)) || null;
    const kwota = cenaFinalna(najnowsza);
    if (Number.isFinite(Number(kwota))) suma += Number(kwota);
    odbiorcy.push({
      telefon: g.telefon,
      email: g.email,
      imie,
      lead_id: leadId,
      wycena_id: najnowsza.id,
      wyceny_ids: g.wyceny.map((w) => w.id),
      ...ocenPodejrzanego(Number.isFinite(Number(kwota)) ? Number(kwota) : null),
      kontekst: {
        imie,
        items: (Array.isArray(najnowsza.items) ? najnowsza.items : []).map((it) => ({
          name: it.name || '', quantity: it.quantity || 1, unit: it.unit || 'szt',
        })),
        kwota: Number.isFinite(Number(kwota)) ? Number(kwota) : null,
        komentarz: String(najnowsza.komentarz || '').trim() || null,
        opis: String(najnowsza.opis_zamowienia || '').trim() || null,
        wiek_dni: wiekDni(najnowsza.created_at),
        wycena_created_at: najnowsza.created_at,
        liczba_wycen: g.wyceny.length,
      },
    });
  }

  return {
    odbiorcy,
    wykluczeni,
    liczba: odbiorcy.length,
    suma_kwot: Math.round(suma),
    podejrzani: odbiorcy.filter((o) => o.podejrzany).length,
  };
}

// Zamraża populację kampanii w kampanie_odbiorcy (unique kampania+telefon
// pilnuje duplikatów przy powtórnym wywołaniu).
async function zamrozPopulacje(db, kampania) {
  const filtr = kampania.filtr || {};
  const { odbiorcy, wykluczeni } = await zbudujPopulacje(db, {
    minWiekDni: filtr.min_wiek_dni, owner: filtr.owner || null, kanal: kampania.kanal,
  });
  let dodano = 0;
  for (let i = 0; i < odbiorcy.length; i += 100) {
    const paczka = odbiorcy.slice(i, i + 100).map((o) => ({ kampania_id: kampania.id, ...o }));
    const { data, error } = await db.from('kampanie_odbiorcy')
      .upsert(paczka, { onConflict: 'kampania_id,telefon', ignoreDuplicates: true })
      .select('id');
    if (error) throw error;
    dodano += (data || []).length;
  }
  return { dodano, pominieto: odbiorcy.length - dodano, wykluczeni };
}

module.exports = { zbudujPopulacje, zamrozPopulacje, telefonKlucz, ocenPodejrzanego, PROG_KWOTY };
