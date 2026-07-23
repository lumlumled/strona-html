// Dokłada do RPC "app_update_leady_after_call" parametr p_temperatura, żeby po
// KAŻDEJ odebranej rozmowie zapisywać przeliczoną temperaturę leada
// (analyzeCall zwraca jakosc_leada, dotąd PORZUCANE). To zasila scoring
// (docs/backlog-priorytetyzacja-spec.md): klient mówi "za 2 miesiące" →
// temperatura spada → score leci w dół, case schodzi z góry.
//
// Semantyka: coalesce — brak nowej temperatury (null) nie czyści istniejącej.
// Webhook przekazuje normalizeTemperatura(jakosc_leada) || null, więc pusta
// ocena (nieodebrane/poczta głosowa, analysis=null) nie nadpisuje.
//
// Nowa sygnatura = nowa funkcja w Postgresie, starą (15-argumentową z
// add-godzina-feedbacku.js) trzeba jawnie DROP-nąć, inaczej PostgREST widzi
// dwie kandydatki. Nowy parametr ma default, więc kod sprzed deployu dalej działa.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

// Bezpośredni host db.*.supabase.co jest IPv6-only — łączymy się przez pooler
// (patrz sync-leady-from-sheet.js / add-godzina-feedbacku.js).
function pooledUrl() {
  const url = new URL(process.env.DATABASE_URL);
  const ref = url.hostname.match(/^db\.([^.]+)\.supabase\.co$/)?.[1];
  if (!ref) return process.env.DATABASE_URL;
  return `postgresql://postgres.${ref}:${url.password}@aws-0-eu-west-3.pooler.supabase.com:5432/postgres`;
}

async function main() {
  const client = new Client({ connectionString: pooledUrl() });
  await client.connect();

  // Temperatura już istnieje jako kolumna (czytana przez plan dnia), ale
  // add-if-not-exists jest idempotentne i bezpieczne.
  await client.query(`alter table "Leady B2C" add column if not exists "Temperatura" text`);
  console.log('Kolumna "Temperatura" w "Leady B2C" (add if not exists).');

  await client.query(`
    drop function if exists app_update_leady_after_call(
      bigint, text, text, text, text, text, text, bigint, text, text, boolean, text, text, text, text
    );
    create or replace function app_update_leady_after_call(
      p_phone bigint,
      p_ilosc_telefonow text,
      p_ostatni_kontakt text,
      p_tresc_rozmowy text,
      p_deal_stage text,
      p_data_feedbacku text,
      p_produkty text default null,
      p_kwota bigint default null,
      p_ocena_ai text default null,
      p_historia text default null,
      p_set_akcja boolean default false,
      p_akcja text default null,
      p_akcja_termin text default null,
      p_akcja_owner text default null,
      p_godzina_feedbacku text default null,
      p_temperatura text default null
    ) returns void language plpgsql as $$
    begin
      perform set_config('app.bypass_log_zmian', 'on', true);
      update "Leady B2C" set
        "Ilość telefonów" = p_ilosc_telefonow,
        "Ostatni kontakt" = p_ostatni_kontakt,
        "Treść rozmowy" = p_tresc_rozmowy,
        "Deal stage" = p_deal_stage,
        "Data Feedbacku" = p_data_feedbacku,
        "Godzina Feedbacku" = case
          when p_godzina_feedbacku is not null then p_godzina_feedbacku
          when p_data_feedbacku is distinct from "Data Feedbacku" then null
          else "Godzina Feedbacku" end,
        "Produkty z wyceny" = coalesce(p_produkty, "Produkty z wyceny"),
        "Kwota wyceny" = coalesce(p_kwota, "Kwota wyceny"),
        "Ocena AI kontaktu" = coalesce(p_ocena_ai, "Ocena AI kontaktu"),
        "Historia rozmów" = coalesce(p_historia, "Historia rozmów"),
        "Temperatura" = coalesce(p_temperatura, "Temperatura"),
        "Najbliższa akcja" = case when p_set_akcja then p_akcja else "Najbliższa akcja" end,
        "Najbliższa akcja termin" = case when p_set_akcja then p_akcja_termin else "Najbliższa akcja termin" end,
        "Najbliższa akcja owner" = case when p_set_akcja then p_akcja_owner else "Najbliższa akcja owner" end
      where "Phone number" = p_phone;
    end;
    $$;
  `);
  console.log('RPC app_update_leady_after_call przebudowane (+p_temperatura).');

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
