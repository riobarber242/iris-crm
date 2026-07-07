-- Envío escalonado de campañas respetando el límite diario real de Meta.
-- Idempotente. Correr a mano en Supabase → SQL editor (este proyecto ejecuta
-- la DDL manualmente).
--
-- Contexto: el límite de Meta es por PORTFOLIO de negocio (compartido por todas
-- las líneas del tenant) y se cuenta como destinatarios ÚNICOS en una ventana
-- MÓVIL de 24h. Acá guardamos el techo elegido en el wizard y el estado de pausa;
-- el conteo "usado en las últimas 24h" se deriva de campaign_recipients.sent_at.

-- ── Techo diario y estado de pausa por campaña ───────────────────────────────
-- daily_cap: techo ABSOLUTO elegido en el wizard (margen % × límite real de Meta),
--   ya resuelto a un número al lanzar. null = sin tope (feature off / límite ilimitado
--   o ilegible). El pacing solo actúa si daily_cap no es null.
alter table campaigns add column if not exists daily_cap     integer;
-- paused_reason: por qué se pausó. null = no está pausada por el sistema. Valores:
--   'daily_limit'      = techo de Meta alcanzado (retoma cuando se libere cupo, ~otro día).
--   'fuera_de_horario' = fuera de la ventana horaria de la campaña (retoma al volver a entrar).
--   'auto_resume'      = continuación del cron (una tanda se cortó por tiempo).
alter table campaigns add column if not exists paused_reason text;
alter table campaigns add column if not exists paused_at     timestamptz;

-- ── Ventana horaria de envío (hora Argentina, UTC−3 sin DST) ─────────────────
-- Minutos desde medianoche AR: 480 = 08:00, 1200 = 20:00. Solo mismo día (se valida
-- start < end en el wizard). null = sin restricción horaria (campañas viejas / fallback).
-- Fuera de [start, end) la campaña se pausa con paused_reason='fuera_de_horario'.
alter table campaigns add column if not exists window_start_min smallint;
alter table campaigns add column if not exists window_end_min   smallint;

-- ── Índice para el conteo de la ventana móvil de 24h ─────────────────────────
-- El conteo filtra campaign_recipients por sent_at >= now()-24h. Sin índice sería
-- un scan; con tenants grandes conviene tenerlo.
create index if not exists idx_campaign_recipients_sent_at on campaign_recipients (sent_at);

-- ── Conteo de destinatarios únicos del tenant en una ventana ─────────────────
-- Suma TODAS las líneas del tenant (el límite de Meta es compartido por el
-- portfolio). count(distinct contact_id) = destinatarios únicos, que es la unidad
-- que consume el límite de Meta. `since` = borde de la ventana (now()-24h).
create or replace function count_tenant_recipients_since(tenant uuid, since timestamptz)
returns integer language sql stable as $$
  select count(distinct cr.contact_id)::int
  from campaign_recipients cr
  join campaigns c on c.id = cr.campaign_id
  where c.tenant_id = tenant
    and cr.sent_at >= since;
$$;
