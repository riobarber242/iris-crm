-- Motivo del fallo de envío de un mensaje del chat (código/razón de Meta).
-- Idempotente. Correr a mano en Supabase → SQL editor (este proyecto ejecuta la
-- DDL manualmente; no hay RPC exec_sql).
--
-- Contexto: cuando un envío falla, Meta manda en el webhook de status un array
-- errors:[{ code, title, message, error_data:{ details } }]. Eso YA se persiste
-- para los envíos de campaña (supabase-campaign-message-error.sql → columnas
-- error_* en campaign_message_status), pero para los mensajes del chat 1 a 1 se
-- descartaba: processStatus solo escribía status='failed' y el motivo quedaba
-- únicamente en un console.warn de los logs de Vercel.
--
-- Caso real que motivó esto (21/07/2026, tenant derqui17star): 8 mensajes
-- salientes seguidos en 'failed' con la ventana de 24h abierta, y no había forma
-- de saber por qué sin abrir los logs de runtime.
--
-- Mismos nombres que en campaign_message_status, a propósito, para que las dos
-- tablas se lean igual.
--
-- OJO (patrón de este repo): `add column if not exists` es no-op si la columna ya
-- existía con otro tipo; verificá el esquema vivo si sospechás una migración a medias.

alter table messages add column if not exists error_code    integer;
alter table messages add column if not exists error_title   text;
alter table messages add column if not exists error_message text;


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════

-- V1. Las 3 columnas existen y son nullable.
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'messages' and column_name in ('error_code', 'error_title', 'error_message')
order by column_name;

-- V2. Fallos ya registrados (van a tener error_* en null hasta que Meta mande un
--     webhook de status NUEVO: lo viejo no se puede recuperar, Meta no lo reenvía).
select date_trunc('hour', created_at) as hora, count(*) as fallidos
from messages
where status = 'failed'
group by 1 order by 1 desc limit 10;
