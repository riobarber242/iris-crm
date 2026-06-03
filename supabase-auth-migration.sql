-- ─────────────────────────────────────────────────────────────────────────────
-- IRIS — Migración Etapa 1: sistema de login y roles
-- Correr ESTE bloque en el SQL Editor de Supabase (este proyecto no tiene
-- la función exec_sql, así que el DDL no se puede correr por la API).
-- Es idempotente: se puede correr más de una vez sin romper nada.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Tabla de agentes (login + roles)
create table if not exists agents (
  id             uuid primary key default gen_random_uuid(),
  username       text unique not null,
  password_hash  text not null,            -- formato scrypt$salt$hash (src/lib/auth.ts)
  name           text not null,
  role           text not null default 'agent' check (role in ('admin','agent')),
  active         boolean default true,
  schedule_start time,                      -- horario de atención (informativo)
  schedule_end   time,
  created_at     timestamptz default now()
);

-- 2. Atribución de agente en cada mensaje enviado
alter table messages add column if not exists agent_id   uuid references agents(id);
alter table messages add column if not exists agent_name text;

-- 3. (Opcional) Crear el primer admin desde acá en vez del endpoint.
--    Reemplazá el hash por uno generado, o usá /api/admin/seed-auth?secret=CRON_SECRET
--    que lo siembra y te devuelve la contraseña una sola vez.
-- insert into agents (username, password_hash, name, role)
-- values ('admin', 'PEGAR_HASH_SCRYPT_ACA', 'Admin', 'admin')
-- on conflict (username) do nothing;
