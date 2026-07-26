-- ─────────────────────────────────────────────────────────────────────────────
-- IRIS CRM — Plan LITE (PR0). Correr a mano en Supabase → SQL Editor.
-- Este proyecto NO tiene la RPC exec_sql, así que la DDL va a mano. Idempotente:
-- se puede correr más de una vez.
--
-- QUÉ HACE
--   1. Recicla el plan 'basic' (existía en el enum pero NINGÚN tenant lo usa)
--      como 'lite', el plan reducido para clientes nuevos.
--   2. Deja el CHECK de tenants.plan en (trial | lite | premium), reemplazando
--      cualquier restricción anterior sobre esa columna.
--   3. Fija el default de plan en 'trial' de forma explícita.
--
-- CONTEXTO: hasta ahora `plan` era metadata comercial (badge + validación del
-- PATCH de /api/tenants); no gateaba nada. A partir del PR1 pasa a ser la fuente
-- de qué secciones ve cada cliente, así que el conjunto de valores tiene que
-- quedar cerrado a nivel base y no sólo en el código.
--
-- ⚠️ Correr ESTO ANTES de deployar el código del PR1: el PATCH de tenants pasa a
-- aceptar 'lite' y rechazar 'basic'. Si el código sale primero, el admin podría
-- mandar 'lite' y la base lo rechazaría con un error de constraint.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Migración de valores. Hoy esto afecta 0 filas (Principal=trial,
--    Casino 17Star=premium, derqui17star=premium), pero queda por si alguna
--    quedó en 'basic' o sin plan.
update tenants set plan = 'lite'  where plan = 'basic';
update tenants set plan = 'trial' where plan is null;

-- 2. CHECK de valores válidos. Borramos primero CUALQUIER check que mencione la
--    columna plan (el original se creó a mano y no está versionado acá, así que
--    no conocemos su nombre) y recién después agregamos el nuevo. Al re-correr,
--    el propio tenants_plan_valid entra en el barrido y se recrea igual.
do $$
declare c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'tenants'::regclass
      and contype  = 'c'
      and pg_get_constraintdef(oid) ilike '%plan%'
  loop
    execute format('alter table tenants drop constraint %I', c.conname);
  end loop;

  alter table tenants
    add constraint tenants_plan_valid check (plan in ('trial', 'lite', 'premium'));
end $$;

-- 3. Default explícito: un tenant nuevo nace en 'trial' (features completas
--    mientras dura la prueba) y el admin lo baja a 'lite' o lo sube a 'premium'
--    desde el modal de Membresía. El alta por el wizard de onboarding NO setea
--    plan (ver src/lib/onboarding.ts:169-175), así que este default es el que
--    manda para los clientes nuevos.
alter table tenants alter column plan set default 'trial';

-- ── Verificación (correr y mirar la salida) ─────────────────────────────────
-- Esperado: los 3 tenants actuales con su plan, ninguno en 'basic'.
select id, name, plan, status, max_whatsapp_numbers
from tenants
order by created_at;

-- ── Pendiente MANUAL al dar de alta al cliente Lite ──────────────────────────
-- El cupo de números NO se deriva del plan (es la columna max_whatsapp_numbers,
-- que el admin edita desde Membresía). Para el cliente Lite hay que dejarlo en 1:
--
--   update tenants set plan = 'lite', max_whatsapp_numbers = 1 where id = '<uuid>';
