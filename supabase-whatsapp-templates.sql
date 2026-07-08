-- Plantillas de WhatsApp por tenant (las que se cargan en Iris y luego se envían
-- a Meta para aprobación vía /api/whatsapp-templates/submit-to-meta). Idempotente.
--
-- NOTA: esta tabla YA existe en producción (se creó a mano en su momento). Esta
-- migración solo la versiona para que una instancia/DB nueva la tenga: el
-- `if not exists` hace que NO toque la tabla existente en prod. RLS se activa
-- aparte en supabase-enable-rls.sql. Esquema tomado del real en prod y del CRUD
-- en src/app/api/whatsapp-templates/route.ts (buttons = jsonb array de hasta 2
-- textos; language tipo 'es' / 'es_AR').
create table if not exists whatsapp_templates (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  name       text not null,
  language   text not null default 'es',
  body       text not null,
  buttons    jsonb not null default '[]'::jsonb,
  created_at timestamptz default now()
);

-- El listado del panel filtra por tenant y ordena por created_at.
create index if not exists idx_whatsapp_templates_tenant on whatsapp_templates(tenant_id, created_at);
