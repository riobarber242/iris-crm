-- ─────────────────────────────────────────────────────────────────────────────
-- IRIS — Push multi-dispositivo. Correr en el SQL Editor de Supabase (este
-- proyecto ejecuta el DDL a mano). Idempotente.
--
-- Hasta ahora push_subscriptions tenía un único registro por agent_id (el último
-- dispositivo pisaba al anterior). Pasamos a UNA fila por dispositivo, usando el
-- `endpoint` de la suscripción como clave única. El envío (lib/push.ts) ya itera
-- TODAS las filas del agente, así que con esto cada dispositivo recibe el push.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Columna endpoint (desnormalizada del jsonb para poder indexarla).
alter table push_subscriptions add column if not exists endpoint text;

-- 2. Poblar endpoint desde el jsonb existente (filas previas).
update push_subscriptions
set endpoint = subscription->>'endpoint'
where endpoint is null;

-- 3. Quitar el unique viejo sobre agent_id (si existe) para permitir varias filas
--    por agente (una por dispositivo). El nombre puede variar; lo buscamos.
do $$
declare c text;
begin
  select conname into c
    from pg_constraint
   where conrelid = 'push_subscriptions'::regclass
     and contype = 'u'
     and pg_get_constraintdef(oid) ilike '%(agent_id)%';
  if c is not null then
    execute format('alter table push_subscriptions drop constraint %I', c);
  end if;
end $$;
-- Por si el unique de agent_id fue creado como índice y no como constraint:
drop index if exists push_subscriptions_agent_id_key;

-- 4. Un dispositivo = una fila: índice único por endpoint.
create unique index if not exists uniq_push_endpoint
  on push_subscriptions(endpoint);

-- 5. Índice de lookup por agente (el envío filtra por agent_id).
create index if not exists idx_push_subscriptions_agent
  on push_subscriptions(agent_id);
