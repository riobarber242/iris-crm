-- IRIS CRM — Multi-tenant para quick_replies (idempotente). Correr en Supabase → SQL editor.
-- Hasta ahora quick_replies no tenía tenant_id: las respuestas rápidas se
-- compartían entre TODOS los tenants. Esta migración las aísla por tenant.

-- 1. Agregar la columna (FK al tenant, borra en cascada si se elimina el tenant).
alter table quick_replies add column if not exists tenant_id uuid references tenants(id) on delete cascade;

-- 2. Backfill: las filas existentes pasan al tenant Principal.
update quick_replies set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;

-- 3. A partir de ahora es obligatorio.
alter table quick_replies alter column tenant_id set not null;

-- 4. Índice para los listados por tenant.
create index if not exists idx_quick_replies_tenant on quick_replies(tenant_id);
