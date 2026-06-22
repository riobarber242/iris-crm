-- Tracking de campañas: estado por mensaje (ticks + botones) y contadores.
-- Idempotente. Correr a mano en Supabase → SQL editor (este proyecto ejecuta
-- la DDL manualmente).

-- ── Estado por mensaje enviado en una campaña ────────────────────────────────
-- Fuente de verdad para los ticks (delivered/read/failed) y las respuestas de
-- botón. Se matchea con los webhooks de Meta por `wamid`.
create table if not exists campaign_message_status (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid references campaigns(id) on delete cascade,
  contact_id   uuid references contacts(id)  on delete set null,
  tenant_id    uuid,
  wamid        text,                 -- id del mensaje devuelto por Meta al enviar
  status       text default 'sent',  -- sent | delivered | read | failed
  btn_payload  text,                 -- btn_0 / btn_1 (respuesta de quick-reply)
  btn_text     text,                 -- label del botón (para identificar "No")
  delivered_at timestamptz,
  read_at      timestamptz,
  created_at   timestamptz default now()
);

create index if not exists idx_cms_wamid    on campaign_message_status (wamid);
create index if not exists idx_cms_campaign on campaign_message_status (campaign_id);

-- ── Contadores denormalizados en campaigns ───────────────────────────────────
alter table campaigns add column if not exists delivered_count integer default 0;
alter table campaigns add column if not exists read_count      integer default 0;
alter table campaigns add column if not exists failed_count    integer default 0;
alter table campaigns add column if not exists btn1_count      integer default 0; -- payload btn_0
alter table campaigns add column if not exists btn2_count      integer default 0; -- payload btn_1

-- ── Config de envío (wizard PARTE 3) ─────────────────────────────────────────
alter table campaigns add column if not exists interval_min_sec integer default 1;
alter table campaigns add column if not exists interval_max_sec integer default 3;
alter table campaigns add column if not exists pause_every       integer;  -- nº de mensajes
alter table campaigns add column if not exists pause_seconds     integer;  -- duración de la pausa

-- ── Incremento atómico de contadores ─────────────────────────────────────────
-- Los webhooks de status llegan concurrentes; un read-modify-write en JS haría
-- race. Esta función incrementa en la base de forma atómica.
create or replace function increment_campaign_counter(cid uuid, col text)
returns void language plpgsql as $$
begin
  execute format('update campaigns set %I = coalesce(%I, 0) + 1 where id = $1', col, col) using cid;
end $$;
