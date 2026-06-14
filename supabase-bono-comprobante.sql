-- ─────────────────────────────────────────────────────────────────────────────
-- IRIS — Comprobantes: campo Bono (fichas) + atribución de edición
-- Correr ESTE bloque en el SQL Editor de Supabase (este proyecto NO tiene la
-- función exec_sql, así que el DDL no se puede correr por la API/service-role).
-- Es idempotente: se puede correr más de una vez sin romper nada.
--
-- Mientras esta migración NO se haya corrido, la pantalla sigue funcionando:
-- el backend degrada con elegancia (reintenta el update sin estas columnas) y
-- simplemente no guarda bono ni la atribución de edición.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Bono en fichas cargado a mano al verificar/editar. Nullable, null = sin bono.
--    Etapa 1: es solo dato; el descuento de stock viene en Etapa 2.
alter table comprobantes add column if not exists bono integer;

-- 2. Atribución de la última edición (botón "Editar" sobre un comprobante ya
--    verificado). Análogo a resolved_by/_name/_at, pero para ediciones.
alter table comprobantes add column if not exists edited_by      uuid references agents(id) on delete set null;
alter table comprobantes add column if not exists edited_by_name text;
alter table comprobantes add column if not exists edited_at      timestamptz;
