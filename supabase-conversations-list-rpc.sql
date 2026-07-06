-- IRIS CRM — RPC fn_conversations_list (fix de EGRESS #1: lista de Conversaciones)
--
-- Problema: GET /api/conversations hacía `select('*, messages!inner(*)')`, trayendo
-- el historial COMPLETO de mensajes de cada contacto en cada poll. La pantalla solo
-- necesita, por contacto: (a) el último mensaje (preview + clasificación de pendiente)
-- y (b) el conteo de entrantes sin leer para el badge numérico. Medido en prod
-- (tenant activo, 130 conversaciones): 529 KB gzip/request → 12,7 KB gzip/request (41×).
--
-- Solución: una función con dos LATERAL JOIN, en un solo viaje a la base:
--   · lm  → último mensaje (ORDER BY created_at DESC LIMIT 1; usa idx_messages_contact)
--   · pc  → COUNT de mensajes role<>'human' con created_at > last_read_at (badge)
-- Devuelve el contacto ya armado (to_jsonb(c.*)) con `messages` = [último] y
-- `pending_count`, para no cambiar el contrato que consume el frontend.
--
-- El INNER JOIN sobre `lm` replica el `messages!inner`: los contactos sin ningún
-- mensaje NO aparecen en la lista (igual que antes).
--
-- Se llama desde el service role (bypassa RLS), pero se define SECURITY DEFINER con
-- search_path fijo por consistencia con el resto de las fn_* del schema.

create or replace function fn_conversations_list(
  p_tenant_id uuid,
  p_status    text default null,
  p_search    text default null
)
returns table ("row" jsonb)   -- "row" va entre comillas: es palabra reservada en PostgreSQL
language sql
stable
security definer
set search_path = public
as $$
  select
    to_jsonb(c.*)
    || jsonb_build_object(
         'messages',      jsonb_build_array(to_jsonb(lm)),   -- 1 elemento: [último msg]
         'pending_count', coalesce(pc.cnt, 0)
       )
  from contacts c
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
  where c.tenant_id = p_tenant_id
    and (p_status is null or c.status = p_status)
    and (
      p_search is null
      or c.name ilike '%' || p_search || '%'
      or c.phone ilike '%' || p_search || '%'
    )
  order by lm.created_at desc;
$$;
