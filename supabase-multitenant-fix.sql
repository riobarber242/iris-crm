-- IRIS CRM — Multi-tenant fix: unicidad de teléfono POR tenant
-- Correr en Supabase SQL Editor.
-- Antes: contacts.phone era UNIQUE global (un teléfono no podía existir en dos
-- tenants). Ahora la unicidad es (phone, tenant_id).

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_phone_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_phone_tenant ON contacts(phone, tenant_id);
