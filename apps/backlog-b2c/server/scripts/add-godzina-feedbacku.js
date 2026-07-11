// Dokłada do "Leady B2C" kolumnę "Godzina Feedbacku" — opcjonalna godzina
// umówionego kolejnego kontaktu ("HH:mm", 24h). Osobna kolumna, NIE doklejka
// do "Data Feedbacku": tamtą kolumnę kilka miejsc parsuje sztywnym regexem
// DD.MM.YYYY (app.html, formatPlDate, dayKey w hubie) i dopisanie godziny
// łamałoby im format. Sam dzień bez godziny pozostaje normą — godzina jest
// TYLKO wtedy, gdy w rozmowie/notatce padła konkretna ("zadzwonię o 15").
// Zasila przypomnienia push "dokładnie w momencie feedbacku"
// (docs/plan-powiadomienia-push.md).
//
// Przebudowuje oba RPC o parametr p_godzina_feedbacku. Semantyka w obu:
// - podana godzina → zapisz;
// - podana NOWA data feedbacku bez godziny → wyczyść starą godzinę (stara
//   godzina przy nowej dacie to fałszywa informacja);
// - brak nowej daty → godzina bez zmian.
// Nowa sygnatura = nowa funkcja w Postgresie, starą trzeba jawnie DROP-nąć
// (patrz add-najblizsza-akcja.js — inaczej PostgREST widzi dwie kandydatki).
// Nowy parametr ma default, więc produkcyjny kod sprzed deployu dalej działa.
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

  await client.query(`alter table "Leady B2C" add column if not exists "Godzina Feedbacku" text`);
  console.log('Kolumna "Godzina Feedbacku" dodana do "Leady B2C" (lub już istniała).');

  await client.query(`
    drop function if exists app_update_leady_after_call(
      bigint, text, text, text, text, text, text, bigint, text, text, boolean, text, text, text
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
      p_godzina_feedbacku text default null
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
        "Najbliższa akcja" = case when p_set_akcja then p_akcja else "Najbliższa akcja" end,
        "Najbliższa akcja termin" = case when p_set_akcja then p_akcja_termin else "Najbliższa akcja termin" end,
        "Najbliższa akcja owner" = case when p_set_akcja then p_akcja_owner else "Najbliższa akcja owner" end
      where "Phone number" = p_phone;
    end;
    $$;
  `);
  console.log('RPC app_update_leady_after_call przebudowane (+p_godzina_feedbacku).');

  // W notatce data idzie przez coalesce (notatka bez daty nie czyści), więc
  // warunek "nowa data" to p_data_feedbacku is not null + faktyczna różnica.
  await client.query(`
    drop function if exists app_update_leady_notatka(
      bigint, text, boolean, text, text, text, text
    );
    create or replace function app_update_leady_notatka(
      p_phone bigint,
      p_historia text default null,
      p_set_akcja boolean default false,
      p_akcja text default null,
      p_akcja_termin text default null,
      p_akcja_owner text default null,
      p_data_feedbacku text default null,
      p_godzina_feedbacku text default null
    ) returns void language plpgsql as $$
    begin
      perform set_config('app.bypass_log_zmian', 'on', true);
      update "Leady B2C" set
        "Historia rozmów" = coalesce(p_historia, "Historia rozmów"),
        "Data Feedbacku" = coalesce(p_data_feedbacku, "Data Feedbacku"),
        "Godzina Feedbacku" = case
          when p_godzina_feedbacku is not null then p_godzina_feedbacku
          when p_data_feedbacku is not null and p_data_feedbacku is distinct from "Data Feedbacku" then null
          else "Godzina Feedbacku" end,
        "Najbliższa akcja" = case when p_set_akcja then p_akcja else "Najbliższa akcja" end,
        "Najbliższa akcja termin" = case when p_set_akcja then p_akcja_termin else "Najbliższa akcja termin" end,
        "Najbliższa akcja owner" = case when p_set_akcja then p_akcja_owner else "Najbliższa akcja owner" end
      where "Phone number" = p_phone;
    end;
    $$;
  `);
  console.log('RPC app_update_leady_notatka przebudowane (+p_godzina_feedbacku).');

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
