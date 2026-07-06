-- IRIS CRM — RPCs para top-clientes y montos del dashboard (cap-1000 + .in() + CPU)
--
-- Problema (mismo patrón "traer todo y procesar en Node" + cap-1000 de PostgREST):
--  · iris-ai listTopClients traía TODOS los comprobantes verificados sin paginar
--    (PostgREST corta en 1000 filas) → con >1000 el ranking sale MAL. Medido en
--    Casino 17Star: 1.060 verificados → subcontaba. Además hacía `.in('id', ids)`
--    con todos los contactos con verificado (riesgo 414 si crece).
--  · dashboard_stats sumaba/contaba montos trayendo las filas a Node, con el mismo
--    cap-1000 latente (hoy los períodos están < 1000).
--
-- Solución: agregar en Postgres. SECURITY DEFINER + search_path fijo, STABLE.

-- ── Top clientes por monto verificado, ya rankeado y con datos del contacto ────
-- GROUP BY + SUM + LIMIT en SQL (sin cap-1000, sin traer todo a Node). El LEFT JOIN
-- preserva la semántica vieja: si el contacto fue borrado, la fila igual aparece
-- (campos en NULL), como cuando `byId.get(id)` no encontraba el contacto.
create or replace function fn_top_clients(p_tenant_id uuid, p_limit integer)
returns table (
  nombre               text,
  casino_username      text,
  telefono             text,
  estado               text,
  recargas_verificadas integer,
  monto_total          numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.name            as nombre,
    c.casino_username,
    c.phone           as telefono,
    c.status          as estado,
    agg.total::int    as recargas_verificadas,
    agg.monto         as monto_total
  from (
    select contact_id,
           count(*)                as total,
           sum(coalesce(monto, 0)) as monto
    from comprobantes
    where tenant_id = p_tenant_id and estado = 'verificado'
    group by contact_id
    order by sum(coalesce(monto, 0)) desc
    limit p_limit
  ) agg
  left join contacts c on c.id = agg.contact_id and c.tenant_id = p_tenant_id
  order by agg.monto desc;
$$;

-- ── Montos verificados del dashboard: conteos + sumas por período, 1 pasada ────
-- Reemplaza 3 selects de comprobantes que se sumaban/contaban en Node. Escanea
-- desde el borde más temprano (prev_start) una sola vez. (monto_hoy no se usa: el
-- endpoint solo necesita la CANTIDAD de recargas de hoy.)
create or replace function fn_dashboard_montos(
  p_tenant_id   uuid,
  p_today_start timestamptz,
  p_month_start timestamptz,
  p_prev_start  timestamptz,
  p_prev_end    timestamptz
)
returns table (
  recargas_hoy  integer,
  recargas_mes  integer,
  monto_mes     numeric,
  recargas_prev integer,
  monto_prev    numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*) filter (where created_at >= p_today_start)::int,
    count(*) filter (where created_at >= p_month_start)::int,
    coalesce(sum(coalesce(monto, 0)) filter (where created_at >= p_month_start), 0),
    count(*) filter (where created_at >= p_prev_start and created_at < p_prev_end)::int,
    coalesce(sum(coalesce(monto, 0)) filter (where created_at >= p_prev_start and created_at < p_prev_end), 0)
  from comprobantes
  where tenant_id = p_tenant_id and estado = 'verificado'
    and created_at >= least(p_prev_start, p_month_start, p_today_start);
$$;
