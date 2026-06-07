-- IRIS CRM — Migración Multi-tenant
-- Correr en Supabase SQL Editor

-- 1. Tabla tenants
create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  whatsapp_phone_id text,
  whatsapp_access_token text,
  created_at timestamptz default now()
);

-- 2. Insertar tenant principal (Gonzalo)
insert into tenants (id, name) values
  ('00000000-0000-0000-0000-000000000001', 'Principal')
on conflict (id) do nothing;

-- 3. Agregar tenant_id a agents
alter table agents add column if not exists tenant_id uuid references tenants(id) on delete cascade;
update agents set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;

-- 4. Agregar tenant_id a contacts
alter table contacts add column if not exists tenant_id uuid references tenants(id) on delete cascade;
update contacts set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;

-- 5. Agregar tenant_id a messages (via contacts, pero por performance lo ponemos directo)
alter table messages add column if not exists tenant_id uuid references tenants(id) on delete cascade;
update messages set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;

-- 6. Agregar tenant_id a comprobantes
alter table comprobantes add column if not exists tenant_id uuid references tenants(id) on delete cascade;
update comprobantes set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;

-- 7. Agregar tenant_id a campaigns
alter table campaigns add column if not exists tenant_id uuid references tenants(id) on delete cascade;
update campaigns set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;

-- 8. Agregar tenant_id a settings
alter table settings add column if not exists tenant_id uuid references tenants(id) on delete cascade;
update settings set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;

-- Fix settings: agregar id como PK y hacer key+tenant_id únicos
alter table settings add column if not exists id uuid default gen_random_uuid();
alter table settings drop constraint if exists settings_pkey;
alter table settings add primary key (id);
create unique index if not exists idx_settings_key_tenant on settings(key, tenant_id);

-- 9. Índices
create index if not exists idx_contacts_tenant on contacts(tenant_id);
create index if not exists idx_messages_tenant on messages(tenant_id);
create index if not exists idx_comprobantes_tenant on comprobantes(tenant_id);
create index if not exists idx_campaigns_tenant on campaigns(tenant_id);
create index if not exists idx_agents_tenant on agents(tenant_id);
