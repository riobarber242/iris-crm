-- ============================================================================
-- IRIS CRM — Fijar search_path en las funciones del schema public
-- Proyecto Supabase: sqovutbnotcwyygsacjx
-- Fix del warning "Function Search Path Mutable" del Security Advisor (17 funciones)
-- ----------------------------------------------------------------------------
-- Qué hace: agrega "SET search_path = public" a cada función con search_path
-- mutable. Es el fix estándar que recomienda Supabase. NO cambia la lógica:
-- ALTER FUNCTION solo fija un parámetro de la función, no toca el cuerpo.
--
-- Por qué importa: sin search_path fijo, una función (sobre todo SECURITY
-- DEFINER) resuelve nombres de objetos según el search_path de quien la llama.
-- Un atacante podría crear un objeto homónimo en otro schema y desviar la
-- resolución. Fijarlo a "public" cierra ese vector.
--
-- Por qué ALTER y no CREATE OR REPLACE: ALTER no reescribe el body -> imposible
-- romper la lógica por error de tipeo. CREATE OR REPLACE obligaría a pegar la
-- definición completa de cada función (riesgoso e innecesario).
--
-- ÚNICO caso en que ALTER podría alterar comportamiento: si una función
-- referencia SIN calificar un objeto que vive en un schema distinto de
-- public/pg_catalog (ej. `users` esperando el schema `auth`). En esta app las
-- funciones operan sobre tablas de public, así que es seguro. La verificación
-- de abajo y un smoke-test cubren cualquier sorpresa.
--
-- CÓMO CORRERLO (Supabase Dashboard -> SQL Editor):
--   1. Corré primero el PASO 1 (descubrimiento) y confirmá que lista 17 filas.
--   2. Corré el PASO 2 (fix). Está en transacción; commitea solo si no hay error.
--   3. Corré el PASO 3 (verificación): debe devolver 0 filas.
-- ============================================================================


-- ============================================================================
-- PASO 1 — DESCUBRIMIENTO (solo lectura, no cambia nada)
-- Lista TODAS las funciones de public cuyo search_path NO está fijado.
-- Esto = exactamente lo que reporta el Advisor. Deberían ser 17.
-- ============================================================================
SELECT
  p.oid::regprocedure                              AS funcion,          -- nombre + tipos de args
  CASE WHEN p.prosecdef THEN 'SECURITY DEFINER'
       ELSE 'SECURITY INVOKER' END                 AS modo,
  p.proconfig                                      AS config_actual     -- NULL = sin search_path fijo
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND NOT EXISTS (
    SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) c
    WHERE c LIKE 'search_path=%'
  )
ORDER BY funcion;


-- ============================================================================
-- PASO 2 — FIX (recomendado: dinámico, cubre las 17 sin tipear nombres)
-- Recorre exactamente las funciones del PASO 1 y les fija search_path = public.
-- Usa oid::regprocedure -> incluye la firma completa, así maneja sobrecargas.
-- Idempotente: si volvés a correrlo, no toca las que ya están fijadas.
-- ============================================================================
BEGIN;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND NOT EXISTS (
        SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) c
        WHERE c LIKE 'search_path=%'
      )
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public;', r.sig);
    RAISE NOTICE 'search_path=public fijado en %', r.sig;
  END LOOP;
END $$;

-- Verificación dentro de la misma transacción: debe dar 0 filas.
SELECT p.oid::regprocedure AS sigue_mutable
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND NOT EXISTS (
    SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) c
    WHERE c LIKE 'search_path=%'
  );

-- Si la query de arriba dio 0 filas -> confirmar:
COMMIT;
-- Si algo se vio raro:
-- ROLLBACK;


-- ============================================================================
-- PASO 3 — VERIFICACIÓN POST-COMMIT (solo lectura)
-- Vuelve a buscar funciones con search_path mutable. Esperado: 0 filas.
-- Después refrescá el Security Advisor (Advisors -> Security -> Rerun linter):
-- los 17 warnings "Function Search Path Mutable" deben pasar a 0.
-- ============================================================================
SELECT p.oid::regprocedure AS sigue_mutable
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND NOT EXISTS (
    SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) c
    WHERE c LIKE 'search_path=%'
  );


-- ============================================================================
-- APÉNDICE — Variante explícita por nombre (alternativa al PASO 2)
-- Las 11 que pasaste. NO incluye las 6 que faltan (no las tengo: el PASO 1 las
-- revela). El PASO 2 dinámico ya cubre las 17 + cualquier sobrecarga, así que
-- esto es solo para que veas el cambio función por función. Sin args funciona
-- si el nombre es único (Postgres 10+); si una está sobrecargada, da error de
-- ambigüedad y conviene usar el PASO 2 dinámico.
-- ----------------------------------------------------------------------------
-- ALTER FUNCTION public.fn_caja_enabled          SET search_path = public;
-- ALTER FUNCTION public.fn_verificar_descarga    SET search_path = public;
-- ALTER FUNCTION public.fn_cobrar_descarga       SET search_path = public;
-- ALTER FUNCTION public.fn_rechazar_descarga     SET search_path = public;
-- ALTER FUNCTION public.fn_cerrar_turno          SET search_path = public;
-- ALTER FUNCTION public.increment_campaign_counter SET search_path = public;
-- ALTER FUNCTION public.fn_traspaso_directo      SET search_path = public;
-- ALTER FUNCTION public.fn_casino_enabled        SET search_path = public;
-- ALTER FUNCTION public.fn_cobrar_sueldo         SET search_path = public;
-- ALTER FUNCTION public.fn_aplicar_descarga      SET search_path = public;
-- ALTER FUNCTION public.fn_acreditar_traspaso    SET search_path = public;
-- ============================================================================
