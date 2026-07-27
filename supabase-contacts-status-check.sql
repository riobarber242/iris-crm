-- CHECK constraint de contacts.status: poner la lista al día.
-- Correr en Supabase → SQL editor, ANTES de supabase-en-proceso-por-usuario.sql.
-- Este proyecto NO tiene la RPC exec_sql, así que la DDL se ejecuta a mano.
--
-- EL BUG. El trigger de "En proceso" falló con:
--   new row for relation "contacts" violates check constraint "contacts_status_check"
-- El constraint vivo no acepta 'en_proceso', aunque la aplicación lo usa desde
-- siempre (ALLOWED_STATUS en /api/contacts, el selector de categoría, el bot).
--
-- CÓMO SE LLEGÓ ACÁ. supabase-schema.sql declara la lista original:
--   ('nuevo', 'en_proceso', 'activo', 'bloqueado')
-- pero en la base hay 209 contactos en 'cliente_activo' y 6 en 'inactivo', que
-- esa lista rechazaría. O sea que el constraint se reemplazó a mano en algún
-- momento —sin versionar— para admitir los nombres nuevos, y en el camino se
-- perdió 'en_proceso'. Es la misma familia de bug que messages_role_check contra
-- role='system': el CHECK quedó atrás del código y nadie se enteró hasta que
-- algo intentó escribir el valor que faltaba.
--
-- Estado real de los datos hoy (57.506 filas, verificado 2026-07-27):
--   nuevo 57.291 · cliente_activo 209 · inactivo 6 · en_proceso 0 · bloqueado 0
-- Ningún valor fuera de la lista nueva, así que la validación no puede fallar.

-- ── 1. Sacar el constraint viejo, sin asumir su nombre ───────────────────────
-- Se busca por columna en pg_constraint en vez de confiar en que se llame
-- contacts_status_check: si lo recrearon a mano, puede tener cualquier nombre.
-- Mismo criterio que supabase-cms-tenant-fk-cascade.sql.
do $$
declare
  r record;
begin
  for r in
    select con.conname
    from pg_constraint con
    join pg_attribute att
      on att.attrelid = con.conrelid
     and att.attnum = any (con.conkey)
    where con.conrelid = 'public.contacts'::regclass
      and con.contype  = 'c'
      and att.attname  = 'status'
  loop
    execute format('alter table public.contacts drop constraint %I', r.conname);
    raise notice 'Constraint dropeado: %', r.conname;
  end loop;
end $$;

-- ── 2. Ponerlo de nuevo con la lista completa ────────────────────────────────
-- La lista es la misma que ALLOWED_STATUS en src/app/api/contacts/route.ts. Si
-- algún día se agrega una categoría, hay que tocar los dos lados.
--
-- 'activo' (de la lista original) NO va: no lo escribe ningún camino del código
-- y no hay una sola fila con ese valor. El nombre vigente es 'cliente_activo'.
--
-- NOT VALID + VALIDATE en dos pasos: el ADD toma un lock fuerte pero no escanea
-- la tabla, y el VALIDATE la escanea con un lock más liviano. Con 57k filas es
-- instantáneo igual, pero es el patrón correcto sobre una tabla viva.
alter table public.contacts
  add constraint contacts_status_check
  check (status in ('nuevo', 'en_proceso', 'cliente_activo', 'inactivo', 'bloqueado'))
  not valid;

alter table public.contacts validate constraint contacts_status_check;

-- ── 3. Verificación ─────────────────────────────────────────────────────────
-- V1. La definición que quedó. Tiene que listar los 5 valores.
select conname, pg_get_constraintdef(oid) as definicion
from pg_constraint
where conrelid = 'public.contacts'::regclass and contype = 'c';

-- V2. Ningún valor huérfano fuera de la lista (tiene que dar 0 filas).
select status, count(*)
from contacts
where status is not null
  and status not in ('nuevo', 'en_proceso', 'cliente_activo', 'inactivo', 'bloqueado')
group by status;
