-- IRIS CRM — Multi-número de WhatsApp por tenant (idempotente).
-- Correr en Supabase → SQL Editor. Este proyecto NO tiene la RPC exec_sql,
-- así que la DDL se ejecuta a mano.
--
-- Reemplaza la relación 1:1 tenant↔número (columnas escalares en tenants)
-- por una tabla 1:N. Las columnas tenants.whatsapp_phone_id y
-- tenants.whatsapp_access_token NO se borran acá: el código actual todavía
-- las lee (resolveTenantId / resolveCreds); se retiran recién cuando el
-- código migre a esta tabla.

-- 1. Tabla de números
create table if not exists whatsapp_numbers (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid references tenants(id) on delete cascade not null,
  phone_number_id text unique not null,        -- ID del número en Meta (metadata.phone_number_id del webhook)
  access_token    text,                        -- token del número; null = usar env global (WHATSAPP_ACCESS_TOKEN)
  waba_id         text,                        -- WhatsApp Business Account del número (templates); null = env global
  label           text,                        -- nombre visible en el panel ("Línea 1", "Soporte", etc.)
  active          boolean default true,
  is_default      boolean default false,       -- número saliente por defecto del tenant
  created_at      timestamptz default now()
);

create index if not exists idx_whatsapp_numbers_tenant on whatsapp_numbers(tenant_id);

-- A lo sumo UN número default por tenant (índice único parcial).
create unique index if not exists idx_whatsapp_numbers_default
  on whatsapp_numbers(tenant_id) where is_default;

-- 2. Migración de datos: el número actual de cada tenant pasa a la tabla,
--    como default y con label 'Línea 1'. Idempotente: si el phone_number_id
--    ya está migrado, el on conflict lo saltea.
insert into whatsapp_numbers (tenant_id, phone_number_id, access_token, label, is_default)
select t.id, trim(t.whatsapp_phone_id), t.whatsapp_access_token, 'Línea 1', true
from tenants t
where t.whatsapp_phone_id is not null
  and trim(t.whatsapp_phone_id) <> ''
on conflict (phone_number_id) do nothing;

-- El tenant Principal usa las env vars de Vercel (whatsapp_phone_id NULL en la
-- tabla, verificado 2026-06-12), así que el insert de arriba no lo cubre: se
-- migra explícito con su phone_number_id real. access_token queda null = el
-- código sigue usando el token global de env (WHATSAPP_ACCESS_TOKEN).
insert into whatsapp_numbers (tenant_id, phone_number_id, access_token, label, is_default)
values ('00000000-0000-0000-0000-000000000001', '1135649372965076', null, 'Línea 1', true)
on conflict (phone_number_id) do nothing;

-- 3. Por cuál número entró cada conversación. Nullable: los contactos previos
--    a esta migración no lo tienen, y el código debe tratar null como
--    "el número default del tenant".
alter table contacts add column if not exists whatsapp_number_id uuid references whatsapp_numbers(id) on delete set null;

create index if not exists idx_contacts_whatsapp_number on contacts(whatsapp_number_id);

-- 4. Backfill: los contactos existentes entraron por el único número que había,
--    así que se les asigna el default de su tenant. Solo completa los null
--    (idempotente, no pisa asignaciones futuras).
update contacts c
set whatsapp_number_id = w.id
from whatsapp_numbers w
where c.whatsapp_number_id is null
  and w.tenant_id = c.tenant_id
  and w.is_default;
