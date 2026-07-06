-- IRIS CRM — RPCs para aliviar unread_counts y dashboard_stats (egress + CPU)
--
-- Problema: ambos endpoints hacían un SCAN COMPLETO de `messages` para derivar
-- "último mensaje por contacto" (traían O(mensajes) filas para procesar en Node),
-- y dashboard_stats además traía filas para contar únicos / promediar en Node.
-- Medido (Casino 17Star, 792 contactos / 7.453 msgs): el full scan son 84 KB gzip
-- por corrida; unread_counts se pollea cada 15 s. Estas RPCs mueven la agregación
-- a Postgres: se transfieren números / 1 fila por contacto, no la tabla entera.
--
-- classifyPending NO se replica en SQL a propósito: es la única fuente de verdad
-- (lib/pending.ts, compartida por sidebar/lista/dashboard) y depende de
-- BOT_FLOW_STATES (TS). fn_contacts_pending_snapshot devuelve 1 fila por contacto
-- con su último mensaje; la clasificación sigue en JS sobre ~792 filas.
--
-- Se llaman desde el service role; SECURITY DEFINER + search_path fijo por
-- consistencia con el resto de las fn_* del schema. Todas STABLE (solo lectura).

-- ── (a) Snapshot por contacto: contacto + su ÚLTIMO mensaje ───────────────────
-- Compartida por unread_counts y dashboard_stats (bloque de pendientes).
-- LEFT JOIN LATERAL: los contactos SIN mensajes también salen (last_* = NULL),
-- igual que antes (classifyPending los trata como no-pendientes). Usa el índice
-- idx_messages_contact (contact_id, created_at) para el ORDER BY ... LIMIT 1.
create or replace function fn_contacts_pending_snapshot(p_tenant_id uuid)
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
  left join lateral (
    select m.role, m.created_at
    from messages m
    where m.contact_id = c.id
    order by m.created_at desc
    limit 1
  ) lm on true
  where c.tenant_id = p_tenant_id;
$$;

-- ── (b) Conteo de conversaciones por período (únicos), en 1 sola pasada ───────
-- Reemplaza 4 selects que traían todos los contact_id de cada período para contar
-- únicos en Node. Escanea desde el borde más temprano (prev_start) una sola vez.
create or replace function fn_dashboard_conv_counts(
  p_tenant_id   uuid,
  p_today_start timestamptz,
  p_week_start  timestamptz,
  p_month_start timestamptz,
  p_prev_start  timestamptz,
  p_prev_end    timestamptz
)
returns table (
  conv_today      integer,
  conv_week       integer,
  conv_month      integer,
  conv_prev_month integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(distinct contact_id) filter (where created_at >= p_today_start)::int,
    count(distinct contact_id) filter (where created_at >= p_week_start)::int,
    count(distinct contact_id) filter (where created_at >= p_month_start)::int,
    count(distinct contact_id) filter (where created_at >= p_prev_start
                                          and created_at <  p_prev_end)::int
  from messages
  where tenant_id = p_tenant_id
    and created_at >= least(p_prev_start, p_week_start, p_month_start, p_today_start);
$$;

-- ── (c) SLA: promedio (min) desde que el contacto escribe hasta el 1er HUMANO ──
-- Reemplaza traer 30 días de mensajes y calcular el promedio en Node. Reglas
-- idénticas a la versión JS:
--   · Solo cuentan roles 'user' y 'human' ('assistant'/bot NO frena el cronómetro).
--   · El cronómetro arranca en un 'user' que abre ventana (el anterior fue 'human'
--     o es el primero); un 'user' mientras ya está pendiente NO reinicia.
--   · Cierra con el 1er 'human' posterior. gap = human - user_inicial.
-- Gaps-and-islands: se agrupa por (contacto, nº de aperturas acumuladas) y por
-- grupo se toma el user inicial y el primer human.
create or replace function fn_dashboard_sla_first_human(
  p_tenant_id    uuid,
  p_window_start timestamptz
)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  with fm as (
    select contact_id, role, created_at, id,
           lag(role) over (partition by contact_id order by created_at, id) as prev_role
    from messages
    where tenant_id = p_tenant_id
      and created_at >= p_window_start
      and role in ('user', 'human')
  ),
  grp as (
    select contact_id, role, created_at,
           case when role = 'user' and (prev_role is null or prev_role = 'human') then 1 else 0 end as is_start,
           sum(case when role = 'user' and (prev_role is null or prev_role = 'human') then 1 else 0 end)
             over (partition by contact_id order by created_at, id) as g
    from fm
  ),
  pairs as (
    select contact_id, g,
           min(created_at) filter (where is_start = 1)     as start_ts,
           min(created_at) filter (where role = 'human')   as resp
    from grp
    group by contact_id, g
  )
  select avg(extract(epoch from (resp - start_ts)) / 60.0)
  from pairs
  where start_ts is not null and resp is not null and resp > start_ts;
$$;

-- ── (d) Chats activos hoy en gestión manual — sin el .in(opIds) ───────────────
-- Reemplaza: select de opIds + .in('contact_id', opIds) (riesgo 414 si opIds
-- crece). Join directo contacts×messages → 1 número.
create or replace function fn_dashboard_chats_activos_hoy(
  p_tenant_id   uuid,
  p_today_start timestamptz
)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(distinct m.contact_id)::int
  from messages m
  join contacts c on c.id = m.contact_id
  where m.tenant_id = p_tenant_id
    and m.created_at >= p_today_start
    and (c.conversation_state in ('done', 'en_proceso') or c.status = 'en_proceso');
$$;
