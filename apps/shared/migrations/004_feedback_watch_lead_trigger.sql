-- Watchdog etap (e): mirror "Data Feedbacku" leada -> feedback_watch
-- (docs/plan-watchdog-feedback.md §4). Źródłem prawdy jawnego terminu leada
-- pozostają kolumny "Data Feedbacku" + "Godzina Feedbacku" — trigger tylko
-- utrzymuje lustrzany watch (object_type='lead'), niezależnie od ścieżki
-- zapisu (RPC after_call/notatka, ręczna edycja, webhook).
--
-- Zasady:
--   - zmiana daty/godziny -> supersede otwartego watcha, nowy z baseline=now()
--   - identyczny termin -> nic (baseline i stan alertu zostają)
--   - data wyczyszczona -> otwarty watch leada zamykany jako 'cancelled'
--   - lead Sprzedane/Stracony -> watch zamykany jako 'done'
--   - KAŻDY błąd (śmieciowa data itp.) jest połykany — mirror nigdy nie może
--     zablokować zapisu leada.

create or replace function feedback_watch_mirror_lead() returns trigger
language plpgsql as $$
declare
  v_id text;
  v_due timestamptz;
  v_open feedback_watch%rowtype;
begin
  begin
    -- "ID Leada" to numeric — kanoniczny object_id to int jako tekst
    -- ('314', nigdy '314.0'; ta sama zasada co wyceny.lead_id).
    v_id := trunc(new."ID Leada")::bigint::text;
    if v_id is null then return new; end if;

    -- Lead zamknięty -> gaś watcha i koniec.
    if new."Deal stage" in ('Sprzedane', 'Stracony') then
      update feedback_watch
         set resolved_at = now(), resolution = 'done'
       where object_type = 'lead' and object_id = v_id and resolved_at is null;
      return new;
    end if;

    -- Interesuje nas tylko realna zmiana terminu (INSERT zawsze "zmienia").
    if tg_op = 'UPDATE'
       and new."Data Feedbacku" is not distinct from old."Data Feedbacku"
       and new."Godzina Feedbacku" is not distinct from old."Godzina Feedbacku" then
      return new;
    end if;

    if new."Data Feedbacku" is null or btrim(new."Data Feedbacku") = '' then
      update feedback_watch
         set resolved_at = now(), resolution = 'cancelled'
       where object_type = 'lead' and object_id = v_id and resolved_at is null;
      return new;
    end if;

    -- "DD.MM.YYYY" + opcjonalna "HH:mm" (domyślnie 09:00) w Europe/Warsaw.
    v_due := (
      to_date(btrim(new."Data Feedbacku"), 'DD.MM.YYYY')
      + coalesce(nullif(btrim(coalesce(new."Godzina Feedbacku", '')), '')::time, time '09:00')
    ) at time zone 'Europe/Warsaw';

    select * into v_open from feedback_watch
     where object_type = 'lead' and object_id = v_id and resolved_at is null
     limit 1;

    if found and v_open.due_at = v_due and v_open.visible then
      return new; -- ten sam termin — nie resetuj baseline/alertu
    end if;

    if found then
      update feedback_watch
         set resolved_at = now(), resolution = 'superseded'
       where id = v_open.id;
    end if;

    insert into feedback_watch
      (object_type, object_id, owner, due_at, reason, set_by, visible, source, backlog_target)
    values
      ('lead', v_id, nullif(btrim(coalesce(new."Owner", '')), ''), v_due,
       'Data Feedbacku leada (mirror)', 'human', true, 'mirror_lead', 'b2c');
  exception when others then
    -- Mirror to warstwa dodatkowa — zapis leada ma zawsze przejść.
    raise warning 'feedback_watch_mirror_lead: % (lead %)', sqlerrm, v_id;
  end;
  return new;
end;
$$;

drop trigger if exists trg_feedback_watch_mirror on "Leady B2C";
create trigger trg_feedback_watch_mirror
  after insert or update of "Data Feedbacku", "Godzina Feedbacku", "Deal stage"
  on "Leady B2C"
  for each row execute function feedback_watch_mirror_lead();
