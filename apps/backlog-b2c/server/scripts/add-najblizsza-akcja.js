// Dokłada do "Leady B2C" trzy kolumny "Najbliższa akcja" — krótka (max ~5
// słów) następna czynność do zrobienia z leadem, widoczna na zwiniętym
// case'ie w backlogu: co ustalono w ostatniej rozmowie / notatce
// ("Zadzwonić jutro 15:00", "Wysłać wycenę SMS-em"). Zasila ją webhook
// Zadarmy (analiza GPT każdej odebranej rozmowy) oraz endpoint notatki
// handlowca; handlowiec może ją też ręcznie edytować/skasować.
//
// - "Najbliższa akcja"        — tekst akcji (null = brak akcji)
// - "Najbliższa akcja termin" — "DD.MM.YYYY" lub "DD.MM.YYYY HH:mm" (do
//                               podświetlania przeterminowanych)
// - "Najbliższa akcja owner"  — kto ma akcję wykonać (handlowiec)
//
// Przebudowuje RPC app_update_leady_after_call o obsługę akcji. UWAGA na
// semantykę INNĄ niż produkty/kwota/ocena AI (tam coalesce — pusty wynik
// analizy nie czyści pola): odebrana rozmowa zawsze REEWALUUJE akcję, więc
// gdy p_set_akcja=true, kolumny akcji są nadpisywane podanymi wartościami
// RÓWNIEŻ nullem (null = akcja wykonana / nic nowego nie umówiono →
// czyścimy). p_set_akcja=false (default, m.in. nieodebrane) nie dotyka ich
// wcale. Nowa sygnatura = nowa funkcja w Postgresie, starą trzeba jawnie
// DROP-nąć (patrz add-historia-rozmow.js — bez tego PostgREST widzi dwie
// kandydatki i rzuca "could not choose best candidate"). Nowe parametry
// mają defaulty, więc produkcyjny kod sprzed deployu dalej działa.
//
// Dokłada też RPC app_update_leady_notatka — wspólny zapis dla endpointu
// notatki handlowca i ręcznej edycji akcji (bypass triggera
// log_zmian_from_leady, bo Log zmian dostaje własny, jawny wiersz).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

// Bezpośredni host db.*.supabase.co jest IPv6-only — łączymy się przez pooler
// (patrz sync-leady-from-sheet.js).
function pooledUrl() {
  const url = new URL(process.env.DATABASE_URL);
  const ref = url.hostname.match(/^db\.([^.]+)\.supabase\.co$/)?.[1];
  if (!ref) return process.env.DATABASE_URL;
  return `postgresql://postgres.${ref}:${url.password}@aws-0-eu-west-3.pooler.supabase.com:5432/postgres`;
}

async function main() {
  const client = new Client({ connectionString: pooledUrl() });
  await client.connect();

  await client.query(`alter table "Leady B2C" add column if not exists "Najbliższa akcja" text`);
  await client.query(`alter table "Leady B2C" add column if not exists "Najbliższa akcja termin" text`);
  await client.query(`alter table "Leady B2C" add column if not exists "Najbliższa akcja owner" text`);
  console.log('Kolumny "Najbliższa akcja"/"... termin"/"... owner" dodane do "Leady B2C" (lub już istniały).');

  await client.query(`
    drop function if exists app_update_leady_after_call(
      bigint, text, text, text, text, text, text, bigint, text, text
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
      p_akcja_owner text default null
    ) returns void language plpgsql as $$
    begin
      perform set_config('app.bypass_log_zmian', 'on', true);
      update "Leady B2C" set
        "Ilość telefonów" = p_ilosc_telefonow,
        "Ostatni kontakt" = p_ostatni_kontakt,
        "Treść rozmowy" = p_tresc_rozmowy,
        "Deal stage" = p_deal_stage,
        "Data Feedbacku" = p_data_feedbacku,
        "Produkty z wyceny" = coalesce(p_produkty, "Produkty z wyceny"),
        "Kwota wyceny" = coalesce(p_kwota, "Kwota wyceny"),
        "Ocena AI kontaktu" = coalesce(p_ocena_ai, "Ocena AI kontaktu"),
        "Historia rozmów" = coalesce(p_historia, "Historia rozmów"),
        "Najbliższa akcja" = case when p_set_akcja then p_akcja else "Najbliższa akcja" end,
        "Najbliższa akcja termin" = case when p_set_akcja then p_akcja_termin else "Najbliższa akcja termin" end,
        "Najbliższa akcja owner" = case when p_set_akcja then p_akcja_owner else "Najbliższa akcja owner" end
      where "Phone number" = p_phone;
    end;
    $$;
  `);
  console.log('RPC app_update_leady_after_call przebudowane (+p_set_akcja/p_akcja/p_akcja_termin/p_akcja_owner).');

  // Zapis z notatki handlowca / ręcznej edycji akcji: Historia rozmów
  // (coalesce — notatka dokleja, edycja akcji nie podaje) + kolumny akcji
  // (case po p_set_akcja, jak wyżej) + Data Feedbacku (coalesce — tylko gdy
  // ekstrakcja z notatki coś znalazła; nie czyścimy istniejącej daty).
  await client.query(`
    create or replace function app_update_leady_notatka(
      p_phone bigint,
      p_historia text default null,
      p_set_akcja boolean default false,
      p_akcja text default null,
      p_akcja_termin text default null,
      p_akcja_owner text default null,
      p_data_feedbacku text default null
    ) returns void language plpgsql as $$
    begin
      perform set_config('app.bypass_log_zmian', 'on', true);
      update "Leady B2C" set
        "Historia rozmów" = coalesce(p_historia, "Historia rozmów"),
        "Data Feedbacku" = coalesce(p_data_feedbacku, "Data Feedbacku"),
        "Najbliższa akcja" = case when p_set_akcja then p_akcja else "Najbliższa akcja" end,
        "Najbliższa akcja termin" = case when p_set_akcja then p_akcja_termin else "Najbliższa akcja termin" end,
        "Najbliższa akcja owner" = case when p_set_akcja then p_akcja_owner else "Najbliższa akcja owner" end
      where "Phone number" = p_phone;
    end;
    $$;
  `);
  console.log('RPC app_update_leady_notatka dodane.');

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
