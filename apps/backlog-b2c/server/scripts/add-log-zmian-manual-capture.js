// Log zmian dziś zapełnia się wyłącznie z webhooka Zadarmy (rozmowy) —
// ręczne zmiany Deal stage/Notes/Data Feedbacku (Leady B2C) i Status/
// Komentarz/Data Feedbacku (Wyceny B2C) zrobione wprost w Supabase Studio
// (handlowiec edytuje tam, appka nie ma do tego formularza) nigdzie się nie
// logują. Dodaje dwa triggery AFTER UPDATE, które to łapią.
//
// Webhook Zadarmy sam już jawnie wstawia bogatszy wiersz do Log zmian przy
// update'cie Leady B2C (patrz server.js, insert przed update patch) — bez
// rozróżnienia trigger dublowałby ten wpis przy każdej rozmowie. Rozwiązanie:
// transaction-local flaga Postgresa (set_config z is_local=true), ustawiana
// wyłącznie przez nowy RPC app_update_leady_after_call, którym webhook musi
// teraz robić ten update zamiast zwykłego .update(). Wyceny B2C nigdy nie
// jest zapisywane przez appkę (czysty odczyt), więc tam trigger loguje
// zawsze, bez flagi.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  await client.query(`
    create or replace function log_zmian_from_leady() returns trigger
    language plpgsql as $$
    begin
      if current_setting('app.bypass_log_zmian', true) = 'on' then
        return new;
      end if;
      if new."Deal stage" is distinct from old."Deal stage"
         or new."Notes" is distinct from old."Notes"
         or new."Data Feedbacku" is distinct from old."Data Feedbacku" then
        insert into "Log zmian" (
          zrodlo, telefon, status_przed, status_po, opis, opis_przed, opis_po,
          data_feedbacku_przed, data_feedbacku_po, dopasowano_tabela, dopasowano_id, data_zmiany
        ) values (
          'manual_crm', new."Phone number"::text, old."Deal stage", new."Deal stage",
          new."Notes", old."Notes", new."Notes",
          old."Data Feedbacku", new."Data Feedbacku",
          'Leady B2C', coalesce(new."ID", ''), now()
        );
      end if;
      return new;
    end;
    $$;
  `);

  await client.query(`
    drop trigger if exists trg_log_zmian_from_leady on "Leady B2C";
    create trigger trg_log_zmian_from_leady
      after update on "Leady B2C"
      for each row execute function log_zmian_from_leady();
  `);

  await client.query(`
    create or replace function log_zmian_from_wyceny() returns trigger
    language plpgsql as $$
    begin
      if new."Status" is distinct from old."Status"
         or new."Komentarz" is distinct from old."Komentarz"
         or new."Data Feedbacku" is distinct from old."Data Feedbacku" then
        insert into "Log zmian" (
          zrodlo, telefon, status_przed, status_po, opis, opis_przed, opis_po,
          data_feedbacku_przed, data_feedbacku_po, dopasowano_tabela, dopasowano_id, data_zmiany
        ) values (
          'manual_crm', new."Telefon"::text, old."Status", new."Status",
          new."Komentarz", old."Komentarz", new."Komentarz",
          old."Data Feedbacku", new."Data Feedbacku",
          'Wyceny B2C', new."ID", now()
        );
      end if;
      return new;
    end;
    $$;
  `);

  await client.query(`
    drop trigger if exists trg_log_zmian_from_wyceny on "Wyceny B2C";
    create trigger trg_log_zmian_from_wyceny
      after update on "Wyceny B2C"
      for each row execute function log_zmian_from_wyceny();
  `);

  // Jedyne miejsce w kodzie, które modyfikuje Leady B2C po utworzeniu leada
  // (patrz update patch w /api/webhooks/zadarma) — musi przejść przez ten RPC
  // zamiast zwykłego .update(), żeby ustawić flagę bypass przed zapisem.
  // Parametry 1:1 z polami tamtego patcha; typy dopasowane do realnego
  // schematu (sprawdzone przez information_schema przed napisaniem tego pliku).
  await client.query(`
    create or replace function app_update_leady_after_call(
      p_phone bigint,
      p_ilosc_telefonow text,
      p_ostatni_kontakt text,
      p_tresc_rozmowy text,
      p_deal_stage text,
      p_data_feedbacku text,
      p_produkty text default null,
      p_kwota bigint default null,
      p_ocena_ai text default null
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
        "Ocena AI kontaktu" = coalesce(p_ocena_ai, "Ocena AI kontaktu")
      where "Phone number" = p_phone;
    end;
    $$;
  `);

  console.log('Triggery Log zmian (Leady B2C/Wyceny B2C) i RPC app_update_leady_after_call dodane.');
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
