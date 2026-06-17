-- Registro de destinatarios por campaña (idempotente). Correr en Supabase → SQL editor.
-- Este proyecto NO tiene la RPC exec_sql, así que la DDL se ejecuta a mano.
-- Permite excluir, en campañas nuevas, a los contactos ya contactados en campañas anteriores.

create table if not exists campaign_recipients (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null,
  contact_id  uuid not null,
  sent_at     timestamptz default now()
);

create index if not exists idx_campaign_recipients_campaign on campaign_recipients(campaign_id);

-- Config de exclusión guardada en cada campaña: lista de campañas cuyos
-- destinatarios NO deben recibir esta campaña.
alter table campaigns add column if not exists exclude_campaign_ids text[];
