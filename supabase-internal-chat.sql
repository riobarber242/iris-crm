-- ─────────────────────────────────────────────────────────────────────────────
-- IRIS — Chat interno del equipo (Etapa 1)
-- Correr ESTE bloque en el SQL Editor de Supabase (este proyecto NO tiene la
-- función exec_sql, así que el DDL no se corre por la API/service-role).
-- Es idempotente: se puede correr más de una vez sin romper nada.
--
-- Crea una sala grupal de chat interno POR TENANT (agente + sus operadores),
-- que NO sale a WhatsApp/Meta. Aislamiento estricto por tenant_id: tenant_id va
-- desnormalizado en internal_messages (mismo patrón que messages.tenant_id) y
-- todos los endpoints filtran por session.tenant_id. El admin de plataforma NO
-- participa (se excluye por rol en el backend, no por tenant).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Sala por tenant. Etapa 1: UNA sola sala por tenant (unique tenant_id).
--    Se auto-crea on-demand desde el backend (getOrCreateRoom), idempotente.
create table if not exists internal_rooms (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  name       text not null default 'Equipo',
  created_at timestamptz default now(),
  unique (tenant_id)
);

create index if not exists idx_internal_rooms_tenant on internal_rooms(tenant_id);

-- 2. Mensajes de la sala. tenant_id desnormalizado para scoping estricto
--    (igual que messages.tenant_id). content: texto plano O JSON de media
--    {_type:'image'|'audio', url, caption} — mismo formato que el chat con
--    clientes. author_role es el snapshot del rol al momento de enviar.
create table if not exists internal_messages (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  room_id     uuid not null references internal_rooms(id) on delete cascade,
  author_id   uuid references agents(id) on delete set null,  -- null si se borra el agente
  author_name text,
  author_role text,                                            -- 'agent' | 'operator' (snapshot)
  content     text not null,
  created_at  timestamptz default now()
);

-- Índice de listado: mensajes de una sala, más nuevos primero.
create index if not exists idx_internal_messages_room
  on internal_messages(tenant_id, room_id, created_at desc);

-- 3. Marca de lectura POR MIEMBRO (chat grupal → cada uno su last_read_at).
--    Necesaria para el indicador de no-leídos por usuario. PK (room_id, agent_id)
--    garantiza una sola fila por miembro y sala (upsert en mark-read).
create table if not exists internal_room_reads (
  tenant_id    uuid not null references tenants(id) on delete cascade,
  room_id      uuid not null references internal_rooms(id) on delete cascade,
  agent_id     uuid not null references agents(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (room_id, agent_id)
);

create index if not exists idx_internal_room_reads_agent
  on internal_room_reads(tenant_id, agent_id);

-- 4. Realtime: sumar internal_messages a la publicación supabase_realtime para
--    que el cliente browser reciba los INSERT (mismo mecanismo que `messages`).
--    Envuelto en DO porque "alter publication ... add table" falla si la tabla
--    ya está en la publicación (idempotencia).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'internal_messages'
  ) then
    alter publication supabase_realtime add table internal_messages;
  end if;
end $$;

-- 5. Verificación (opcional): confirma que las tablas y la publicación quedaron.
-- select tablename from pg_publication_tables
--  where pubname = 'supabase_realtime' and tablename = 'internal_messages';
