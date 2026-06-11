-- ─────────────────────────────────────────────────────────────────────────────
-- IRIS — Onboarding Wizard: columnas de WhatsApp por tenant
-- Correr ESTE bloque en el SQL Editor de Supabase (este proyecto NO tiene la
-- función exec_sql, así que el DDL no se puede correr por la API/service-role).
-- Es idempotente: se puede correr más de una vez sin romper nada.
--
-- Contexto: el wizard de alta de agentes (paso 4 "Número de WhatsApp") carga,
-- además del Phone Number ID que ya existía (tenants.whatsapp_phone_id), el
-- WABA ID y el número visible. Estas dos columnas no existían.
--
-- Nota: mientras esta migración NO se haya corrido, el wizard sigue funcionando
-- igual; simplemente NO guarda WABA ID ni número visible (los omite y avisa).
-- ─────────────────────────────────────────────────────────────────────────────

-- WhatsApp Business Account ID (WABA) del tenant. Informativo: el envío usa el
-- par (whatsapp_access_token, whatsapp_phone_id); el WABA se necesita para
-- registrar plantillas.
alter table tenants add column if not exists whatsapp_waba_id text;

-- Número visible/comercial del tenant (ej: +54 9 11 1234-5678). Solo display.
alter table tenants add column if not exists whatsapp_display_number text;
