-- Reclasificación de contactos (nuevo / cliente_activo / inactivo) en SQL.
-- Idempotente. Correr a mano en Supabase → SQL editor (no hay RPC exec_sql).
--
-- POR QUÉ: /api/cron/clasificar traía los contactos y los comprobantes a memoria
-- con tres selects sin paginar. PostgREST corta en 1000 filas, así que el cron
-- veía 1.000 de 55.252 contactos y 1.000 de 2.823 comprobantes verificados, y
-- además mezclaba todos los tenants en una sola bolsa. Consecuencias medidas el
-- 21/07/2026:
--   · Contactos con cargas quedaban en 'nuevo': reconcileContactStatus los ponía
--     bien al verificar el comprobante, y esa noche el cron —que no veía sus
--     comprobantes— los DEGRADABA de vuelta a 'nuevo' (liliana733js tenía 20
--     comprobantes verificados y figuraba como nuevo).
--   · Contactos con su última carga en junio seguían en 'cliente_activo' porque
--     caían fuera de la ventana de 1.000 y el cron ni los miraba.
--
-- Esta función hace todo del lado del servidor: sin traer filas, sin truncado y
-- sin límite de escala.
--
-- OJO: la regla tiene que quedar en sync con targetStatusFor() de
-- src/lib/contact-status.ts, que es la que usa el camino de un solo contacto
-- (reconcileContactStatus) y el fallback del cron.
--   · 'bloqueado'  → nunca se toca.
--   · 'en_proceso' → solo puede ascender a 'cliente_activo', nunca degradarse.
--   · resto        → verificado este mes = cliente_activo; verificado alguna vez
--                    = inactivo; nunca = nuevo.

-- Índice de apoyo para los EXISTS por contacto.
create index if not exists idx_comprobantes_contact_estado_created
  on comprobantes(contact_id, estado, created_at);

create or replace function reclassify_contacts(month_start timestamptz)
returns table(nuevo_status text, actualizados bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with objetivo as (
    select
      c.id,
      c.status as actual,
      case
        when exists (
          select 1 from comprobantes v
          where v.contact_id = c.id and v.estado = 'verificado' and v.created_at >= month_start
        ) then 'cliente_activo'
        when exists (
          select 1 from comprobantes v
          where v.contact_id = c.id and v.estado = 'verificado'
        ) then 'inactivo'
        else 'nuevo'
      end as destino
    from contacts c
    where c.status is distinct from 'bloqueado'
  ),
  cambios as (
    select o.id, o.destino
    from objetivo o
    where o.destino is distinct from o.actual
      -- no degradar un handoff operativo en curso
      and not (o.actual = 'en_proceso' and o.destino <> 'cliente_activo')
  ),
  aplicado as (
    update contacts c
    set status = k.destino
    from cambios k
    where c.id = k.id
    returning k.destino as destino
  )
  select a.destino::text, count(*)::bigint
  from aplicado a
  group by a.destino;
end;
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN — correr ANTES de dejar que el cron la use
-- ════════════════════════════════════════════════════════════════════════════

-- V1. La función existe.
select routine_name, data_type
from information_schema.routines
where routine_name = 'reclassify_contacts';

-- V2. SIMULACRO: qué cambiaría, sin escribir nada. Correr esto primero y
--     comparar con lo que espera el equipo antes de ejecutar la función.
with objetivo as (
  select
    c.tenant_id,
    c.status as actual,
    case
      when exists (select 1 from comprobantes v where v.contact_id = c.id and v.estado = 'verificado'
                     and v.created_at >= date_trunc('month', (now() at time zone 'America/Argentina/Buenos_Aires'))
                                          at time zone 'America/Argentina/Buenos_Aires') then 'cliente_activo'
      when exists (select 1 from comprobantes v where v.contact_id = c.id and v.estado = 'verificado') then 'inactivo'
      else 'nuevo'
    end as destino
  from contacts c
  where c.status is distinct from 'bloqueado'
)
select t.name as tenant, o.actual, o.destino, count(*) as contactos
from objetivo o
join tenants t on t.id = o.tenant_id
where o.destino is distinct from o.actual
  and not (o.actual = 'en_proceso' and o.destino <> 'cliente_activo')
group by t.name, o.actual, o.destino
order by t.name, contactos desc;
