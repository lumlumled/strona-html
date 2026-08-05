// Seed faktów LumLum (oświetlenie) do kb_facts - z katalogu auto-odpowiedzi.
// Idempotentny: kasuje wcześniejsze wiersze z tagiem 'seed-auto-oswietlenie',
// potem wstawia na nowo (status 'active', bo to zaufane dane Antoniego).
// Użycie: node scripts/seed-wiedza-oswietlenie.js
const path = require('path');
const KOM_SERVER = path.join(__dirname, '..', 'apps', 'komunikator', 'server');
require(path.join(KOM_SERVER, 'node_modules', 'dotenv')).config({ path: path.join(KOM_SERVER, '.env') });
const { createClient } = require(path.join(KOM_SERVER, 'node_modules', '@supabase/supabase-js'));
const knowledge = require(path.join(__dirname, '..', 'apps', 'shared', 'server', 'knowledge.js'));

const SEED_TAG = 'seed-auto-oswietlenie';

const FACTS = [
  { title: 'Cena sterownika cyfrowego', content: 'Sterownik cyfrowy LumLum kosztuje 350 zł.', visibility: 'team', tags: ['cena', 'sterownik'] },
  { title: 'Ceny taśmy COB 24V (5 m)', content: 'Taśma COB 24V: wersja cyfrowa jest IP65, analogowa IP67. Za 5 metrów: analogowa 250 zł, cyfrowa 400 zł.', visibility: 'team', tags: ['cena', 'tasma'] },
  { title: 'Przykładowy zestaw cyfrowy (~12 m)', content: 'Zestaw cyfrowy na ok. 12 m (taśma COB + sterownik + zasilacz + pilot) to koszt ok. 1400 zł. Taśma COB nie daje ciemnych punktów.', visibility: 'team', tags: ['cena', 'zestaw'] },
  { title: 'Zakres usług - sprzedaż i doradztwo, bez montażu', content: 'LumLum zajmuje się doradztwem i sprzedażą zestawów oświetlenia LED, nie montujemy. Do każdego zestawu dołączamy instrukcję po polsku oraz wideoinstrukcję krok po kroku. Montaż jest prosty - poradzi sobie każdy elektryk.', visibility: 'team', tags: ['uslugi', 'montaz'] },
  { title: 'Montaż w profilach aluminiowych', content: 'Taśmy montujemy w profilach aluminiowych. Sufit podwieszany - profil do płyty GK (wpuszczany pod tynk). Montaż natynkowy - niski, płaski profil nawierzchniowy; wtedy warto użyć taśmy COB, żeby nie było ciemnych punktów.', visibility: 'team', tags: ['montaz', 'profil'] },
  { title: 'Integracja ze smart home', content: 'Sterownik ma port na suchy styk (przekaźnik bezpotencjałowy), dzięki czemu można go podłączyć do dowolnego systemu Smart Home / sterowania WiFi.', visibility: 'team', tags: ['smart-home', 'sterownik'] },
  { title: 'Wysyłka - Polska i cała Europa', content: 'Wysyłamy zamówienia na terenie całej Polski oraz na terenie całej Europy.', visibility: 'team', tags: ['wysylka'] },
  { title: 'Rabaty / większe zamówienia / B2B', content: 'Przy większym zamówieniu wyceniamy indywidualnie i możemy przygotować rabat. Dla firm - wycena pod konkretny projekt.', visibility: 'team', tags: ['rabat', 'b2b'] },
  { title: 'Efekt cyfrowy - jak działa', content: 'Taśma cyfrowa ma przy każdej linii cięcia chip, który steruje indywidualnie każdą sekcją - pozwala to tworzyć animacje i płynące efekty. Sterownik ma zaprogramowane kilka trybów, konfiguracja jest prosta.', visibility: 'team', tags: ['technologia', 'efekt'] },
  { title: 'Technologia cyfrowa vs analogowa; barwa światła', content: 'Taśmy cyfrowe dają efekt płynącego/animowanego światła, analogowe - jednolite. Trzymamy się białego światła, bo jest najbardziej stabilne i ma najlepsze parametry. Nie zajmujemy się kolorowymi taśmami cyfrowymi (RGB) ani efektami opartymi o dźwięk.', visibility: 'team', tags: ['technologia', 'barwa'] },
  { title: 'Efekt płynący - okablowanie', content: 'Efekt płynącego światła (np. stopień po stopniu na schodach) uzyskujemy okablowaniem: łączymy końcówki odcinków trzyżyłowym przewodem z początkami następnych odcinków.', visibility: 'team', tags: ['montaz', 'okablowanie'] },
  { title: 'Linki - produkty, zestawy, konfigurator', content: 'Wszystkie produkty: https://lumlum.co/products . Zestawy: https://lumlum.co/pages/zestawy . Konfigurator: https://lumlum.co/pages/konfigurator .', visibility: 'team', tags: ['linki'] },
  { title: 'Telefon kontaktowy do klientów', content: 'Numer kontaktowy LumLum do rozmów z klientami: 604 650 590.', visibility: 'team', tags: ['kontakt'] },
  { title: 'Cena taśmy cyfrowej COB za metr (WEWNĘTRZNE)', content: 'Metr cyfrowej taśmy COB to 75 zł. To informacja wewnętrzna - NIE podajemy ceny za metr w odpowiedziach dla klienta; zawsze kierujemy na wycenę całego zestawu pod projekt.', visibility: 'owner', tags: ['cena', 'wewnetrzne'] },
];

async function main() {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { error: delErr } = await db.from('kb_facts').delete().contains('tags', [SEED_TAG]);
  if (delErr) throw delErr;

  let n = 0;
  for (const f of FACTS) {
    await knowledge.proposeFact(db, {
      title: f.title,
      content: f.content,
      tags: [SEED_TAG, ...(f.tags || [])],
      visibility: f.visibility,
      status: 'active',
      source: 'import',
      createdBy: 'seed-antoni',
    });
    n += 1;
  }
  console.log(`OK - zaseedowano ${n} faktów (tag: ${SEED_TAG})`);
}

main().catch((err) => { console.error(err); process.exit(1); });
