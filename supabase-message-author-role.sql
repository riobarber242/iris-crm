-- ─────────────────────────────────────────────────────────────────────────────
-- IRIS — Snapshot del rol del autor en cada mensaje manual
-- Correr ESTE bloque en el SQL Editor de Supabase (este proyecto NO tiene la
-- función exec_sql, así que el DDL no se puede correr por la API/service-role).
-- Es idempotente: se puede correr más de una vez sin romper nada.
--
-- messages ya guarda agent_id + agent_name del autor de cada mensaje 'human'.
-- Faltaba el ROL como snapshot permanente (hasta ahora se resolvía en vivo).
-- Con esta columna, id+nombre+rol del autor quedan fijos al momento del envío,
-- igual que resolved_by/resolved_by_name en comprobantes.
--
-- Mientras NO se corra: el envío sigue funcionando (el código degrada y omite
-- la columna) y la firma usa el rol resuelto en vivo como hasta ahora.
-- ─────────────────────────────────────────────────────────────────────────────

alter table messages add column if not exists agent_role text;
