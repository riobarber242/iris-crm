-- Tabla de campañas (idempotente). Correr en Supabase → SQL editor.
-- Este proyecto NO tiene la RPC exec_sql, así que la DDL se ejecuta a mano.

create table if not exists campaigns (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  message            text,
  status             text default 'borrador',
  created_at         timestamptz default now(),
  sent_count         integer default 0,
  target_filter      text,
  type               text default 'texto_libre',
  template_name      text,
  template_language  text,
  template_variables jsonb,
  recipient_ids      text[]           -- lista de contactos a los que se envió
);

-- Por si la tabla ya existía sin estas columnas:
alter table campaigns add column if not exists type               text default 'texto_libre';
alter table campaigns add column if not exists template_name      text;
alter table campaigns add column if not exists template_language  text;
alter table campaigns add column if not exists template_variables jsonb;
alter table campaigns add column if not exists recipient_ids      text[];
