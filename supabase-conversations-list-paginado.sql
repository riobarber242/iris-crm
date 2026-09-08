-- IRIS CRM — fn_conversations_list PAGINADA (hallazgo 02 de la auditoría 08/09/2026)
--
-- Problema: la versión anterior devolvía TODAS las conversaciones del tenant en cada
-- llamada. Medido en prod: Casino 17Star = 857 filas, 691 KB crudo / 68 KB gzip,
-- ~1038 ms por request. Y esa llamada se dispara con cada evento de Realtime.
--
-- Cambios:
--   1. Paginación KEYSET por (último mensaje, id) DESC. Keyset y no offset porque
--      esta lista se REORDENA sola: cada mensaje nuevo sube una conversación al
--      tope, y con offset eso duplica o saltea filas entre páginas (mismo criterio
--      que la bandeja de comprobantes).
--   2. Los filtros bajan a SQL. Es obligatorio: con la lista paginada, filtrar en el
--      cliente sólo miraría la página cargada y daría resultados falsos.
--        · p_status         → estado; 'bloqueado' mira c.blocked (igual que la UI)
--        · p_search         → usuario de casino, nombre o teléfono
--        · p_unread_only    → ver la NOTA de abajo
--   3. El trabajo caro (to_jsonb del contacto + el COUNT de pendientes) se hace
--      SOLO sobre la página, no sobre las 857 filas. La CTE `page` resuelve primero
--      qué ids entran usando el lateral barato (idx_messages_contact), y recién
--      después se arma el JSON. Sin esto el LIMIT no garantizaba ahorro: el planner
--      podía calcular los dos laterales para todos los contactos antes de ordenar.
--
-- NOTA sobre p_unread_only — el filtro "No leídos" de la UI:
-- La regla de pendiente vive en lib/pending.ts (classifyPending) y es la ÚNICA
-- fuente de verdad, compartida por el badge, el contador y el dashboard. NO se
-- replica acá: duplicarla en SQL es exactamente cómo se desincronizan. Lo que hace
-- este filtro es un PRE-FILTRO CONSERVADOR con las dos condiciones de entrada de
-- classifyPending (no leída + el último mensaje no es de un humano); el cliente
-- después aplica classifyPending sobre la página y descarta lo que sobra.
--   ⚠️ Si tocás esto, tiene que seguir siendo un SUPERCONJUNTO de classifyPending:
--   puede devolver de más (el cliente filtra), nunca de menos (se perderían filas).
--
-- Compatibilidad de deploy: p_limit tiene default NULL, y en PostgreSQL `LIMIT NULL`
-- es "sin límite". Una llamada con los 3 argumentos viejos se comporta EXACTAMENTE
-- como antes, así que la migración se puede correr antes del deploy sin romper la
-- versión en producción.

-- La firma cambia, así que hay que soltar la vieja: `create or replace` crearía una
-- sobrecarga y una llamada de 3 argumentos quedaría ambigua ("function is not unique").
drop function if exists fn_conversations_list(uuid, text, text);

create or replace function fn_conversations_list(
  p_tenant_id   uuid,
  p_status      text        default null,
  p_search      text        default null,
  p_unread_only boolean     default false,
  p_limit       int         default null,   -- NULL = sin límite (comportamiento viejo)
  p_before_at   timestamptz default null,   -- cursor keyset: created_at del último visto
  p_before_id   uuid        default null    -- cursor keyset: desempate por id
)
returns table ("row" jsonb)   -- "row" va entre comillas: es palabra reservada en PostgreSQL
language sql
stable
security definer
set search_path = public
as $$
  with page as (
    -- Paso barato: qué contactos entran en la página. Sólo el lateral del último
    -- mensaje (idx_messages_contact) y los filtros; nada de JSON ni de COUNT.
    select c.id, lm.created_at as last_at
    from contacts c
    join lateral (
      select m.role, m.created_at
      from messages m
      where m.contact_id = c.id
      order by m.created_at desc
      limit 1
    ) lm on true
    where c.tenant_id = p_tenant_id
      -- Estado. 'bloqueado' no es un status: es la columna blocked (igual que la UI).
      and (
        p_status is null
        or (p_status = 'bloqueado' and c.blocked is true)
        or (p_status <> 'bloqueado' and lower(c.status) = p_status)
      )
      -- Búsqueda: usuario de casino, nombre o teléfono (las tres de la UI).
      and (
        p_search is null
        or c.casino_username ilike '%' || p_search || '%'
        or c.name            ilike '%' || p_search || '%'
        or c.phone           ilike '%' || p_search || '%'
      )
      -- Pre-filtro conservador de "no leídas" (ver NOTA de arriba).
      and (
        not p_unread_only
        or (
          (c.last_read_at is null or lm.created_at > c.last_read_at)
          and lm.role <> 'human'
        )
      )
      -- Cursor keyset: la página siguiente arranca estrictamente después del último
      -- visto, en el mismo orden compuesto que el ORDER BY.
      and (
        p_before_at is null
        or p_before_id is null
        or (lm.created_at, c.id) < (p_before_at, p_before_id)
      )
    order by lm.created_at desc, c.id desc
    limit p_limit
  )
  select
    to_jsonb(c.*)
    || jsonb_build_object(
         'messages',      jsonb_build_array(to_jsonb(lm)),   -- 1 elemento: [último msg]
         'pending_count', coalesce(pc.cnt, 0)
       )
  from page p
  join contacts c on c.id = p.id
  join lateral (
    select m.role, m.content, m.created_at
    from messages m
    where m.contact_id = c.id
    order by m.created_at desc
    limit 1
  ) lm on true
  left join lateral (
    select count(*) as cnt
    from messages m
    where m.contact_id = c.id
      and m.role <> 'human'
      and (c.last_read_at is null or m.created_at > c.last_read_at)
  ) pc on true
  order by p.last_at desc, c.id desc;
$$;
