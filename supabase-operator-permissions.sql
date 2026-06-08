-- ─────────────────────────────────────────────────────────────────────────────
-- IRIS — Permisos opcionales por operador
-- Correr ESTE bloque en el SQL Editor de Supabase (este proyecto NO tiene la
-- función exec_sql, así que el DDL no se puede correr por la API/service-role).
-- Es idempotente: se puede correr más de una vez sin romper nada.
--
-- Estos flags solo aplican al rol 'operator'. admin y agent siempre tienen
-- acceso a Campañas y Top Clientes; el operator los ve únicamente si el admin
-- le habilita el flag correspondiente.
-- ─────────────────────────────────────────────────────────────────────────────

-- Ver "Top Clientes" (/leads).
alter table agents
  add column if not exists can_see_top_clients boolean not null default false;

-- Ver "Campañas" (/campanas + /api/campaigns).
alter table agents
  add column if not exists can_see_campaigns boolean not null default false;
