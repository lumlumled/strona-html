// ── Triage: co zasługuje na uwagę Antoniego ─────────────────────────────────
// Klasyfikator przychodzących wiadomości do trzech koszy:
//   inbox        → główny widok "Do ogarnięcia" (realne zapytania produktowe)
//   notification → zakładka "Powiadomienia" (automaty wymagające uwagi)
//   archive      → poza widokiem (hejt, spam, komplementy bez pytania);
//                  widoczne tylko w zakładce "Wszystkie"
// Polaryzacja per typ (decyzja Antoniego): komentarz = bardzo selektywnie
// (domyślnie archive), DM/e-mail = domyślnie inbox (archive tylko jasny spam).
//
// Dwie warstwy: (1) twarde reguły z kom_triage_rules (wyciszony nadawca —
// zero LLM), (2) LLM task 'classify' z przykładami wyciszonych treści jako
// wskazówką "podobne → archive". Wiadomość z triage=NULL czeka na sweep()
// w cronie — webhook ma limit czasu, LLM może nie zdążyć.
const llm = require('./llm');
const { notifyNewMessage } = require('./notify-push');

// Push „Nowa wiadomość" tylko dla świeżo przychodzących zapytań w 'inbox'.
// sweep dokłada starą historię (triage=NULL sprzed wdrożenia) — tam pushujemy
// tylko wiadomości młodsze niż to okno, żeby backlog nie wystrzelił dziesiątek
// powiadomień naraz.
const PUSH_FRESH_MS = 60 * 60 * 1000;

const KIND_POLICY = {
  comment: 'comment: BARDZO selektywnie. Domyślnie "archive". "inbox" TYLKO przy jasnych przesłankach, że autor chce kupić albo pyta o produkt pod zakup (cena, dostępność, zamówienie, wysyłka, dobór pod swoją sytuację).',
  dm: 'dm: domyślnie "inbox" — wiadomość prywatna od człowieka zostaje, nawet niejednoznaczna. "archive" tylko przy JASNYCH przesłankach spamu/scamu/masowej oferty współpracy. "notification" dla wiadomości automatycznych ORAZ dla indywidualnych propozycji współpracy/reklamy/influencerki (człowiek, ale nie klient).',
  sms: 'sms: to wiadomość od REALNEGO leada (jego numer jest w naszej bazie, często odpowiada na naszego SMS-a/telefon). Domyślnie "inbox"; "archive" wyłącznie jawny spam sieciowy. Podanie adresu e-mail, adresu, wymiarów, terminu albo "oddzwonię" to nowa informacja do sprawy → wymaga_odpowiedzi true (false tylko czyste potwierdzenie typu "ok, dziękuję").',
  email: 'email: jak dm dla ludzi (współpraca/marketing od człowieka → "notification"). Automaty rozdzielaj surowo: "notification" TYLKO gdy wymaga działania właściciela (błąd krytyczny do naprawienia, faktura do zaksięgowania, alert billingowy, odpowiedź supportu na nasze zgłoszenie); cykliczne raporty, newslettery, onboarding narzędzi, marketing, powiadomienia informacyjne bez potrzeby działania → "archive". Adres typu no-reply sam w sobie NIE przesądza — automat może przekazywać wiadomość OD KLIENTA (np. "Przychodząca wiadomość SMS od ..."), a taka jest "inbox".',
};

// Wiadomości-atrapy: kliknięcie „Rozpocznij" na Messengerze, pusty SMS itp.
// Zero treści = zero odpowiedzi = zero karty „Do odpisania". Bez LLM.
const STUB_NO_REPLY = new Set(['', '[pusta wiadomość]', '[pusty komentarz]', 'rozpocznij', 'get started', 'getstarted', 'start', 'zaczynamy']);
function isStub(text) {
  return STUB_NO_REPLY.has(String(text || '').trim().toLowerCase());
}

// Sygnały, że wiadomość niesie KONKRET do sprawy (nie jest grzecznościowym
// zamknięciem): pytanie, liczby, wymiary/ilości, prośby, zapowiedź „zaraz
// zmierzę/sprawdzę/prześlę". Używane jako bezpiecznik triażu — nawet gdy LLM
// błędnie oceni „nie wymaga odpowiedzi", taka wiadomość NIE zdejmuje wątku z
// „Do odpisania". Dopasowanie przez includes (bez \b — polskie znaki psują
// granice słowa; patrz: nigdy \b po „Ń").
const SUBSTANCE_HINTS = [
  'metr', 'mb', ' cm', ' mm', 'wymiar', 'długoś', 'szerokoś', 'wysokoś', 'ile',
  'sztuk', ' szt', 'kolor', 'barw', 'profil', 'taśm', 'sterownik', 'pilot',
  'zasilacz', 'rgb', 'zmierz', 'sprawdz', 'policz', 'prześl', 'wyśl', 'zdjęc',
  'foto', 'zamów', 'wysył', 'dostaw', 'cen', 'termin', 'adres', 'faktur',
];
function hasSubstance(text) {
  const t = String(text || '').toLowerCase();
  if (t.includes('?') || /\d/.test(t)) return true;
  return SUBSTANCE_HINTS.some((k) => t.includes(k));
}

async function mutedSender(db, senderType, senderValue) {
  if (!senderType || !senderValue) return null;
  const value = String(senderValue).toLowerCase();
  const { data, error } = await db
    .from('kom_triage_rules').select('id,action,sender_value,match_type')
    .eq('sender_type', senderType).not('sender_value', 'is', null);
  if (error) throw error;
  return (data || []).find((r) => (r.match_type === 'contains'
    ? value.includes(String(r.sender_value).toLowerCase())
    : String(r.sender_value).toLowerCase() === value)) || null;
}

async function ruleExamples(db, limit = 10) {
  const { data, error } = await db
    .from('kom_triage_rules').select('example_text')
    .not('example_text', 'is', null)
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data || []).map((r) => String(r.example_text).slice(0, 200)).filter(Boolean);
}

function buildSystem(kind, examples) {
  return [
    'Jesteś filtrem skrzynki firmy LumLum (polski sklep z oświetleniem LED: lampy, sterowniki, taśmy; klienci detaliczni). Klasyfikujesz JEDNĄ przychodzącą wiadomość.',
    'Kategorie:',
    '- "inbox" — realne zapytanie produktowe / sygnał zainteresowania zakupem albo trwająca rozmowa SPRZEDAŻOWA z klientem. WYŁĄCZNIE obsługa klienta detalicznego — nic innego.',
    '- "notification" — automatyczne powiadomienie (platforma, narzędzie, system), które może wymagać uwagi właściciela, ALBO ludzka rozmowa niezwiązana ze sprzedażą do klienta: indywidualna propozycja współpracy/reklamy/barteru, influencer, agencja marketingowa, rekrutacja, sprawy administracyjne. Taka rozmowa NIE jest obsługą klienta i nie może trafić do "inbox", nawet gdy jest uprzejma, konkretna i trwa od dawna.',
    '- "archive" — nie wymaga odpowiedzi handlowca: hejt/kłótnie ("strasznie drogo", "w Chinach taniej"), komplementy bez pytania, emotki, spam, scam, masowe/szablonowe oferty współpracy i marketingu, szum.',
    '',
    `Polityka dla tego typu wiadomości → ${KIND_POLICY[kind] || KIND_POLICY.dm}`,
    ...(examples.length
      ? ['', 'Właściciel oznaczył wcześniej takie wiadomości jako niechciane — podobne treściowo klasyfikuj jako "archive":',
        ...examples.map((e) => `- "${e}"`)]
      : []),
    '',
    'Dodatkowo oceń "wymaga_odpowiedzi": czy TA wiadomość ma trzymać wątek na liście „Do odpisania"?',
    '- W TRWAJĄCEJ rozmowie sprzedażowej / wycenie (klient kompletuje swój projekt) to ZAWSZE true,',
    '  dopóki wycena nie jest domknięta — także gdy klient podaje szczegóły (wymiary, ilości, kolor, zdjęcie)',
    '  ALBO zapowiada, że zaraz coś zmierzy / sprawdzi / prześle i wróci ("muszę to zmierzyć", "sprawdzę i dam znać",',
    '  "na razie nie wiem, doślę"). Piłka jest po naszej stronie — wątek ma zostać widoczny, żeby nie zgubić leada.',
    '- false TYLKO dla jednoznacznego ZAKOŃCZENIA rozmowy, bez ciągu dalszego i bez nowej informacji',
    '  ("ok, dziękuję", "super, pozdrawiam", "jasne", sama emotka/lajk) albo kliknięcia startu bez treści.',
    '- true: pytanie, prośba, nowa informacja do sprawy (wymiary, zdjęcie, adres, termin, decyzja o zakupie),',
    '  reklamacja/problem, cokolwiek, na co klient realnie czeka.',
    '- W razie wątpliwości: true (lepiej pokazać kartę niż zgubić klienta).',
    '',
    'Oceń też "intencja_wyceny": czy ta rozmowa ZMIERZA DO WYCENY konkretnego projektu klienta?',
    '- true: klient pyta o dobór/ilości pod SWÓJ projekt, o konkretny produkt do zamówienia, o wykończenie /',
    '  montaż / jak zrobić instalację u siebie, podaje metraż/wymiary, chce zamówić, prosi o wycenę.',
    '- false: luźne pytanie bez intencji zakupowej ("fajny ten sterownik, ile kosztuje?"), ogólne',
    '  porównywanie cen bez projektu, hejt, komplement, spam, small talk. Sama ciekawość ceny to jeszcze',
    '  NIE intencja wyceny — musi być konkret pod realny projekt.',
    '- Gdy kategoria to "notification" lub "archive" → intencja_wyceny zawsze false.',
    '',
    'Odpowiedz WYŁĄCZNIE JSON-em bez żadnego innego tekstu:',
    '{"category":"inbox"|"notification"|"archive","reason":"uzasadnienie po polsku, max 12 słów","wymaga_odpowiedzi":true|false,"intencja_wyceny":true|false}',
  ].join('\n');
}

function parseVerdict(text) {
  const raw = String(text).replace(/```json|```/g, '').trim();
  const match = raw.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(match ? match[0] : raw);
  if (!['inbox', 'notification', 'archive'].includes(parsed.category)) {
    throw new Error(`Nieznana kategoria: ${parsed.category}`);
  }
  return {
    triage: parsed.category,
    reason: String(parsed.reason || '').slice(0, 200),
    // Domyślnie true — brak pola / dziwna wartość nie może schować klienta.
    needsReply: parsed.wymaga_odpowiedzi !== false,
    // Intencja wyceny (bramka do listy Organic) — domyślnie false; poza 'inbox'
    // z definicji nie ma intencji zakupowej.
    wycenaIntent: parsed.category === 'inbox' && parsed.intencja_wyceny === true,
  };
}

// Klasyfikacja jednej wiadomości. history = ostatnie wiadomości wątku
// (rosnąco) — kontynuacja rozmowy zakupowej ma zostać w inboxie, nawet
// gdy pojedyncza wiadomość brzmi neutralnie ("ok, to poproszę").
async function classifyMessage(db, { kind, channel, text, senderName, senderType, senderValue, history = [] }) {
  // Atrapa (start rozmowy, pusta treść) — nie ma na co odpowiadać, bez LLM.
  if (isStub(text)) {
    return { triage: 'inbox', reason: 'start rozmowy / brak treści', needsReply: false, by: 'rule' };
  }
  const muted = await mutedSender(db, senderType, senderValue);
  if (muted) return { triage: muted.action, reason: 'wyciszony nadawca', needsReply: false, by: 'rule' };

  const examples = await ruleExamples(db);
  const context = history.slice(-5)
    .map((m) => `${m.direction === 'in' ? 'Klient' : 'My'}: ${String(m.body).slice(0, 150)}`)
    .join('\n');
  const user = [
    `Typ: ${kind} | Kanał: ${channel} | Od: ${senderName || 'nieznany'}`,
    ...(context ? ['Poprzednie wiadomości wątku:', context] : []),
    'Wiadomość do klasyfikacji:',
    String(text).slice(0, 1500),
  ].join('\n');

  const { text: verdict } = await llm.complete({
    task: 'classify',
    system: buildSystem(kind, examples),
    messages: [{ role: 'user', content: user }],
    maxTokens: 150,
  });
  return { ...parseVerdict(verdict), by: 'ai' };
}

// Zapis wyniku: wiadomość dostaje triage, wątek przejmuje kategorię ostatniej
// przychodzącej — chyba że Antoni ustawił kategorię ręcznie (meta.triage_locked),
// wtedy jego decyzja wygrywa na zawsze.
async function applyTriage(db, thread, messageId, result, text = '') {
  await db.from('kom_messages').update({
    triage: result.triage,
    // reason per wiadomość w meta — kolumna jest tylko na wątku.
  }).eq('id', messageId);

  if (thread.meta?.triage_locked) return;
  const patch = { triage: result.triage, triage_reason: result.reason };
  // Intencja wyceny jest "lepka" — raz wykryta zostaje na wątku (późniejsze
  // "ok, dziękuję" nie odbiera kwalifikacji do listy Organic). Zapisujemy więc
  // TYLKO true, nigdy nie cofamy do false (patrz gate w apps/crm fetchOrganicRows).
  if (result.wycenaIntent) patch.wycena_intent = true;
  await db.from('kom_threads')
    .update(patch)
    .eq('id', thread.id);

  // Karty „Do odpisania" = status attention. Grzecznościowe zamknięcie
  // ("ok, dziękuję"), kliknięcie startu czy pusta wiadomość NIE wołają
  // o odpowiedź — wątek schodzi na 'waiting' (wróci przy realnej wiadomości).
  // Warunek na status w zapytaniu, nie na obiekcie — thread bywa nieświeży.
  // BEZPIECZNIK: nie chowamy wątku, gdy wiadomość niesie konkret (pytanie,
  // liczby, wymiary/ilości, „muszę zmierzyć/sprawdzić/prześlę") albo pokazuje
  // intencję wyceny — nawet jeśli LLM błędnie oceni „bez odpowiedzi". Odsiew
  // zostaje tylko dla czystych grzeczności. (Aktywne rozmowy sprzedażowe
  // znikały z „Do odpisania" — np. klient w trakcie mierzenia projektu.)
  const konkret = hasSubstance(text) || result.wycenaIntent === true;
  if (result.needsReply === false && !konkret) {
    await db.from('kom_threads')
      .update({ status: 'waiting' })
      .eq('id', thread.id).eq('status', 'attention');
  }
}

// Awaryjna kategoria, gdy LLM nie odpowiedział (timeout webhooka itp.):
// DM nigdy nie znika przez awarię filtra; komentarz czeka w archive, sweep
// doklasyfikuje go w ≤30 min i ewentualnie wypromuje.
function fallbackTriage(kind) {
  return kind === 'comment'
    ? { triage: 'archive', reason: 'czeka na klasyfikację', needsReply: false, by: 'fallback' }
    : { triage: 'inbox', reason: 'czeka na klasyfikację', needsReply: true, by: 'fallback' };
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms)),
  ]);
}

// Klasyfikacja w ścieżce webhooka: twardy budżet czasu; porażka nie może
// zablokować przyjęcia wiadomości. Przy porażce message.triage zostaje NULL
// (sweep dokończy), a wątek dostaje kategorię awaryjną.
async function classifyInWebhook(db, thread, messageId, input, budgetMs = 2500) {
  try {
    const result = await withTimeout(classifyMessage(db, input), budgetMs);
    await applyTriage(db, thread, messageId, result, input.text);
    // Świeża wiadomość real-time — dzwonimy tylko, gdy realnie jest na co
    // odpowiadać (grzecznościowe "ok, dziękuję" nie budzi telefonu).
    if (result.triage === 'inbox' && result.needsReply !== false) {
      await notifyNewMessage(db, { thread, body: input.text });
    }
    return result;
  } catch (err) {
    console.error('Triage (webhook):', err.message);
    const fallback = fallbackTriage(input.kind);
    if (!thread.meta?.triage_locked) {
      await db.from('kom_threads')
        .update({ triage: fallback.triage, triage_reason: fallback.reason })
        .eq('id', thread.id).catch(() => {});
    }
    return fallback;
  }
}

const CHANNEL_IDENTITY = { messenger: 'fb', instagram: 'ig', whatsapp: 'wa', tiktok: 'tt', email: 'email', phone: 'phone' };

// Sweep (cron): dokańcza klasyfikację wiadomości z triage=NULL — zaległości
// z webhooków i historia sprzed wdrożenia filtra.
async function sweep(db, limit = 20) {
  const { data: pending, error } = await db
    .from('kom_messages').select('id,thread_id,body,meta,created_at')
    .eq('direction', 'in').is('triage', null)
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  if (!pending || !pending.length) return { classified: 0 };

  let classified = 0;
  for (const msg of pending) {
    const { data: threads } = await db.from('kom_threads').select('*').eq('id', msg.thread_id).limit(1);
    const thread = threads && threads[0];
    if (!thread) continue;

    const [{ data: history }, { data: customers }] = await Promise.all([
      db.from('kom_messages').select('direction,body,created_at').eq('thread_id', thread.id)
        .lt('created_at', msg.created_at).order('created_at', { ascending: false }).limit(5),
      db.from('kom_customers').select('display_name').eq('id', thread.customer_id).limit(1),
    ]);
    const identityType = CHANNEL_IDENTITY[thread.channel];
    const { data: identities } = identityType
      ? await db.from('kom_customer_identities').select('value').eq('customer_id', thread.customer_id).eq('type', identityType).limit(1)
      : { data: [] };

    try {
      const result = await classifyMessage(db, {
        kind: thread.channel === 'email' ? 'email'
          : thread.channel === 'sms' ? 'sms'
            : (msg.meta?.kind === 'comment' ? 'comment' : 'dm'),
        channel: thread.channel,
        text: msg.body,
        senderName: customers?.[0]?.display_name || null,
        senderType: identityType,
        senderValue: identities?.[0]?.value || null,
        history: (history || []).reverse(),
      });
      // Wątek przejmuje kategorię tylko od NAJNOWSZEJ przychodzącej —
      // starsza wiadomość nie może nadpisać świeższej decyzji.
      const { data: newer } = await db
        .from('kom_messages').select('id').eq('thread_id', thread.id).eq('direction', 'in')
        .gt('created_at', msg.created_at).limit(1);
      if (newer && newer.length) {
        await db.from('kom_messages').update({ triage: result.triage }).eq('id', msg.id);
      } else {
        await applyTriage(db, thread, msg.id, result, msg.body);
        // Push tylko dla świeżych zapytań w 'inbox' — sweep dokłada też starą
        // historię (webhook nie zdążył sklasyfikować / import), której nie
        // chcemy nagle wypushować.
        const wiek = Date.now() - new Date(msg.created_at).getTime();
        if (result.triage === 'inbox' && result.needsReply !== false && wiek < PUSH_FRESH_MS) {
          await notifyNewMessage(db, { thread, body: msg.body });
        }
      }
      classified += 1;
    } catch (err) {
      console.error(`Triage sweep (${msg.id}):`, err.message);
    }
  }
  return { classified, pending: pending.length };
}

// Reguła "nie chcę widzieć podobnych": twarde wyciszenie nadawcy + treść
// ostatniej wiadomości jako przykład dla klasyfikatora.
async function muteFromThread(db, thread, exampleText) {
  const identityType = CHANNEL_IDENTITY[thread.channel];
  let senderValue = null;
  if (identityType) {
    const { data } = await db.from('kom_customer_identities')
      .select('value').eq('customer_id', thread.customer_id).eq('type', identityType).limit(1);
    senderValue = data?.[0]?.value || null;
  }
  const { error } = await db.from('kom_triage_rules').insert({
    action: 'archive',
    sender_type: senderValue ? identityType : null,
    sender_value: senderValue,
    example_text: exampleText ? String(exampleText).slice(0, 500) : null,
    note: `z wątku ${thread.id}`,
  });
  if (error) throw error;

  const meta = { ...(thread.meta || {}), triage_locked: true };
  await db.from('kom_threads')
    .update({ triage: 'archive', triage_reason: 'wyciszone przez Antoniego', meta })
    .eq('id', thread.id);
  return { senderMuted: Boolean(senderValue) };
}

module.exports = { classifyMessage, classifyInWebhook, applyTriage, sweep, muteFromThread, fallbackTriage, isStub };
