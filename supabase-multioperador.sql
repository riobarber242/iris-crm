-- ─────────────────────────────────────────────────────────────────────────────
-- IRIS — Migración Multi-operador (Etapa 2)
-- Correr ESTE bloque en el SQL Editor de Supabase (este proyecto NO tiene la
-- función exec_sql, así que el DDL no se puede correr por la API/service-role).
-- Es idempotente: se puede correr más de una vez sin romper nada.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Email opcional del operador (el login sigue siendo por `username`).
--    Se usa como dato de contacto/notificaciones, no para autenticar.
alter table agents add column if not exists email text;

-- 2. Asignación de un chat (contacto) a un operador.
--    on delete set null → si se elimina el agente, el chat queda sin asignar
--    (no se borra el contacto ni su historial).
alter table contacts
  add column if not exists assigned_agent_id uuid references agents(id) on delete set null;

-- 3. Índice para filtrar rápido los chats de cada agente.
create index if not exists idx_contacts_assigned_agent on contacts(assigned_agent_id);
