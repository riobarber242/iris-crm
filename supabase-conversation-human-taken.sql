-- ============================================================================
-- IRIS CRM — Campo human_taken en contacts (indicadores naranja/rojo, punto 3)
-- Proyecto Supabase: sqovutbnotcwyygsacjx
-- ----------------------------------------------------------------------------
-- Agrega un booleano separado de conversation_state para marcar que "un humano
-- ya abrió/agarró esta conversación". A partir de ahí, cualquier mensaje nuevo
-- entrante se muestra en 🔴 (nunca vuelve a 🟠). Se separa de conversation_state
-- a propósito, para no sobrecargar 'done' (que ya significaba dos cosas).
--
-- Lógica de color (src/lib/pending.ts):
--   sin color  → el bot está haciendo onboarding activo (conversation_state en
--                greeting/asked_intention/waiting_screenshot/asked_if_loader/asked_name)
--   🟠 naranja → bot terminó / entrante sin flujo de bot, esperando un humano
--   🔴 rojo    → human_taken=true (ya la agarró un humano) o known_client (cliente reconocido)
--
-- CÓMO CORRERLO: Supabase Dashboard → SQL Editor → pegar y ejecutar.
-- Es seguro e idempotente (ADD COLUMN IF NOT EXISTS + UPDATE con guardas).
-- ============================================================================

BEGIN;

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS human_taken boolean NOT NULL DEFAULT false;

-- Backfill: marcar como "ya la agarró un humano" toda conversación que YA fue
-- abierta (last_read_at) o que YA tuvo un mensaje de un operador humano, para
-- que un cliente que vuelve a una conversación ya atendida siga en 🔴 (no 🟠).
UPDATE public.contacts c
SET human_taken = true
WHERE human_taken = false
  AND (
    c.last_read_at IS NOT NULL
    OR EXISTS (SELECT 1 FROM public.messages m WHERE m.contact_id = c.id AND m.role = 'human')
  );

-- Verificación: cuántas quedaron marcadas.
SELECT
  count(*)                                   AS total_contacts,
  count(*) FILTER (WHERE human_taken)        AS ya_tomadas,
  count(*) FILTER (WHERE NOT human_taken)    AS sin_tomar
FROM public.contacts;

COMMIT;
-- Si algo se ve raro, en lugar del COMMIT: ROLLBACK;
