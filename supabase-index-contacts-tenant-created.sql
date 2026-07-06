-- IRIS CRM — Índices compuestos sobre contacts (corridos 2026-07-06)
--
-- Ya existía idx_contacts_tenant(tenant_id) (columna sola). Estos dos compuestos
-- agregan la segunda columna que faltaba para los patrones del dashboard:
--
--  1) idx_contacts_tenant_created (tenant_id, created_at) — conteos por período
--     (newToday/week/month/prevMonth): contacts.eq('tenant_id', X).gte('created_at', Y).
--     Sin él, esas queries usan el índice de tenant y filtran created_at fila por fila;
--     con él, es un range scan. Importa al escalar (el tenant importado tiene 54.415).
--
--  2) idx_contacts_tenant_status (tenant_id, status) — conteos por status
--     (cliente_activo / inactivo / nuevo) del dashboard y el filtro de reactivación:
--     contacts.eq('tenant_id', X).eq('status', Y) → index-only.
--
-- ⚠️ CREATE INDEX CONCURRENTLY:
--   · NO bloquea escrituras mientras construye (solo un lock breve al final) → seguro
--     en una tabla viva.
--   · NO puede correr dentro de una transacción. En el SQL Editor de Supabase, correr
--     cada sentencia SOLA (no las dos juntas en el mismo "Run", para que no queden
--     envueltas en un BEGIN/COMMIT implícito).
--   · Si fallara a mitad, deja un índice INVÁLIDO: borrarlo con DROP INDEX <nombre>;
--     y reintentar. El IF NOT EXISTS cubre la re-corrida normal (no la de uno inválido).

create index concurrently if not exists idx_contacts_tenant_created
  on contacts (tenant_id, created_at);

create index concurrently if not exists idx_contacts_tenant_status
  on contacts (tenant_id, status);
