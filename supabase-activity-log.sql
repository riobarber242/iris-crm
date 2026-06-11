-- ─────────────────────────────────────────────────────────────────────────────
-- IRIS — Registro de actividad (audit log)
-- Correr ESTE bloque en el SQL Editor de Supabase (este proyecto NO tiene la
-- función exec_sql, así que el DDL no se puede correr por la API/service-role).
-- Es idempotente: se puede correr más de una vez sin romper nada.
--
-- Mientras esta migración NO se haya corrido, el sistema sigue funcionando
-- igual; el registro de actividad falla en silencio (nunca traba la acción
-- real). Al correrla, empieza a registrar sin ningún cambio de código.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Tabla de registro de actividad. Una fila por acción de una persona
--    (agente/operador/admin) dentro de su sesión.
create table if not exists activity_log (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,  -- multi-tenant estricto
  actor_id    uuid references agents(id) on delete set null,           -- quién la hizo (agents.id)
  actor_name  text,                                                    -- snapshot del nombre
  actor_role  text,                                                    -- admin | agent | operator
  action      text not null,                                           -- tipo de acción (ver src/lib/activity-log.ts)
  object_type text,                                                    -- comprobante | conversation | contact | session | config
  object_id   text,                                                    -- id del objeto afectado (uuid o key)
  details     jsonb,                                                   -- detalles (monto, resultado, campos, reason, …)
  created_at  timestamptz not null default now()
);

-- 2. Índices pensados para las consultas de la IA (por tenant, por usuario,
--    por tipo de acción, siempre acotado por período).
create index if not exists idx_activity_log_tenant on activity_log(tenant_id, created_at desc);
create index if not exists idx_activity_log_actor  on activity_log(actor_id, created_at desc);
create index if not exists idx_activity_log_action on activity_log(tenant_id, action, created_at desc);

-- 3. Atribución permanente en el propio comprobante: quién lo verificó/rechazó.
--    (Hasta ahora ese dato no se guardaba en ningún lado.) Aplica a ambas
--    resoluciones; para un comprobante 'verificado', resolved_by = quién lo verificó.
alter table comprobantes add column if not exists resolved_by      uuid references agents(id) on delete set null;
alter table comprobantes add column if not exists resolved_by_name text;
alter table comprobantes add column if not exists resolved_at      timestamptz;
