-- Schema Supabase para CRM de Iris

-- Contactos
create table if not exists contacts (
  id uuid primary key default gen_random_uuid(),
  phone text unique not null,
  name text,
  created_at timestamptz default now(),
  ad_source text,
  status text default 'nuevo' check (status in ('nuevo', 'en_proceso', 'activo', 'bloqueado')),
  joined_channel boolean default false,
  user_created boolean default false,
  blocked boolean default false
);

-- Mensajes
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references contacts(id) on delete cascade not null,
  role text not null check (role in ('user', 'assistant', 'human')),
  content text not null,
  created_at timestamptz default now(),
  whatsapp_message_id text,
  status text check (status in ('sent', 'delivered', 'read', 'failed'))
);

create index if not exists idx_messages_contact on messages(contact_id, created_at);

-- Comprobantes
create table if not exists comprobantes (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references contacts(id) on delete cascade not null,
  image_url text,
  monto numeric,
  estado text default 'pendiente' check (estado in ('pendiente', 'verificado', 'rechazado')),
  created_at timestamptz default now()
);

-- Leads
create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references contacts(id) on delete cascade not null,
  score text not null check (score in ('vip', 'activo', 'frio')),
  reason text,
  qualified_at timestamptz default now()
);

-- Configuración
create table if not exists settings (
  key text primary key,
  value text not null
);

-- Valor por defecto: bot activo
insert into settings (key, value) values ('bot_enabled', 'true') on conflict (key) do nothing;

-- Storage bucket para imágenes de comprobantes (crear en Supabase Dashboard → Storage)
-- Bucket name: comprobantes (public)

-- Campañas salientes
create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  message text not null,
  status text default 'borrador' check (status in ('borrador', 'enviando', 'completada')),
  created_at timestamptz default now(),
  sent_count integer default 0,
  target_filter text
);
