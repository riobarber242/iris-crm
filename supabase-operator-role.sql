-- ─────────────────────────────────────────────────────────────────────────────
-- IRIS — Asegurar que agents.role acepta el rol 'operator'
-- Correr ESTE bloque en el SQL Editor de Supabase (este proyecto NO tiene la
-- función exec_sql, así que el DDL no se puede correr por la API/service-role).
-- Es idempotente: se puede correr más de una vez sin romper nada.
--
-- Contexto: la migración original (supabase-auth-migration.sql) creó el CHECK
-- como role in ('admin','agent'). El código ya usa 'operator', así que el
-- constraint tiene que aceptar los tres valores o fallan los INSERT/UPDATE.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Soltar el CHECK existente sobre `role`, sea cual sea su nombre.
--    (Recorremos pg_constraint porque el nombre autogenerado puede variar:
--     agents_role_check, agents_role_check1, etc.)
do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'agents'::regclass
      and con.contype  = 'c'
      and pg_get_constraintdef(con.oid) ilike '%role%'
  loop
    execute format('alter table agents drop constraint %I', c.conname);
  end loop;
end $$;

-- 2. Recrear el CHECK con los tres roles permitidos.
alter table agents
  add constraint agents_role_check
  check (role in ('admin', 'agent', 'operator'));

-- 3. Verificación (opcional): debería devolver el constraint recién creado.
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'agents'::regclass and contype = 'c';
