-- "En proceso" pasa a ser automático: sin usuario de casino = En proceso.
-- Correr en Supabase → SQL editor. Este proyecto NO tiene la RPC exec_sql, así
-- que la DDL se ejecuta a mano.
--
-- QUÉ CAMBIA. Antes 'en_proceso' significaba "el bot ya derivó esta conversación
-- a un humano": lo escribía el bot en 6 ramas de su máquina de estados. Eso
-- dependía de que el bot estuviera prendido, de que el webhook llegara y de que
-- ese UPDATE no fallara — y hoy hay 0 contactos en ese estado en las dos cuentas.
-- Ahora significa "todavía no tiene cuenta creada", que es un dato que ya vive en
-- la propia fila (casino_username). Al ser una función de la fila y no de una
-- secuencia de eventos, no se puede "perder".
--
-- PRECEDENCIA. La plata manda sobre la falta de alta:
--   · sin usuario + nunca cargó            → en_proceso
--   · sin usuario + cargó este mes         → cliente_activo (gana la plata)
--   · sin usuario + cargó en meses previos → inactivo       (gana la plata)
--   · bloqueado                            → intocable, siempre
-- Al asignarle el usuario, un 'en_proceso' pasa a 'nuevo' y sigue el ciclo normal.

-- ── 1. Trigger de sincronización ─────────────────────────────────────────────
-- Va en la base y no en la aplicación a propósito: hay varios caminos que
-- asignan el usuario (alta manual, edición, import CSV, creación de usuario de
-- casino, y el que se agregue mañana). Con el trigger, ninguno se puede olvidar.
--
-- Además protege el estado contra un degradado indebido: si algo intenta pasar a
-- 'nuevo' un contacto que sigue sin usuario, lo devuelve a 'en_proceso'. Eso
-- cubre el caso de una reclasificación vieja sin la guarda de en_proceso, que es
-- la sospecha de por qué hoy hay 0 (ver supabase-clasificar-contactos-rpc.sql).
create or replace function contacts_sync_en_proceso()
returns trigger
language plpgsql
as $$
declare
  sin_usuario boolean := coalesce(trim(new.casino_username), '') = '';
begin
  -- 'bloqueado' no se toca nunca, ni al entrar ni al salir.
  if new.status = 'bloqueado' or (tg_op = 'UPDATE' and old.status = 'bloqueado') then
    return new;
  end if;

  if sin_usuario then
    -- Sin usuario: es 'en_proceso', salvo que su historial de cargas diga otra
    -- cosa ('cliente_activo' / 'inactivo' se respetan tal cual).
    if new.status is null or new.status = 'nuevo' then
      new.status := 'en_proceso';
    end if;
  else
    -- Ya tiene usuario: 'en_proceso' deja de aplicar y arranca el ciclo normal.
    if new.status = 'en_proceso' then
      new.status := 'nuevo';
    end if;
  end if;

  return new;
end;
$$;

-- Se dispara solo cuando cambian las dos columnas que importan (no en cada
-- UPDATE de la tabla): así la reclasificación nocturna, que solo escribe status,
-- pasa por la guarda, y un cambio de nombre o de línea no ejecuta nada.
drop trigger if exists trg_contacts_sync_en_proceso on contacts;
create trigger trg_contacts_sync_en_proceso
  before insert or update of casino_username, status on contacts
  for each row execute function contacts_sync_en_proceso();

-- ── 2. Backfill ──────────────────────────────────────────────────────────────
-- Los que hoy están sin usuario y en 'nuevo'. No toca 'cliente_activo' ni
-- 'inactivo' (gana la plata) ni 'bloqueado'. Idempotente: correrlo de nuevo no
-- cambia nada.
update contacts
set status = 'en_proceso'
where coalesce(trim(casino_username), '') = ''
  and status = 'nuevo';

-- ── 3. Verificación ──────────────────────────────────────────────────────────
-- V1. Cómo quedó el reparto por cuenta. 'en_proceso' tiene que coincidir con los
--     contactos sin usuario que nunca cargaron.
select t.name as cuenta, c.status,
       count(*) filter (where coalesce(trim(c.casino_username), '') = '') as sin_usuario,
       count(*) as total
from contacts c join tenants t on t.id = c.tenant_id
group by t.name, c.status
order by t.name, total desc;

-- V2. No debería quedar NINGUNA fila acá: un contacto sin usuario, sin cargas y
--     que no sea 'en_proceso' ni 'bloqueado' significa que el trigger no aplicó.
select t.name as cuenta, c.casino_username, c.status
from contacts c join tenants t on t.id = c.tenant_id
where coalesce(trim(c.casino_username), '') = ''
  and c.status not in ('en_proceso', 'bloqueado')
  and not exists (select 1 from comprobantes v where v.contact_id = c.id and v.estado = 'verificado');

-- V3. El trigger existe y está activo.
select tgname, tgenabled from pg_trigger where tgname = 'trg_contacts_sync_en_proceso';
