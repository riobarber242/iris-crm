-- "No molestar" persistente + limpieza post-campaña. Correr en Supabase → SQL editor.
-- Este proyecto NO tiene la RPC exec_sql, así que la DDL se ejecuta a mano.
-- Idempotente: se puede correr más de una vez.
--
-- Cuatro piezas:
--   1. contact_optouts: la marca de "no molestar" POR TELÉFONO. No es una columna de
--      contacts a propósito: tiene que sobrevivir al borrado del contacto y al
--      re-import (el import hace upsert por (phone, tenant_id) y un contacto borrado
--      volvería a entrar limpio). La lee runCampaignBatch y saca esos teléfonos de
--      TODA campaña. Solo afecta campañas: el bot y el chat 1 a 1 siguen igual (para
--      silenciar todo ya existe contacts.blocked, que es otra cosa).
--   2. campaigns.btn3_count: contador del 3er botón. Hasta ahora el webhook solo
--      contaba btn_0/btn_1 y un click en btn_2 no sumaba en ningún lado.
--   3. Backfill de campaign_message_status.phone: la columna existía pero send-core
--      nunca la escribía (689/689 filas en null en Casino 17Star). Sin ella, al borrar
--      un contacto se perdía a quién se le mandó. Cuando se corrió esto, en la base
--      viva campaign_message_status.contact_id NO tenía FK a contacts (el create de
--      supabase-campaign-tracking.sql había sido no-op): un contacto borrado dejaba el
--      id colgando, y el backfill no pudo recuperar esas filas (29/09: 45, sin forma
--      de saber el phone). La FK se agregó después con supabase-cms-contact-fk.sql.
--   4. Recalcular btn1/btn2/btn3_count desde el tracking (estaban desfasados).
--
-- OJO (patrón de este repo): `create table if not exists` / `add column if not exists`
-- son no-op si ya existían con otro esquema. La sección VERIFICACIÓN de abajo chequea
-- el esquema vivo.

-- ── 1. Tabla de opt-outs ─────────────────────────────────────────────────────
create table if not exists contact_optouts (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  -- SOLO dígitos (sin +, espacios ni guiones). Es la clave de matcheo contra
  -- contacts.phone, que según el origen viene con o sin '+'.
  phone              text not null,
  -- boton_negativo  = apretó el último botón de una campaña
  -- numero_invalido = falló con 131026 (no tiene WhatsApp / no puede recibir)
  -- manual          = marcado a mano desde la ficha del contacto
  reason             text not null,
  source_campaign_id uuid references campaigns(id) on delete set null,
  created_by         uuid,
  created_by_name    text,
  created_at         timestamptz not null default now(),
  constraint contact_optouts_reason_check
    check (reason in ('boton_negativo', 'numero_invalido', 'manual')),
  constraint contact_optouts_phone_digits_check
    check (phone ~ '^[0-9]{6,20}$'),
  constraint contact_optouts_tenant_phone_key unique (tenant_id, phone)
);

-- Mismo criterio que el resto de las tablas (supabase-enable-rls.sql): RLS activo y
-- sin políticas = anon/authenticated no ven nada; el server usa service_role.
alter table contact_optouts enable row level security;

-- ── 2. Contador del 3er botón ────────────────────────────────────────────────
alter table campaigns add column if not exists btn3_count integer default 0;

-- ── 3. Backfill del teléfono en el tracking ──────────────────────────────────
-- Solo filas con contacto vivo (las de contactos ya borrados no se pueden recuperar).
update campaign_message_status cms
set phone = c.phone
from contacts c
where cms.contact_id = c.id
  and cms.phone is null;

-- ── 4. Recalcular los contadores de botones desde el tracking ────────────────
-- campaign_message_status es la fuente de verdad del click. Los contadores estaban
-- desfasados (p.ej. "Testeo 1" de 17Star: btn2_count=7 con 9 clicks guardados,
-- de antes del arreglo de columnas del 12/07), y el panel nuevo lista las filas
-- del tracking: sin esto el chip y la lista mostrarían números distintos.
-- Solo toca campañas con algún click; las demás quedan como están.
update campaigns c
set btn1_count = t.b1,
    btn2_count = t.b2,
    btn3_count = t.b3
from (
  select campaign_id,
         count(*) filter (where btn_payload = 'btn_0')::int as b1,
         count(*) filter (where btn_payload = 'btn_1')::int as b2,
         count(*) filter (where btn_payload = 'btn_2')::int as b3
  from campaign_message_status
  where btn_payload is not null
  group by campaign_id
) t
where c.id = t.campaign_id;


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════

-- V1. Columnas de contact_optouts (esperado: 9 filas).
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'contact_optouts'
order by ordinal_position;

-- V2. Constraints (esperado: pkey, reason_check, phone_digits_check, tenant_phone_key y las 2 FK).
select conname, contype from pg_constraint
where conrelid = 'public.contact_optouts'::regclass
order by conname;

-- V3. RLS activo (esperado: true).
select relname, relrowsecurity from pg_class where relname = 'contact_optouts';

-- V4. btn3_count existe.
select column_name, data_type from information_schema.columns
where table_name = 'campaigns' and column_name = 'btn3_count';

-- V5. Tracking sin teléfono. Se cruza con contacts porque, cuando se corrió esto,
--     contact_id no tenía FK y un contacto borrado dejaba el id colgando (ahora pasa
--     a NULL, ver supabase-cms-contact-fk.sql; el join sirve igual en los dos casos).
--     sin_phone_con_contacto cuenta solo los contactos que EXISTEN y tiene que dar 0.
--     sin_phone incluye los borrados, que no se pueden recuperar.
select
  count(*)                                   as sin_phone,
  count(c.id)                                as sin_phone_con_contacto
from campaign_message_status cms
left join contacts c on c.id = cms.contact_id
where cms.phone is null;

-- V6. Clicks por posición de botón (para contrastar con los contadores).
select btn_payload, count(*) from campaign_message_status
where btn_payload is not null group by 1 order by 1;
