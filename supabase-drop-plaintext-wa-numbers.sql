-- IRIS CRM — Limpieza PR5 (parte 1): dropear el texto plano de whatsapp_numbers.
-- Correr en Supabase → SQL Editor. Este proyecto NO tiene la RPC exec_sql.
--
-- CUÁNDO CORRERLA: DESPUÉS de deployar el código de este PR. El código nuevo ya
-- no nombra estas columnas (ni en selects, ni en inserts, ni en updates); recién
-- entonces es seguro dropearlas. Si se corre antes del deploy, el código viejo
-- que todavía las selecciona/escribe rompería.
--
-- Contexto: los tokens/app_secrets viven cifrados en access_token_enc /
-- app_secret_enc desde el PR1, y el PR5 dejó el texto plano en NULL (fail-closed).
-- Estas columnas ya son dato muerto: no se pierde nada al dropearlas.
--
-- Idempotente: IF EXISTS → correrla dos veces no falla.

alter table whatsapp_numbers drop column if exists access_token;
alter table whatsapp_numbers drop column if exists app_secret;

-- Verificación (debe devolver solo las columnas *_enc):
-- select column_name from information_schema.columns
-- where table_name = 'whatsapp_numbers' and column_name like '%token%' or column_name like '%secret%';
