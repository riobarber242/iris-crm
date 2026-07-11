-- Cronograma escalonado por semanas (ramp-up) para campañas grandes.
-- Idempotente. Correr a mano en Supabase → SQL editor (este proyecto ejecuta
-- la DDL manualmente; no hay auto-migración).
--
-- Contexto: es una CAPA NUEVA que se combina con el techo de Meta (daily_cap),
-- NO lo reemplaza. Mientras daily_cap es el techo de SEGURIDAD del portfolio de
-- Meta (destinatarios únicos del TENANT en ventana móvil de 24h), el ramp-up es
-- el RITMO deliberado de ESTA campaña, contado por DÍA CALENDARIO (hora AR) y por
-- semana calendario (lunes a domingo). El límite efectivo de cada día es
-- min(ramp de la semana, techo de Meta). Sin correr esta migración la feature
-- queda off (ramp_schedule nunca se guarda) sin romper el envío existente.

-- ── Cronograma semanal ───────────────────────────────────────────────────────
-- ramp_schedule: límite diario de mensajes por semana calendario, en orden.
--   Ej: {20,20,30,50} = Semana 1 y 2 a 20/día, Semana 3 a 30/día, Semana 4 a 50/día.
--   El índice 0 es la semana del lanzamiento (ver ramp_anchor). null = sin ramp
--   (la campaña usa el daily_cap fijo como hasta ahora).
alter table campaigns add column if not exists ramp_schedule integer[];

-- ramp_anchor: LUNES (hora AR) de la semana en que se lanzó la campaña. Sirve de
--   origen para calcular en qué semana del cronograma estamos hoy:
--     week_index = floor((lunes_de_hoy_AR - ramp_anchor) / 7 días)
--   Si la campaña arranca a mitad de semana (ej. jueves), ese bloque parcial cae
--   en week_index 0 → usa ramp_schedule[0] (Semana 1) igual. Pasada la última
--   semana definida, el índice se clampea al último escalón (continúa a ese ritmo
--   hasta terminar). null = sin ramp.
alter table campaigns add column if not exists ramp_anchor date;

-- ── Índice para el conteo por-campaña-por-día ────────────────────────────────
-- El ramp cuenta cuántos mensajes mandó ESTA campaña en el día calendario actual:
--   count(*) where campaign_id = X and sent_at >= inicio_del_día_AR.
-- Ya existen índices sueltos por campaign_id y por sent_at; el compuesto hace
-- este filtro combinado eficiente en tenants con muchos envíos.
create index if not exists idx_campaign_recipients_campaign_sent_at
  on campaign_recipients (campaign_id, sent_at);
