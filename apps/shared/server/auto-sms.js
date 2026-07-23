// ── Auto-SMS po nieodebranym telefonie ───────────────────────────────────────
// Spec: docs/plan-auto-sms-nieodebrane.md (treści ZATWIERDZONE przez Antoniego
// 2026-07-23 — nie przepisywać bez jego zgody). Lorenzo dzwoni, klient nie
// odbiera → automat wysyła SMS z prośbą o termin; odpowiedź klienta wraca
// istniejącym webhookiem /api/webhooks/zadarma-sms i sama ustawia Datę
// Feedbacku. Wyzwalacz siedzi w webhooku Zadarmy (backlog server.js), ten
// moduł trzyma całą resztę: bramkę, słownik imion, szablony, liczniki.
//
// Zasady, których pilnuje bramka (decyzje Antoniego, zamrożone):
//   max 1 SMS/dobę na numer · max 3 auto-SMS-y na życie leada, wszystkie w
//   oknie 7 dni od pierwszego (potem koniec na zawsze) · godziny 8:00-20:30
//   (poza oknem nie wysyłamy wcale, bez kolejkowania) · nic do
//   Sprzedane/Stracony · kill switch env AUTO_SMS_NIEODEBRANE=1.
//
// Fail-closed: każda wątpliwość (błąd odczytu liczników, brak dopasowania,
// lead spoza formularza bez wyceny) = NIE wysyłamy. Cisza jest tańsza niż
// zły SMS do klienta.

const identity = require('../../komunikator/server/identity');
const { sendSmsAndLog } = require('./kontakt-send');

const LOG_PREFIX = 'auto-sms:';

// ── Czas warszawski ──────────────────────────────────────────────────────────

function warsawParts(date = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Warsaw', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = dtf.formatToParts(date).reduce((acc, x) => { acc[x.type] = x.value; return acc; }, {});
  // hour '24' zdarza się w niektórych ICU dla północy — sprowadź do 0.
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh: Number(p.hour) % 24, mm: Number(p.minute) };
}

function warsawDateStr(date = new Date()) {
  const { y, m, d } = warsawParts(date);
  return `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`;
}

// "3 lipca" / "3 lipca 2025" (rok tylko, gdy inny niż bieżący — stara wycena
// bez roku brzmiałaby, jakby chodziło o ten rok). Dopełniacz nazw miesięcy,
// bo data stoi po "z" / przed "wysłaliśmy".
const MIESIACE_DOPELNIACZ = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca',
  'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];

function plDataSlownie(dateish, now = new Date()) {
  const t = typeof dateish === 'string' || typeof dateish === 'number' ? new Date(dateish) : dateish;
  if (!(t instanceof Date) || Number.isNaN(t.getTime())) return null;
  const w = warsawParts(t);
  const rok = w.y === warsawParts(now).y ? '' : ` ${w.y}`;
  return `${w.d} ${MIESIACE_DOPELNIACZ[w.m - 1]}${rok}`;
}

// ── Segmenty SMS (koszt) ─────────────────────────────────────────────────────
// Polskie diakrytyki wypychają wiadomość w UCS-2 (70 zn./segment, 67 przy
// sklejce). Licznik po to, żeby testy pilnowały kosztu każdego szablonu.

const GSM7_BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?'
  + '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '^{}\\[~]|€';

function policzSegmenty(tresc) {
  const text = String(tresc || '');
  let gsmLen = 0;
  let gsm7 = true;
  for (const ch of text) {
    if (GSM7_BASIC.includes(ch)) gsmLen += 1;
    else if (GSM7_EXT.includes(ch)) gsmLen += 2;
    else { gsm7 = false; break; }
  }
  if (gsm7) return gsmLen <= 160 ? 1 : Math.ceil(gsmLen / 153);
  const len = text.length; // BMP wystarcza (brak emoji w treściach — ':)' to ASCII)
  return len <= 70 ? 1 : Math.ceil(len / 67);
}

// ── Słownik imion: wołacz + płeć ─────────────────────────────────────────────
// Deterministycznie, bez zgadywania po końcówce (Kuba i Barnaba to mężczyźni).
// Brak PEWNEGO dopasowania → tor "Państwo" (bez rodzaju). "Dzień dobry Panie
// Zofia" kosztuje więcej, niż imię zyskuje. Klucz = lowercase.

const IMIONA = {
  // ── Męskie (formalne) ──
  adam: ['Adamie', 'M'], adrian: ['Adrianie', 'M'], albert: ['Albercie', 'M'],
  aleksander: ['Aleksandrze', 'M'], andrzej: ['Andrzeju', 'M'], antoni: ['Antoni', 'M'],
  arkadiusz: ['Arkadiuszu', 'M'], artur: ['Arturze', 'M'], bartlomiej: ['Bartłomieju', 'M'],
  bartłomiej: ['Bartłomieju', 'M'], bartosz: ['Bartoszu', 'M'], benedykt: ['Benedykcie', 'M'],
  bernard: ['Bernardzie', 'M'], blazej: ['Błażeju', 'M'], błażej: ['Błażeju', 'M'],
  bogdan: ['Bogdanie', 'M'], boguslaw: ['Bogusławie', 'M'], bogusław: ['Bogusławie', 'M'],
  borys: ['Borysie', 'M'], bronislaw: ['Bronisławie', 'M'], bronisław: ['Bronisławie', 'M'],
  cezary: ['Cezary', 'M'], czeslaw: ['Czesławie', 'M'], czesław: ['Czesławie', 'M'],
  damian: ['Damianie', 'M'], daniel: ['Danielu', 'M'], dariusz: ['Dariuszu', 'M'],
  dawid: ['Dawidzie', 'M'], denis: ['Denisie', 'M'], dominik: ['Dominiku', 'M'],
  edward: ['Edwardzie', 'M'], emil: ['Emilu', 'M'], ernest: ['Erneście', 'M'],
  eryk: ['Eryku', 'M'], eugeniusz: ['Eugeniuszu', 'M'], fabian: ['Fabianie', 'M'],
  filip: ['Filipie', 'M'], franciszek: ['Franciszku', 'M'], fryderyk: ['Fryderyku', 'M'],
  gabriel: ['Gabrielu', 'M'], grzegorz: ['Grzegorzu', 'M'], gustaw: ['Gustawie', 'M'],
  henryk: ['Henryku', 'M'], hubert: ['Hubercie', 'M'], igor: ['Igorze', 'M'],
  ignacy: ['Ignacy', 'M'], ireneusz: ['Ireneuszu', 'M'], jacek: ['Jacku', 'M'],
  jakub: ['Jakubie', 'M'], jan: ['Janie', 'M'], janusz: ['Januszu', 'M'],
  jaroslaw: ['Jarosławie', 'M'], jarosław: ['Jarosławie', 'M'], jerzy: ['Jerzy', 'M'],
  jozef: ['Józefie', 'M'], józef: ['Józefie', 'M'], julian: ['Julianie', 'M'],
  juliusz: ['Juliuszu', 'M'], kacper: ['Kacprze', 'M'], kajetan: ['Kajetanie', 'M'],
  kamil: ['Kamilu', 'M'], karol: ['Karolu', 'M'], kazimierz: ['Kazimierzu', 'M'],
  konrad: ['Konradzie', 'M'], konstanty: ['Konstanty', 'M'], kordian: ['Kordianie', 'M'],
  korneliusz: ['Korneliuszu', 'M'], krystian: ['Krystianie', 'M'], krzysztof: ['Krzysztofie', 'M'],
  ksawery: ['Ksawery', 'M'], lech: ['Lechu', 'M'], leon: ['Leonie', 'M'],
  leonard: ['Leonardzie', 'M'], leszek: ['Leszku', 'M'], ludwik: ['Ludwiku', 'M'],
  lukasz: ['Łukaszu', 'M'], łukasz: ['Łukaszu', 'M'], maciej: ['Macieju', 'M'],
  maksymilian: ['Maksymilianie', 'M'], marcel: ['Marcelu', 'M'], marcin: ['Marcinie', 'M'],
  marek: ['Marku', 'M'], marian: ['Marianie', 'M'], mariusz: ['Mariuszu', 'M'],
  mateusz: ['Mateuszu', 'M'], michal: ['Michale', 'M'], michał: ['Michale', 'M'],
  mieczyslaw: ['Mieczysławie', 'M'], mieczysław: ['Mieczysławie', 'M'],
  mikolaj: ['Mikołaju', 'M'], mikołaj: ['Mikołaju', 'M'], milosz: ['Miłoszu', 'M'],
  miłosz: ['Miłoszu', 'M'], miroslaw: ['Mirosławie', 'M'], mirosław: ['Mirosławie', 'M'],
  nikodem: ['Nikodemie', 'M'], norbert: ['Norbercie', 'M'], olaf: ['Olafie', 'M'],
  olgierd: ['Olgierdzie', 'M'], oskar: ['Oskarze', 'M'], patryk: ['Patryku', 'M'],
  pawel: ['Pawle', 'M'], paweł: ['Pawle', 'M'], piotr: ['Piotrze', 'M'],
  przemyslaw: ['Przemysławie', 'M'], przemysław: ['Przemysławie', 'M'],
  radoslaw: ['Radosławie', 'M'], radosław: ['Radosławie', 'M'], rafal: ['Rafale', 'M'],
  rafał: ['Rafale', 'M'], remigiusz: ['Remigiuszu', 'M'], robert: ['Robercie', 'M'],
  roman: ['Romanie', 'M'], ryszard: ['Ryszardzie', 'M'], samuel: ['Samuelu', 'M'],
  sebastian: ['Sebastianie', 'M'], seweryn: ['Sewerynie', 'M'], slawomir: ['Sławomirze', 'M'],
  sławomir: ['Sławomirze', 'M'], stanislaw: ['Stanisławie', 'M'], stanisław: ['Stanisławie', 'M'],
  stefan: ['Stefanie', 'M'], sylwester: ['Sylwestrze', 'M'], szczepan: ['Szczepanie', 'M'],
  szymon: ['Szymonie', 'M'], tadeusz: ['Tadeuszu', 'M'], tomasz: ['Tomaszu', 'M'],
  tymon: ['Tymonie', 'M'], tymoteusz: ['Tymoteuszu', 'M'], waclaw: ['Wacławie', 'M'],
  wacław: ['Wacławie', 'M'], waldemar: ['Waldemarze', 'M'], wieslaw: ['Wiesławie', 'M'],
  wiesław: ['Wiesławie', 'M'], wiktor: ['Wiktorze', 'M'], witold: ['Witoldzie', 'M'],
  wladyslaw: ['Władysławie', 'M'], władysław: ['Władysławie', 'M'],
  wlodzimierz: ['Włodzimierzu', 'M'], włodzimierz: ['Włodzimierzu', 'M'],
  wojciech: ['Wojciechu', 'M'], zbigniew: ['Zbigniewie', 'M'], zdzislaw: ['Zdzisławie', 'M'],
  zdzisław: ['Zdzisławie', 'M'], zenon: ['Zenonie', 'M'], zygmunt: ['Zygmuncie', 'M'],
  // ── Męskie (zdrobnienia spotykane w formularzach; "Panie Tomku" jest OK) ──
  bartek: ['Bartku', 'M'], darek: ['Darku', 'M'], franek: ['Franku', 'M'],
  jurek: ['Jurku', 'M'], krzysiek: ['Krzyśku', 'M'], kuba: ['Kubo', 'M'],
  maciek: ['Maćku', 'M'], mirek: ['Mirku', 'M'], olek: ['Olku', 'M'],
  piotrek: ['Piotrku', 'M'], przemek: ['Przemku', 'M'], radek: ['Radku', 'M'],
  romek: ['Romku', 'M'], staszek: ['Staszku', 'M'], tomek: ['Tomku', 'M'],
  wlodek: ['Włodku', 'M'], włodek: ['Włodku', 'M'], wojtek: ['Wojtku', 'M'],
  zbyszek: ['Zbyszku', 'M'],
  // ── Żeńskie (formalne) ──
  agata: ['Agato', 'K'], agnieszka: ['Agnieszko', 'K'], aldona: ['Aldono', 'K'],
  aleksandra: ['Aleksandro', 'K'], alicja: ['Alicjo', 'K'], alina: ['Alino', 'K'],
  amelia: ['Amelio', 'K'], aneta: ['Aneto', 'K'], angelika: ['Angeliko', 'K'],
  anita: ['Anito', 'K'], anna: ['Anno', 'K'], adrianna: ['Adrianno', 'K'],
  antonina: ['Antonino', 'K'], barbara: ['Barbaro', 'K'], beata: ['Beato', 'K'],
  bernadeta: ['Bernadeto', 'K'], bianka: ['Bianko', 'K'], blanka: ['Blanko', 'K'],
  bogumila: ['Bogumiło', 'K'], bogumiła: ['Bogumiło', 'K'], boguslawa: ['Bogusławo', 'K'],
  bogusława: ['Bogusławo', 'K'], bozena: ['Bożeno', 'K'], bożena: ['Bożeno', 'K'],
  cecylia: ['Cecylio', 'K'], celina: ['Celino', 'K'], czeslawa: ['Czesławo', 'K'],
  czesława: ['Czesławo', 'K'], dagmara: ['Dagmaro', 'K'], danuta: ['Danuto', 'K'],
  daria: ['Dario', 'K'], diana: ['Diano', 'K'], dominika: ['Dominiko', 'K'],
  dorota: ['Doroto', 'K'], edyta: ['Edyto', 'K'], eleonora: ['Eleonoro', 'K'],
  eliza: ['Elizo', 'K'], elwira: ['Elwiro', 'K'], elzbieta: ['Elżbieto', 'K'],
  elżbieta: ['Elżbieto', 'K'], emilia: ['Emilio', 'K'], ewa: ['Ewo', 'K'],
  ewelina: ['Ewelino', 'K'], felicja: ['Felicjo', 'K'], franciszka: ['Franciszko', 'K'],
  gabriela: ['Gabrielo', 'K'], genowefa: ['Genowefo', 'K'], grazyna: ['Grażyno', 'K'],
  grażyna: ['Grażyno', 'K'], halina: ['Halino', 'K'], hanna: ['Hanno', 'K'],
  helena: ['Heleno', 'K'], honorata: ['Honorato', 'K'], iga: ['Igo', 'K'],
  ilona: ['Ilono', 'K'], inga: ['Ingo', 'K'], irena: ['Ireno', 'K'],
  iwona: ['Iwono', 'K'], izabela: ['Izabelo', 'K'], izabella: ['Izabello', 'K'],
  jadwiga: ['Jadwigo', 'K'], jagoda: ['Jagodo', 'K'], janina: ['Janino', 'K'],
  joanna: ['Joanno', 'K'], jolanta: ['Jolanto', 'K'], judyta: ['Judyto', 'K'],
  julia: ['Julio', 'K'], julita: ['Julito', 'K'], justyna: ['Justyno', 'K'],
  kalina: ['Kalino', 'K'], kamila: ['Kamilo', 'K'], karina: ['Karino', 'K'],
  karolina: ['Karolino', 'K'], katarzyna: ['Katarzyno', 'K'], kazimiera: ['Kazimiero', 'K'],
  kinga: ['Kingo', 'K'], klaudia: ['Klaudio', 'K'], kornelia: ['Kornelio', 'K'],
  krystyna: ['Krystyno', 'K'], laura: ['Lauro', 'K'], lena: ['Leno', 'K'],
  leokadia: ['Leokadio', 'K'], lidia: ['Lidio', 'K'], liliana: ['Liliano', 'K'],
  lucyna: ['Lucyno', 'K'], ludmila: ['Ludmiło', 'K'], ludmiła: ['Ludmiło', 'K'],
  luiza: ['Luizo', 'K'], lucja: ['Łucjo', 'K'], łucja: ['Łucjo', 'K'],
  magdalena: ['Magdaleno', 'K'], maja: ['Maju', 'K'], malgorzata: ['Małgorzato', 'K'],
  małgorzata: ['Małgorzato', 'K'], malwina: ['Malwino', 'K'], maria: ['Mario', 'K'],
  marianna: ['Marianno', 'K'], marlena: ['Marleno', 'K'], marta: ['Marto', 'K'],
  martyna: ['Martyno', 'K'], marzena: ['Marzeno', 'K'], michalina: ['Michalino', 'K'],
  milena: ['Mileno', 'K'], miroslawa: ['Mirosławo', 'K'], mirosława: ['Mirosławo', 'K'],
  monika: ['Moniko', 'K'], natalia: ['Natalio', 'K'], nikola: ['Nikolo', 'K'],
  nina: ['Nino', 'K'], oksana: ['Oksano', 'K'], olga: ['Olgo', 'K'],
  oliwia: ['Oliwio', 'K'], patrycja: ['Patrycjo', 'K'], paulina: ['Paulino', 'K'],
  renata: ['Renato', 'K'], roksana: ['Roksano', 'K'], roza: ['Różo', 'K'],
  róża: ['Różo', 'K'], sabina: ['Sabino', 'K'], sandra: ['Sandro', 'K'],
  sara: ['Saro', 'K'], stanislawa: ['Stanisławo', 'K'], stanisława: ['Stanisławo', 'K'],
  stefania: ['Stefanio', 'K'], sylwia: ['Sylwio', 'K'], teresa: ['Tereso', 'K'],
  urszula: ['Urszulo', 'K'], wanda: ['Wando', 'K'], weronika: ['Weroniko', 'K'],
  wieslawa: ['Wiesławo', 'K'], wiesława: ['Wiesławo', 'K'], wiktoria: ['Wiktorio', 'K'],
  wioleta: ['Wioleto', 'K'], wioletta: ['Wioletto', 'K'], zaneta: ['Żaneto', 'K'],
  żaneta: ['Żaneto', 'K'], zofia: ['Zofio', 'K'], zuzanna: ['Zuzanno', 'K'],
  // ── Żeńskie (zdrobnienia; "Pani Kasiu" jest OK) ──
  ania: ['Aniu', 'K'], asia: ['Asiu', 'K'], basia: ['Basiu', 'K'],
  ela: ['Elu', 'K'], gosia: ['Gosiu', 'K'], iza: ['Izo', 'K'],
  kasia: ['Kasiu', 'K'], magda: ['Magdo', 'K'], ola: ['Olu', 'K'],
  zosia: ['Zosiu', 'K'],
};

// Zwrot grzecznościowy z surowego `Name` ("Grzegorz Kowalski", "grzegorz",
// "Firma XYZ", pusto…). Pierwszy człon, lookup w słowniku; wszystko inne →
// tor "Państwo". Nigdy nie zgadujemy.
function dopasujZwrot(nameRaw) {
  const pierwszy = String(nameRaw || '').trim().split(/\s+/)[0] || '';
  const klucz = pierwszy.toLowerCase().replace(/[^a-ząćęłńóśźż]/g, '');
  const hit = klucz.length >= 2 ? IMIONA[klucz] : null;
  if (!hit) return { tor: 'panstwo', wolacz: null };
  return { tor: hit[1] === 'M' ? 'pan' : 'pani', wolacz: hit[0] };
}

// ── Szablony ─────────────────────────────────────────────────────────────────
// Treści ZATWIERDZONE — pełne zdania per tor (pan/pani/panstwo), nie sprytna
// składanka: każdy tekst da się przeczytać i zweryfikować w całości. Rejestr:
// profesjonalnie, nie pretensjonalnie; kanoniczny zwrot "nie udało się nam
// połączyć"; zero em dashów; emotikon w wariancie 3 to dokładnie ":)".

function otwarcie(tor, wolacz, kto) {
  // kto: 'pelne' = "z tej strony Lorenzo z LumLum" (1. próba),
  //      'ponownie' = "tu ponownie…", 'tu' = "tu Lorenzo z LumLum".
  const przedstawienie = kto === 'pelne' ? 'z tej strony Lorenzo z LumLum.'
    : kto === 'ponownie' ? 'tu ponownie Lorenzo z LumLum.'
      : 'tu Lorenzo z LumLum.';
  if (tor === 'pan') return `Dzień dobry Panie ${wolacz}, ${przedstawienie}`;
  if (tor === 'pani') return `Dzień dobry Pani ${wolacz}, ${przedstawienie}`;
  return `Dzień dobry, ${przedstawienie}`;
}

// Wspólna końcówka wariantu 3 (identyczna w obu scenariuszach).
const POZEGNANIE_V3 = 'Jeśli temat jest nadal aktualny, proszę o wiadomość lub telefon na ten numer. '
  + 'Jeśli nie, proszę o krótką informację - wtedy nie będę już wracał do tematu :)';

function trescFormularz(proba, tor, wolacz) {
  if (proba <= 1) {
    const zostawil = tor === 'pan' ? 'Zostawił Pan' : tor === 'pani' ? 'Zostawiła Pani' : 'Zostawili Państwo';
    const zKim = tor === 'pan' ? ' z Panem' : tor === 'pani' ? ' z Panią' : '';
    const dlaKogo = tor === 'pan' ? 'dla Pana ' : tor === 'pani' ? 'dla Pani ' : '';
    const moze = tor === 'pan' ? 'Może Pan również oddzwonić' : tor === 'pani' ? 'Może Pani również oddzwonić' : 'Można również oddzwonić';
    return `${otwarcie(tor, wolacz, 'pelne')} ${zostawil} u nas kontakt w formularzu w sprawie oświetlenia LED. `
      + `Próbowałem się${zKim} skontaktować telefonicznie, ale nie udało się nam połączyć. `
      + `Proszę o informację, jaki dzień i godzina będą ${dlaKogo}dogodne - wtedy zadzwonię. `
      + `${moze} na ten numer w dowolnym momencie. Jeśli nie, zadzwonię jutro ponownie.`;
  }
  if (proba === 2) {
    const dlaKogo = tor === 'pan' ? 'dla Pana ' : tor === 'pani' ? 'dla Pani ' : '';
    return `${otwarcie(tor, wolacz, 'ponownie')} Dzwoniłem w sprawie oświetlenia LED, ale nie udało się nam połączyć. `
      + `Proszę o informację, kiedy będzie ${dlaKogo}dogodny moment na rozmowę - zadzwonię w tym terminie. `
      + `Można też oddzwonić na ten numer.`;
  }
  return `${otwarcie(tor, wolacz, 'tu')} Nie chciałbym zostawić sprawy oświetlenia LED bez odpowiedzi, `
    + `a nie udaje się nam połączyć. ${POZEGNANIE_V3}`;
}

function trescWycena(proba, tor, wolacz, { dataSlownie, umowioneDzis }) {
  // Zdanie o próbie kontaktu: gdy Data Feedbacku = dziś, mówimy wprost o
  // umówionym terminie; w innym razie neutralne "próbowałem się skontaktować".
  const zKim = tor === 'pan' ? ' z Panem' : tor === 'pani' ? ' z Panią' : '';
  const proba1kontakt = umowioneDzis
    ? 'Umawialiśmy się, że odezwę się dzisiaj, ale nie udało się nam połączyć.'
    : `Próbowałem się${zKim} skontaktować telefonicznie, ale nie udało się nam połączyć.`;
  if (proba <= 1) {
    const komu = tor === 'pan' ? 'Panu' : tor === 'pani' ? 'Pani' : 'Państwu';
    const wDogodnym = tor === 'pan' ? 'w dogodnym dla Pana momencie'
      : tor === 'pani' ? 'w dogodnym dla Pani momencie' : 'w dogodnym momencie';
    const wyslalismy = dataSlownie ? `${dataSlownie} wysłaliśmy` : 'Wysłaliśmy';
    return `${otwarcie(tor, wolacz, 'pelne')} ${wyslalismy} ${komu} wycenę oświetlenia LED. `
      + `${proba1kontakt} Proszę o informację, kiedy mogę zadzwonić, lub o telefon na ten numer ${wDogodnym}.`;
  }
  if (proba === 2) {
    const dlaKogo = tor === 'pan' ? 'dla Pana ' : tor === 'pani' ? 'dla Pani ' : '';
    const zDnia = dataSlownie ? ` z ${dataSlownie}` : '';
    return `${otwarcie(tor, wolacz, 'tu')} Wracam do wyceny oświetlenia LED${zDnia}. `
      + `${proba1kontakt} Proszę o informację, kiedy będzie ${dlaKogo}dogodny moment na rozmowę.`;
  }
  return `${otwarcie(tor, wolacz, 'tu')} Nie chciałbym zostawić przesłanej wyceny bez odpowiedzi, `
    + `a nie udaje się nam połączyć. ${POZEGNANIE_V3}`;
}

// Buduje treść auto-SMS-a. Nigdy nie renderuje "null"/pustych wtrąceń: brak
// imienia/płci → tor Państwo, brak daty wyceny → zdanie bez daty, Data
// Feedbacku ≠ dziś → bez zdania o umówionym terminie.
function zbudujTrescAutoSms({ scenariusz, proba, name, wycenaCreatedAt = null, umowioneDzis = false, now = new Date() }) {
  const { tor, wolacz } = dopasujZwrot(name);
  const p = Math.min(Math.max(Number(proba) || 1, 1), 3);
  const tresc = scenariusz === 'wycena'
    ? trescWycena(p, tor, wolacz, { dataSlownie: wycenaCreatedAt ? plDataSlownie(wycenaCreatedAt, now) : null, umowioneDzis })
    : trescFormularz(p, tor, wolacz);
  return { tresc, tor, wolacz, proba: p, segmenty: policzSegmenty(tresc) };
}

// ── Bramka (czysta decyzja, testowalna bez bazy) ─────────────────────────────
// Zwraca pierwszy niespełniony warunek jako `powod` — ląduje w Logach
// automatyzacji, żeby "czemu nie poszło" było widoczne bez debugowania.

const OKNO_OD_MIN = 8 * 60; // 8:00
const OKNO_DO_MIN = 20 * 60 + 30; // 20:30 włącznie
const MAX_AUTO_SMS = 3;
const OKNO_ZYCIA_DNI = 7;

function ocenBramke({
  wlaczone, label, kierunek, digits, leadClosed, maLeada, leadZrodlo, maWycene,
  hh, mm, dzisOut, autoCount, pierwszyAutoAt, nowMs,
}) {
  const skip = (powod) => ({ wysylac: false, powod });
  if (!wlaczone) return skip('wylaczone_env');
  if (label !== 'no_answer') return skip('odebrane');
  if (kierunek !== 'wychodzące') return skip('kierunek_nie_wychodzace');
  const d = String(digits || '').replace(/\D/g, '');
  if (d.length < 9) return skip('brak_numeru');
  if (leadClosed) return skip('lead_zamkniety');
  // Bez dopasowania (kontakt organic, lead dopiero co utworzony z tej rozmowy,
  // zupełnie obcy numer) nie mamy prawdziwego zdania do powiedzenia.
  if (!maLeada && !maWycene) return skip('brak_dopasowania');
  // Lead spoza formularza (Źródło ustawione = "Zadarma — rozmowa bez
  // dopasowania…") bez wyceny: tekst "zostawił Pan kontakt w formularzu"
  // byłby kłamstwem. Z wyceną — scenariusz WYCENA jest prawdziwy, wolno.
  if (!maWycene && maLeada && leadZrodlo != null) return skip('lead_spoza_formularza');
  const minuty = hh * 60 + mm;
  if (minuty < OKNO_OD_MIN || minuty > OKNO_DO_MIN) return skip('poza_godzinami');
  if (dzisOut > 0) return skip('sms_dzis_juz_byl');
  if (autoCount >= MAX_AUTO_SMS) return skip('limit_3_wyczerpany');
  if (autoCount > 0 && pierwszyAutoAt) {
    const wiekMs = nowMs - Date.parse(pierwszyAutoAt);
    if (wiekMs > OKNO_ZYCIA_DNI * 86400000) return skip('okno_7_dni_minelo');
  }
  return { wysylac: true, scenariusz: maWycene ? 'wycena' : 'formularz', proba: autoCount + 1 };
}

// ── Liczniki z kom_messages (jedno źródło prawdy o SMS-ach) ──────────────────

async function smsThreadIds(db, digits) {
  const komPhone = identity.normalize('phone', String(digits || '').replace(/\D/g, ''));
  if (!komPhone) return [];
  const { data, error } = await db.from('kom_threads')
    .select('id').eq('channel', 'sms').eq('external_thread_id', komPhone);
  if (error) throw error;
  return (data || []).map((t) => t.id);
}

// Historia WYCHODZĄCYCH SMS-ów na numer: ile dziś (dowolne źródło — ręczne z
// karty i kampanie też blokują dzisiejszy auto-SMS), ile auto w ogóle i kiedy
// był pierwszy (okno 7 dni).
async function historiaSmsNumeru(db, digits, now = new Date()) {
  const ids = await smsThreadIds(db, digits);
  if (!ids.length) return { dzisOut: 0, autoCount: 0, pierwszyAutoAt: null };
  const { data, error } = await db.from('kom_messages')
    .select('created_at, meta')
    .in('thread_id', ids)
    .eq('direction', 'out')
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) throw error;
  const dzis = warsawDateStr(now);
  const rows = data || [];
  const auto = rows.filter((r) => r.meta && r.meta.zrodlo === 'auto_sms');
  return {
    dzisOut: rows.filter((r) => warsawDateStr(new Date(r.created_at)) === dzis).length,
    autoCount: auto.length,
    pierwszyAutoAt: auto.length ? auto[0].created_at : null,
  };
}

// Zbiorczy wariant dla kampanii: klucze (9 ostatnich cyfr — konwencja
// telefonKlucz z populacji) numerów, które dostały od nas JAKIKOLWIEK SMS od
// `sinceIso`. Kampania takich nie tyka (decyzja: 30 dni ciszy po SMS-ie).
async function numeryZeSmsemOd(db, sinceIso) {
  const [threadsRes, msgsRes] = await Promise.all([
    db.from('kom_threads').select('id, external_thread_id').eq('channel', 'sms'),
    db.from('kom_messages').select('thread_id').eq('direction', 'out').gte('created_at', sinceIso),
  ]);
  if (threadsRes.error) throw threadsRes.error;
  if (msgsRes.error) throw msgsRes.error;
  const zWysylka = new Set((msgsRes.data || []).map((m) => m.thread_id));
  const klucze = new Set();
  for (const t of threadsRes.data || []) {
    if (!zWysylka.has(t.id)) continue;
    const d = String(t.external_thread_id || '').replace(/\D/g, '');
    if (d.length >= 9) klucze.add(d.slice(-9));
  }
  return klucze;
}

// ── Realna otwarta wycena (scenariusz WYCENA) ────────────────────────────────
// KANONICZNA tabela `wyceny` (NIE legacy "Wyceny B2C" — patrz GOTCHA w
// docs/backlog-priorytetyzacja-spec.md). Realna = typ WYCENA, status Open,
// niepusty koszyk items i kwota. telefon_digits bywa z prefiksem 48 i bez —
// dopasowujemy oba warianty, plus po lead_id (wyceny-sieroty mają telefon,
// leady z wyceną mają lead_id).
async function znajdzOtwartaWycene(db, { digits, leadId = null }) {
  const d = String(digits || '').replace(/\D/g, '');
  const bez48 = d.length === 11 && d.startsWith('48') ? d.slice(2) : d;
  const kandydaci = [];
  if (bez48.length >= 9) {
    const { data, error } = await db.from('wyceny')
      .select('id, created_at, imie_nazwisko, items, kwota_proponowana_brutto')
      .eq('typ', 'WYCENA').eq('status', 'Open')
      .in('telefon_digits', [bez48, `48${bez48}`])
      .order('created_at', { ascending: false })
      .limit(5);
    if (error) throw error;
    kandydaci.push(...(data || []));
  }
  const idNum = Number(leadId);
  if (Number.isFinite(idNum) && idNum > 0) {
    const { data, error } = await db.from('wyceny')
      .select('id, created_at, imie_nazwisko, items, kwota_proponowana_brutto')
      .eq('typ', 'WYCENA').eq('status', 'Open')
      .eq('lead_id', idNum)
      .order('created_at', { ascending: false })
      .limit(5);
    if (error) throw error;
    for (const w of data || []) if (!kandydaci.some((k) => k.id === w.id)) kandydaci.push(w);
  }
  const realne = kandydaci.filter((w) => Array.isArray(w.items) && w.items.length > 0 && w.kwota_proponowana_brutto != null);
  if (!realne.length) return null;
  realne.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return realne[0];
}

// ── Orkiestrator (woła go webhook Zadarmy) ───────────────────────────────────
// Zwraca { status: 'sent'|'skip'|'error', ... } i NIGDY nie rzuca — auto-SMS
// jest warstwą dodatkową, nie może wywalić zapisu rozmowy.
//
// Kolejność względem webhooka jest ISTOTNA: wołać PO wszystkich zapisach leada
// (RPC app_update_leady_after_call przepisuje Historię rozmów ze stanu
// odczytanego na starcie webhooka) — dlatego dostajemy `refetchLead` i
// dopisujemy [SMS→] na ŚWIEŻO pobranym leadzie. Wysyłka przed RPC zgubiłaby
// linię [SMS→] (nadpisana stalą Historią).
async function autoSmsPoNieodebranym(db, {
  digits, kierunek, lead = null, leadClosed = false, feedbackBefore = null,
  senderName = null, pbxCallId = null, refetchLead = null, now = new Date(), deps = {},
}) {
  const wlaczone = process.env.AUTO_SMS_NIEODEBRANE === '1';
  const czytajHistorie = deps.historiaSmsNumeru || historiaSmsNumeru;
  const czytajWycene = deps.znajdzOtwartaWycene || znajdzOtwartaWycene;
  const wyslij = deps.send || sendSmsAndLog;

  // Tanie warunki przed odczytami z bazy: wyłączony/zły kierunek/zamknięty
  // lead odpadają bez dwóch dodatkowych zapytań przy każdym połączeniu.
  const tanie = ocenBramke({
    wlaczone, label: 'no_answer', kierunek, digits, leadClosed,
    maLeada: Boolean(lead), leadZrodlo: null, maWycene: true, // reszta oceniana niżej
    hh: 12, mm: 0, dzisOut: 0, autoCount: 0, pierwszyAutoAt: null, nowMs: now.getTime(),
  });
  if (!tanie.wysylac) return { status: 'skip', powod: tanie.powod };

  // Odczyty liczników i wyceny: fail-closed — błąd odczytu = brak wysyłki
  // (bez liczników moglibyśmy zaspamować klienta).
  let historia;
  let wycena;
  try {
    [historia, wycena] = await Promise.all([
      czytajHistorie(db, digits, now),
      czytajWycene(db, { digits, leadId: lead ? lead['ID Leada'] : null }),
    ]);
  } catch (err) {
    console.warn(LOG_PREFIX, 'odczyt liczników/wyceny nie powiódł się — nie wysyłam:', err.message);
    return { status: 'skip', powod: `blad_odczytu: ${err.message}` };
  }

  const w = warsawParts(now);
  const decyzja = ocenBramke({
    wlaczone, label: 'no_answer', kierunek, digits, leadClosed,
    maLeada: Boolean(lead), leadZrodlo: lead ? (lead['Źródło'] ?? null) : null,
    maWycene: Boolean(wycena),
    hh: w.hh, mm: w.mm,
    dzisOut: historia.dzisOut, autoCount: historia.autoCount,
    pierwszyAutoAt: historia.pierwszyAutoAt, nowMs: now.getTime(),
  });
  if (!decyzja.wysylac) return { status: 'skip', powod: decyzja.powod };

  const zbudowane = zbudujTrescAutoSms({
    scenariusz: decyzja.scenariusz,
    proba: decyzja.proba,
    name: (lead && lead['Name']) || (wycena && wycena.imie_nazwisko) || '',
    wycenaCreatedAt: wycena ? wycena.created_at : null,
    umowioneDzis: Boolean(feedbackBefore) && feedbackBefore === warsawDateStr(now),
    now,
  });

  try {
    // Świeży lead → appendHistoriaLine w sendSmsAndLog dopisze [SMS→] do
    // AKTUALNEJ Historii (już z wpisem tej rozmowy), niczego nie nadpisując.
    const freshLead = lead && refetchLead ? await refetchLead().catch(() => lead) : lead;
    const wynik = await wyslij(db, {
      telefonDigits: digits,
      tresc: zbudowane.tresc,
      senderName,
      lead: freshLead,
      zrodlo: 'auto_sms',
      metaExtra: { auto_sms: { proba: decyzja.proba, scenariusz: decyzja.scenariusz, pbx_call_id: pbxCallId } },
    });
    return {
      status: 'sent', tresc: zbudowane.tresc, scenariusz: decyzja.scenariusz,
      proba: decyzja.proba, tor: zbudowane.tor, segmenty: zbudowane.segmenty,
      koszt: wynik && wynik.koszt != null ? wynik.koszt : null,
    };
  } catch (err) {
    console.error(LOG_PREFIX, 'wysyłka nie powiodła się:', err.message);
    return { status: 'error', blad: err.message, tresc: zbudowane.tresc, scenariusz: decyzja.scenariusz, proba: decyzja.proba };
  }
}

module.exports = {
  IMIONA,
  dopasujZwrot,
  plDataSlownie,
  policzSegmenty,
  zbudujTrescAutoSms,
  ocenBramke,
  historiaSmsNumeru,
  numeryZeSmsemOd,
  znajdzOtwartaWycene,
  autoSmsPoNieodebranym,
  warsawDateStr,
};
