-- IRIS CRM — RPC fn_leads_ranking (Top Clientes por rango) — cap-1000 + .in() + CPU
--
-- /api/leads calculaba el ranking trayendo TODOS los comprobantes verificados del
-- rango sin paginar (cap-1000 de PostgREST → con >1000 el ranking subcontaba;
-- medido: "Este año" = 1065 > 1000) + agregaba en Node + `.in('id', ids)`.
--
-- Esta RPC agrega por contacto en Postgres (COUNT/SUM filter por tipo), separa
-- cargas de pagos, deja solo a quien cargó (HAVING) y ordena por monto de cargas.
-- Devuelve 1 fila por contacto con cargas (~decenas), no O(comprobantes). El rango
-- [from, to] es opcional (NULL = sin límite). SECURITY DEFINER + search_path fijo.
create or replace function fn_leads_ranking(
  p_tenant_id uuid,
  p_from      timestamptz,
  p_to        timestamptz
)
returns table (
  contact_id      uuid,
  cargas_total    integer,
  cargas_monto    numeric,
  pagos_total     integer,
  pagos_monto     numeric,
  phone           text,
  casino_username text,
  status          text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    agg.contact_id,
    agg.cargas_total::int,
    agg.cargas_monto,
    agg.pagos_total::int,
    agg.pagos_monto,
    c.phone,
    c.casino_username,
    c.status
  from (
    select
      contact_id,
      count(*) filter (where tipo = 'carga')                    as cargas_total,
      coalesce(sum(monto) filter (where tipo = 'carga'), 0)     as cargas_monto,
      count(*) filter (where tipo = 'pago')                     as pagos_total,
      coalesce(sum(monto) filter (where tipo = 'pago'), 0)      as pagos_monto
    from comprobantes
    where tenant_id = p_tenant_id
      and estado = 'verificado'
      and tipo in ('carga', 'pago')
      and (p_from is null or created_at >= p_from)
      and (p_to   is null or created_at <= p_to)
    group by contact_id
    having count(*) filter (where tipo = 'carga') > 0   -- ranking de cargas: solo quien cargó
  ) agg
  join contacts c on c.id = agg.contact_id and c.tenant_id = p_tenant_id
  order by agg.cargas_monto desc, agg.cargas_total desc;
$$;
