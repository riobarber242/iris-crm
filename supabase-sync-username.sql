-- Sincroniza name → casino_username automáticamente (idempotente).
-- Correr en Supabase → SQL editor. Cubre INSERT y UPDATE: cuando un contacto
-- tiene name y NO tiene casino_username, copia el name. NUNCA sobreescribe un
-- casino_username existente. Para la base actual usar el script de backfill
-- (scripts/sync-name-to-casino-username.ts).

create or replace function sync_casino_username_from_name()
returns trigger as $$
begin
  if (new.name is not null and btrim(new.name) <> '')
     and (new.casino_username is null or btrim(new.casino_username) = '') then
    new.casino_username := new.name;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_sync_casino_username on contacts;

create trigger trg_sync_casino_username
  before insert or update of name, casino_username on contacts
  for each row
  execute function sync_casino_username_from_name();
