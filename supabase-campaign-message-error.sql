-- Motivo del fallo de envío de campaña (código/razón de Meta).
-- Idempotente. Correr a mano en Supabase → SQL editor (este proyecto ejecuta la DDL
-- manualmente).
--
-- Contexto: cuando un envío de plantilla falla, Meta manda en el webhook de status
-- un array errors:[{ code, title, message, error_data:{ details } }]. Hasta ahora el
-- handler (src/lib/meta/handler.ts → processStatus) marcaba failed e incrementaba
-- failed_count, pero DESCARTABA ese detalle → el fallo quedaba sin razón en ningún
-- lado (había que ir a los logs de runtime de Vercel). Estas columnas lo persisten
-- en la fila del mensaje, así se puede ver por qué falló cada destinatario.
--
-- OJO (patrón de este repo): `add column if not exists` es no-op si la columna ya
-- existía con otro tipo; verificá el esquema vivo si sospechás una migración a medias.

alter table campaign_message_status add column if not exists error_code    integer;
alter table campaign_message_status add column if not exists error_title   text;
alter table campaign_message_status add column if not exists error_message text;
