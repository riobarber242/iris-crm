-- ============================================================================
-- IRIS CRM — Activar Row Level Security (RLS) en las 23 tablas del schema public
-- Proyecto Supabase: sqovutbnotcwyygsacjx
-- ----------------------------------------------------------------------------
-- Contexto: el Security Advisor reportó "RLS Disabled in Public" en 23 tablas.
-- La app NO accede a estas tablas con la anon key desde el navegador para CRUD:
-- toda lectura/escritura pasa por API routes del servidor con la service_role
-- key, y la service_role IGNORA RLS por diseño (atributo BYPASSRLS). Por eso
-- activar RLS sin políticas = denegar anon/authenticated, sin romper la app.
--
-- Las 6 tablas del "Grupo B" (messages, internal_messages, comprobantes,
-- movimientos, contacts, leads) además se escuchan por Realtime desde el
-- navegador con la anon key. Al activar RLS, ese Realtime deja de emitir
-- eventos a anon -> el tiempo real se "apaga", PERO todos los componentes
-- tienen polling de respaldo (re-fetch por API cada 8-15s), así que no se
-- rompe nada: solo pierde inmediatez. (Fase 2 pendiente: migrar messages e
-- internal_messages a Broadcast desde el servidor.)
--
-- CÓMO CORRERLO de forma segura (Supabase Dashboard -> SQL Editor):
--   1. Pegá TODO este script y ejecutá. El SQL Editor lo corre como una sola
--      transacción y hace COMMIT automático solo si no hubo error.
--   2. Las pruebas de abajo (SET ROLE anon / service_role) NO lanzan error:
--      anon devuelve 0 filas (RLS bloquea), service_role devuelve filas.
--      Revisá esos resultados antes de confiar en el COMMIT.
--   3. Si querés inspeccionar ANTES de confirmar: seleccioná y corré desde el
--      BEGIN hasta la última prueba (sin el COMMIT). Si te convence, corré el
--      COMMIT. Si algo se ve raro, corré ROLLBACK; (ver al final).
-- ============================================================================

BEGIN;

-- ---------- Grupo A — 17 tablas que el navegador nunca toca ----------
ALTER TABLE public.tenants                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quick_replies           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.internal_room_reads     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.services                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_log            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaigns               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agents                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operador_billetera      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fichas_stock            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fichas_recargas         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.traspasos               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cierres_turno           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.internal_rooms          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_recipients     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_templates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_message_status ENABLE ROW LEVEL SECURITY;

-- ---------- Grupo B — 6 tablas con Realtime (pierden inmediatez, no se rompen) ----------
ALTER TABLE public.messages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.internal_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comprobantes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.movimientos       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads             ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- PRUEBAS dentro de la misma transacción (no commitean nada por sí solas)
-- ============================================================================

-- (1) Como anon: con RLS activo y sin políticas, debe devolver 0 filas.
SET ROLE anon;
SELECT 'anon ve messages'     AS prueba, count(*) AS filas FROM public.messages;
SELECT 'anon ve movimientos'  AS prueba, count(*) AS filas FROM public.movimientos;
SELECT 'anon ve contacts'     AS prueba, count(*) AS filas FROM public.contacts;
SELECT 'anon ve comprobantes' AS prueba, count(*) AS filas FROM public.comprobantes;
RESET ROLE;

-- (2) Como service_role: bypassa RLS, debe devolver el conteo real (>0 si hay datos).
SET ROLE service_role;
SELECT 'service_role ve messages'    AS prueba, count(*) AS filas FROM public.messages;
SELECT 'service_role ve movimientos' AS prueba, count(*) AS filas FROM public.movimientos;
SELECT 'service_role ve contacts'    AS prueba, count(*) AS filas FROM public.contacts;
RESET ROLE;

-- (3) Verificar que las 23 quedaron con RLS activo (relrowsecurity = true).
SELECT c.relname AS tabla, c.relrowsecurity AS rls_activo
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
    'tenants','contacts','comprobantes','leads','quick_replies','messages',
    'internal_room_reads','services','settings','activity_log','campaigns',
    'agents','operador_billetera','fichas_stock','fichas_recargas','traspasos',
    'movimientos','cierres_turno','internal_rooms','campaign_recipients',
    'internal_messages','whatsapp_templates','campaign_message_status'
  )
ORDER BY c.relrowsecurity, c.relname;
-- Esperado: las 23 con rls_activo = true.

-- ============================================================================
-- Si TODO se ve bien (anon=0, service_role>0, las 23 en true) -> confirmar:
COMMIT;

-- Si algo se ve raro, en lugar del COMMIT corré:
-- ROLLBACK;
-- ============================================================================
