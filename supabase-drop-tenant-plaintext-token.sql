-- IRIS CRM — Limpieza PR5 (parte 2): dropear tenants.whatsapp_access_token.
-- Correr en Supabase → SQL Editor. Este proyecto NO tiene la RPC exec_sql.
--
-- CUÁNDO CORRERLA: DESPUÉS de deployar el código de este PR. Se eliminó el
-- fallback legacy de resolveCreds (client.ts) que leía esta columna sin cifrar,
-- y los selects/inserts/updates de las rutas de tenants y del wizard de
-- onboarding dejaron de nombrarla. Si se corre antes del deploy, el código viejo
-- rompería.
--
-- Contexto: era la vía vieja 1:1 tenant↔token en texto plano, anterior a la
-- tabla whatsapp_numbers. Estaba vacía (NULL) en los tres tenants → dato muerto.
-- El token de cada línea vive cifrado en whatsapp_numbers.access_token_enc.
--
-- Idempotente: IF EXISTS → correrla dos veces no falla.

alter table tenants drop column if exists whatsapp_access_token;

-- Verificación (no debe devolver filas):
-- select column_name from information_schema.columns
-- where table_name = 'tenants' and column_name = 'whatsapp_access_token';
