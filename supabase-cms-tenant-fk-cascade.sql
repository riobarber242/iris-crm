-- ─────────────────────────────────────────────────────────────────────────────
-- IRIS CRM — FK de campaign_message_status.tenant_id CON ON DELETE CASCADE.
-- Correr a mano en Supabase → SQL Editor. Idempotente.
--
-- PROBLEMA
-- `campaign_message_status.tenant_id` tiene una FK a `tenants` que se agregó
-- directamente en la base y NO está en el repo (supabase-campaign-tracking.sql
-- crea la tabla sin ella). Además está SIN cascade, así que borrar un tenant que
-- tenga aunque sea una fila de tracking falla con:
--
--   update or delete on table "tenants" violates foreign key constraint
--   "campaign_message_status_tenant_id_fkey" on table "campaign_message_status"
--
-- Verificado el 26/07/2026 al intentar borrar un tenant de prueba con campañas:
-- hubo que borrar antes, a mano, sus filas de campaign_message_status.
--
-- Todo lo demás que cuelga de un tenant ya cae solo: agents, contacts, messages,
-- comprobantes, campaigns, settings y whatsapp_numbers tienen ON DELETE CASCADE
-- (ver supabase-multitenant.sql y supabase-whatsapp-numbers.sql), y
-- campaign_recipients cae por su FK a campaigns. Esta era la única excepción.
--
-- QUÉ HACE
-- Reemplaza la FK por una equivalente con ON DELETE CASCADE: al borrar un
-- tenant, sus filas de tracking se van con él. No borra ni modifica datos.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare c record;
begin
  -- Cualquier FK que salga de campaign_message_status.tenant_id, sin importar
  -- cómo se llame (la actual es campaign_message_status_tenant_id_fkey, pero no
  -- damos por sentado el nombre).
  for c in
    select con.conname
    from pg_constraint con
    join pg_attribute att
      on att.attrelid = con.conrelid
     and att.attnum   = any (con.conkey)
    where con.conrelid  = 'campaign_message_status'::regclass
      and con.contype   = 'f'
      and att.attname   = 'tenant_id'
  loop
    execute format('alter table campaign_message_status drop constraint %I', c.conname);
  end loop;

  alter table campaign_message_status
    add constraint campaign_message_status_tenant_id_fkey
    foreign key (tenant_id) references tenants(id) on delete cascade;
end $$;

-- ── Verificación ────────────────────────────────────────────────────────────
-- Esperado: una fila, con delete_rule = CASCADE.
select tc.constraint_name, rc.delete_rule
from information_schema.table_constraints tc
join information_schema.referential_constraints rc
  on rc.constraint_name = tc.constraint_name
where tc.table_name = 'campaign_message_status'
  and tc.constraint_type = 'FOREIGN KEY'
  and tc.constraint_name like '%tenant_id%';
