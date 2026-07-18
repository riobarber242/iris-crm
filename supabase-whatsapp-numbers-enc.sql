-- IRIS CRM — Cifrado de credenciales por número de WhatsApp (Etapa cifrado, PR1).
-- Correr en Supabase → SQL Editor ANTES de deployar el código del PR1. Idempotente.
--
-- Agrega las columnas cifradas (AES-256-GCM vía src/lib/secure-secret) que conviven
-- con las columnas planas existentes:
--   access_token_enc  ← cifra el access_token del número
--   app_secret_enc    ← cifra el app_secret del número (firma de webhooks)
--
-- Ambas nullable y sin default: agregarlas NO cambia el comportamiento (el código
-- viejo no las mira). El código del PR1 hace LECTURA DUAL: *_enc primero, y si no
-- hay/falla, cae a la columna plana. El texto plano NO se borra acá: se retira en
-- el PR5 (fail-closed), recién con evidencia.
--
-- ORDEN OBLIGATORIO: 1) correr este SQL → 2) confirmar que las columnas existen →
-- 3) deployar el código del PR1 → 4) correr el backfill
-- (POST /api/admin/whatsapp-numbers/encrypt-backfill). Si se deploya el código
-- ANTES de que existan las columnas, los SELECT de resolveCreds fallarían y el envío
-- caería al token global (número equivocado). Por eso el SQL va primero.

alter table whatsapp_numbers add column if not exists access_token_enc text;
alter table whatsapp_numbers add column if not exists app_secret_enc  text;
