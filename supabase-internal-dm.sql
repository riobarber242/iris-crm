-- ─────────────────────────────────────────────────────────────────────────────
-- IRIS — Chat interno: mensajes directos (DM) 1 a 1 entre agente y operador.
-- Correr en el SQL Editor de Supabase (este proyecto ejecuta el DDL a mano).
-- Idempotente: se puede correr más de una vez sin romper nada.
--
-- Extiende internal_rooms para soportar, además de la sala grupal por tenant,
-- salas de DM entre dos miembros. El par se guarda ORDENADO (participant_a =
-- uuid menor, participant_b = uuid mayor) para que un DM sea único sin importar
-- quién lo abre. internal_messages / internal_room_reads / realtime NO cambian
-- (ya son por room_id), así que el DM reusa toda la infraestructura existente.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Tipo de sala + participantes (solo para kind='dm'; null en la grupal).
alter table internal_rooms add column if not exists kind          text not null default 'group';
alter table internal_rooms add column if not exists participant_a uuid references agents(id) on delete cascade;
alter table internal_rooms add column if not exists participant_b uuid references agents(id) on delete cascade;

-- 2. El unique(tenant_id) original impedía más de una sala por tenant. Se
--    reemplaza por índices parciales: una sola grupal por tenant + un DM por par.
do $$
declare c text;
begin
  select conname into c
    from pg_constraint
   where conrelid = 'internal_rooms'::regclass
     and contype = 'u'
     and pg_get_constraintdef(oid) ilike '%(tenant_id)%';
  if c is not null then
    execute format('alter table internal_rooms drop constraint %I', c);
  end if;
end $$;

create unique index if not exists uniq_internal_room_group
  on internal_rooms(tenant_id) where kind = 'group';

create unique index if not exists uniq_internal_room_dm
  on internal_rooms(tenant_id, participant_a, participant_b) where kind = 'dm';

create index if not exists idx_internal_rooms_participants
  on internal_rooms(participant_a, participant_b);

-- 3. Verificación (opcional):
-- select id, kind, participant_a, participant_b from internal_rooms order by kind;
