// Dokłada do "Leady B2C" kolumnę "Historia rozmów" — chronologiczny zapis
// połączeń (najnowsze na górze, jeden wpis na linię, format
// "DD.MM.YYYY HH:mm - treść"). Zapisuje ją webhook Zadarmy po każdej
// rozmowie; podsumowania rozmów przestają być doklejane do "Notes" (opis
// wraca do roli ręcznej notatki handlowca — patrz
// scripts/migrate-notes-to-historia.js, który przenosi stare wpisy).
//
// Przy okazji przebudowuje RPC app_update_leady_after_call o parametr
// p_historia. UWAGA: nowa sygnatura = nowa funkcja w Postgresie, więc starą
// (9 parametrów) trzeba jawnie DROP-nąć — inaczej PostgREST widzi dwie
// kandydatki dla wywołania z named params i rzuca "could not choose best
// candidate". p_historia ma default null, więc PRODUKCYJNY kod sprzed
// deployu (woła bez tego parametru) dalej działa w okresie przejściowym.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  await client.query(`alter table "Leady B2C" add column if not exists "Historia rozmów" text`);
  console.log('Kolumna "Historia rozmów" dodana do "Leady B2C" (lub już istniała).');

  await client.query(`
    drop function if exists app_update_leady_after_call(
      bigint, text, text, text, text, text, text, bigint, text
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
      p_historia text default null
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
        "Historia rozmów" = coalesce(p_historia, "Historia rozmów")
      where "Phone number" = p_phone;
    end;
    $$;
  `);
  console.log('RPC app_update_leady_after_call przebudowane (+p_historia).');

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
