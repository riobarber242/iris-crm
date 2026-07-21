-- Línea EMISORA de la campaña, separada del filtro de destinatarios.
-- Idempotente. Correr a mano en Supabase → SQL editor (no hay RPC exec_sql).
--
-- Contexto: hasta ahora campaigns.target_number_id / target_number_ids servían
-- para DOS cosas a la vez: filtrar qué contactos entraban en la campaña y,
-- de rebote, decidir por qué número salía cada mensaje (porque el envío usaba
-- contact.whatsapp_number_id y el filtro garantizaba que coincidieran).
--
-- Esta columna separa los dos conceptos:
--   · sender_number_ids  = desde qué línea(s) SALE la campaña (elección libre del
--                          operador, todas de la misma WABA porque las plantillas
--                          viven en la WABA).
--   · target_number_id(s) = filtro de contactos LEGACY. El asistente ya no los
--                          escribe, pero se siguen leyendo para que las campañas
--                          creadas antes de este cambio se resuelvan igual que antes.
--
-- null / array vacío = modo legacy: cada contacto recibe por SU línea habitual,
-- que es exactamente el comportamiento anterior a este cambio.
--
-- OJO (patrón de este repo): `add column if not exists` es no-op si la columna ya
-- existía con otro tipo; verificá el esquema vivo si sospechás una migración a medias.

alter table campaigns add column if not exists sender_number_ids uuid[];


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════

-- V1. La columna existe, es un array de uuid y es nullable.
select column_name, data_type, udt_name, is_nullable
from information_schema.columns
where table_name = 'campaigns' and column_name = 'sender_number_ids';

-- V2. Ninguna campaña existente queda con emisora (todas siguen en modo legacy).
--     Esperado: sender_number_ids null en el 100% de las filas.
select
  count(*)                                          as campanas,
  count(*) filter (where sender_number_ids is null) as sin_emisora
from campaigns;
