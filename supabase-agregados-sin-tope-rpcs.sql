-- ─────────────────────────────────────────────────────────────────────────────
-- Agregados en la base para las pantallas que se topaban con las 1.000 filas de
-- PostgREST (max-rows): un select sin range devuelve como mucho 1.000 filas SIN
-- error, así que sumas/conteos hechos en Node salían por debajo de lo real.
--
-- Todas: language sql, stable, security definer, search_path fijo, y SOLO las
-- puede ejecutar service_role (el servidor). El tenant llega siempre como
-- parámetro desde la sesión y TODA consulta filtra por él.
--
-- Bloque A: funciones nuevas (OBLIGATORIO antes de deployar el commit 3).
-- Bloque B: cerrar a anon/authenticated las funciones que YA existían
--           (RECOMENDADO; independiente del deploy, ver nota).
--
-- Idempotente: se puede correr más de una vez. Pegar entero en SQL Editor.
-- ─────────────────────────────────────────────────────────────────────────────

-- ══ BLOQUE A ═════════════════════════════════════════════════════════════════

-- A1) Billetera del operador: últimos p_limit movimientos con el saldo corriendo
--     calculado sobre TODA la historia (window function). `total` = cantidad
--     total de movimientos de billetera del operador. Orden ascendente (como la
--     pantalla), el último es el más reciente.
create or replace function fn_caja_billetera_movimientos(
  p_tenant_id   uuid,
  p_operador_id uuid,
  p_limit       integer default 500
)
returns table (
  id              uuid,
  tipo            text,
  monto           bigint,
  bono            integer,
  billetera_delta bigint,
  saldo_corriendo numeric,
  comprobante_id  uuid,
  created_at      timestamptz,
  total           integer
)
language sql
stable
security definer
set search_path = public
as $$
  with movs as (
    select
      m.id, m.tipo, m.monto, m.bono, m.billetera_delta, m.comprobante_id, m.created_at,
      sum(m.billetera_delta) over (
        order by m.created_at, m.id
        rows between unbounded preceding and current row
      ) as saldo_corriendo,
      count(*) over () as total,
      row_number() over (order by m.created_at desc, m.id desc) as rn
    from movimientos m
    where m.tenant_id = p_tenant_id
      and m.operador_id = p_operador_id
      and m.billetera_delta <> 0
  )
  select id, tipo, monto, bono, billetera_delta, saldo_corriendo::numeric,
         comprobante_id, created_at, total::int
  from movs
  where rn <= least(greatest(coalesce(p_limit, 500), 1), 1000)
  order by created_at, id;
$$;

-- A2) Resumen del turno: suma de montos por tipo desde p_since.
create or replace function fn_caja_resumen_turno(
  p_tenant_id   uuid,
  p_operador_id uuid,
  p_since       timestamptz
)
returns table (tipo text, total numeric)
language sql
stable
security definer
set search_path = public
as $$
  select m.tipo, coalesce(sum(coalesce(m.monto, 0)), 0)::numeric
  from movimientos m
  where m.tenant_id = p_tenant_id
    and m.operador_id = p_operador_id
    and m.created_at >= p_since
  group by m.tipo;
$$;

-- A3) Recargas verificadas (cantidad + monto) en [p_gte, p_lt). null = sin borde.
create or replace function fn_comprobantes_verificados(
  p_tenant_id uuid,
  p_gte       timestamptz default null,
  p_lt        timestamptz default null
)
returns table (recargas integer, monto numeric)
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int, coalesce(sum(coalesce(c.monto, 0)), 0)::numeric
  from comprobantes c
  where c.tenant_id = p_tenant_id
    and c.estado = 'verificado'
    and (p_gte is null or c.created_at >= p_gte)
    and (p_lt  is null or c.created_at <  p_lt);
$$;

-- A4) Contactos por (status, provincia): alimenta la torta de estados y el mapa.
create or replace function fn_contacts_breakdown(p_tenant_id uuid)
returns table (status text, provincia text, n integer)
language sql
stable
security definer
set search_path = public
as $$
  select c.status, c.provincia, count(*)::int
  from contacts c
  where c.tenant_id = p_tenant_id
  group by c.status, c.provincia;
$$;

-- A5) Comprobantes por estado.
create or replace function fn_comprobantes_por_estado(p_tenant_id uuid)
returns table (estado text, n integer)
language sql
stable
security definer
set search_path = public
as $$
  select c.estado, count(*)::int
  from comprobantes c
  where c.tenant_id = p_tenant_id
  group by c.estado;
$$;

-- A6) Monto verificado por mes (año/mes en UTC, igual que el gráfico actual).
create or replace function fn_recargas_por_mes(
  p_tenant_id uuid,
  p_since     timestamptz
)
returns table (anio integer, mes integer, monto numeric)
language sql
stable
security definer
set search_path = public
as $$
  select
    extract(year  from (c.created_at at time zone 'UTC'))::int,
    extract(month from (c.created_at at time zone 'UTC'))::int,
    coalesce(sum(coalesce(c.monto, 0)), 0)::numeric
  from comprobantes c
  where c.tenant_id = p_tenant_id
    and c.estado = 'verificado'
    and c.created_at >= p_since
  group by 1, 2;
$$;

-- A7) Candidatos a "pendiente": mismo snapshot que fn_contacts_pending_snapshot
--     (contacto + su último mensaje) pero SOLO los que pueden ser pendientes:
--     con mensaje, sin leer y cuyo último mensaje no es de un humano. Son
--     exactamente los 3 casos en que classifyPending (lib/pending.ts) devuelve
--     null de entrada, así que la clasificación sigue en JS y da lo mismo. Pasa
--     de 1 fila por contacto (20.214 en Derki → se cortaba en 1.000) a solo los
--     no leídos.
create or replace function fn_contacts_pending_candidates(p_tenant_id uuid)
returns table (
  id                 uuid,
  conversation_state text,
  last_read_at       timestamptz,
  human_taken        boolean,
  last_role          text,
  last_msg_at        timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    c.conversation_state,
    c.last_read_at,
    c.human_taken,
    lm.role       as last_role,
    lm.created_at as last_msg_at
  from contacts c
  join lateral (
    select m.role, m.created_at
    from messages m
    where m.contact_id = c.id
    order by m.created_at desc
    limit 1
  ) lm on true
  where c.tenant_id = p_tenant_id
    and (c.last_read_at is null or c.last_read_at < lm.created_at)
    and lm.role is distinct from 'human';
$$;

-- A8) Envíos por campaña desde p_since (progreso del día del cronograma). Solo
--     cuenta campañas del tenant.
create or replace function fn_campaign_recipients_since(
  p_tenant_id    uuid,
  p_campaign_ids uuid[],
  p_since        timestamptz
)
returns table (campaign_id uuid, n integer)
language sql
stable
security definer
set search_path = public
as $$
  select r.campaign_id, count(*)::int
  from campaign_recipients r
  join campaigns k on k.id = r.campaign_id and k.tenant_id = p_tenant_id
  where r.campaign_id = any(p_campaign_ids)
    and r.sent_at >= p_since
  group by r.campaign_id;
$$;

-- Permisos de las nuevas: solo el servidor (service_role).
do $$
declare f regprocedure;
begin
  for f in
    select p.oid::regprocedure
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'fn_caja_billetera_movimientos', 'fn_caja_resumen_turno', 'fn_comprobantes_verificados',
        'fn_contacts_breakdown', 'fn_comprobantes_por_estado', 'fn_recargas_por_mes',
        'fn_contacts_pending_candidates', 'fn_campaign_recipients_since'
      )
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ══ BLOQUE B (recomendado) ═══════════════════════════════════════════════════
-- Las funciones que YA existían son security definer (se saltean el RLS) y hoy
-- las puede ejecutar la anon key, que es pública en el navegador: verificado
-- 19/10/2026 con fn_dashboard_montos, fn_contacts_pending_snapshot,
-- fn_dashboard_conv_counts, fn_dashboard_sla_first_human y fn_top_clients (200).
-- La app las llama TODAS desde el servidor con service_role, así que cerrarlas no
-- rompe nada. Las de trigger no se ven afectadas (los triggers no chequean el
-- permiso EXECUTE al dispararse). fn_caja_enabled / fn_casino_enabled quedan
-- abiertas a propósito por si alguna policy de RLS las usa.
do $$
declare f regprocedure;
begin
  for f in
    select p.oid::regprocedure
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'count_tenant_recipients_since', 'delete_contacts_batch',
        'fn_acreditar_traspaso', 'fn_aplicar_descarga', 'fn_aplicar_movimiento',
        'fn_borrar_movimiento', 'fn_cerrar_turno', 'fn_cobrar_descarga', 'fn_cobrar_sueldo',
        'fn_contacts_pending_snapshot', 'fn_conversations_list', 'fn_dashboard_chats_activos_hoy',
        'fn_dashboard_conv_counts', 'fn_dashboard_montos', 'fn_dashboard_sla_first_human',
        'fn_editar_movimiento_comprobante', 'fn_leads_ranking', 'fn_recargar_fichas',
        'fn_rechazar_descarga', 'fn_reset_total', 'fn_top_clients', 'fn_traspaso_directo',
        'fn_verificar_descarga', 'increment_campaign_counter', 'reclassify_contacts'
      )
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- Recarga el schema cache de PostgREST para que vea las funciones nuevas ya.
notify pgrst, 'reload schema';

-- Comprobación: debe listar las 8 nuevas con anon_puede = false.
select p.proname,
       has_function_privilege('anon', p.oid, 'execute')         as anon_puede,
       has_function_privilege('service_role', p.oid, 'execute') as service_puede
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like any (array['fn_%', 'delete_contacts_batch', 'increment_campaign_counter', 'reclassify_contacts', 'count_tenant_recipients_since'])
order by anon_puede desc, p.proname;
