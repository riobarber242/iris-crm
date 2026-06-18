-- ─────────────────────────────────────────────────────────────────────────────
-- IRIS — "Visto": último operador que vio cada conversación
-- Correr ESTE bloque en el SQL Editor de Supabase (este proyecto NO tiene la
-- función exec_sql, así que el DDL no se puede correr por la API/service-role).
-- Es idempotente y NO destructivo: solo agrega columnas nullable, no borra ni
-- modifica datos existentes. Se puede correr más de una vez sin romper nada.
--
-- CONTEXTO: la tabla de conversaciones es `contacts`. Ya tiene:
--   · last_read_at  → timestamp GLOBAL del no-leído (un solo valor por chat,
--                     compartido entre todos los operadores). NO se toca acá:
--                     alimenta los circulitos/badges (ver src/lib/pending.ts).
--   · assigned_agent_id uuid references agents(id) on delete set null
--                     (ver supabase-multioperador.sql) → patrón que replicamos.
--
-- El "visto" es una dimensión APARTE, puramente informativa ("visto por X
-- hace…"). Mostramos solo el ÚLTIMO operador que abrió el chat, no un historial.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Operador/agente que vio ÚLTIMO la conversación.
--    on delete set null → si se elimina el agente, el "visto" queda en null
--    (no se borra el contacto ni su historial). Mismo criterio que
--    assigned_agent_id, para mantener la coherencia de FKs sobre agents.
alter table contacts
  add column if not exists last_seen_by uuid references agents(id) on delete set null;

-- 2. Momento en que ese operador vio la conversación (para el "visto hace…").
alter table contacts
  add column if not exists last_seen_at timestamptz;

-- 3. Índice para filtrar/consultar el visto por agente sin escanear toda la tabla.
--    Barato y opcional; mismo estilo que idx_contacts_assigned_agent.
create index if not exists idx_contacts_last_seen_by on contacts(last_seen_by);
