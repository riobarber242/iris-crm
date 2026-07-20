-- IRIS CRM — Plantillas de WhatsApp por WABA (idempotente).
-- Correr en Supabase → SQL Editor. Este proyecto NO tiene la RPC exec_sql,
-- así que la DDL se ejecuta a mano.
--
-- Problema que resuelve: las plantillas viven en la WABA de cada línea, pero
-- whatsapp_templates no guardaba a cuál pertenecen. El selector de campañas las
-- mostraba todas mezcladas y, si se usaba una plantilla que no está aprobada en
-- la WABA del número que sale, Meta la rechaza EN SILENCIO (error 132001:
-- send-core.ts se lo come en el catch del envío).
--
-- Nada de esto afecta campañas ya creadas: todas las columnas son nullable y el
-- código cae al comportamiento anterior cuando están en null.

-- ── 1. Columnas nuevas en whatsapp_templates ────────────────────────────────

-- WABA dueña de la plantilla. null = legacy (pre-migración): se sigue mostrando
-- para cualquier línea, porque no sabemos de qué WABA es.
alter table whatsapp_templates add column if not exists waba_id text;

-- Estado de aprobación que devuelve Meta para la plantilla:
-- APPROVED / PENDING / IN_APPEAL / REJECTED / PAUSED / DISABLED. null = sin
-- sincronizar todavía (legacy) → la UI la muestra en gris y NO la bloquea.
alter table whatsapp_templates add column if not exists approval_status text;

-- id de la plantilla en Meta (lo devuelve el alta y el listado de la Graph API).
alter table whatsapp_templates add column if not exists meta_template_id text;

-- Última vez que se leyó el estado desde Meta (para mostrar "actualizado hace…").
alter table whatsapp_templates add column if not exists status_synced_at timestamptz;

-- ── 2. Backfill del waba_id ─────────────────────────────────────────────────
-- Para cada tenant, las plantillas sin waba_id heredan el waba_id del número
-- DEFAULT activo de ese tenant (que es la WABA con la que se venían enviando).
-- Solo toca filas con waba_id null → idempotente y no pisa altas futuras.
update whatsapp_templates t
set waba_id = w.waba_id
from whatsapp_numbers w
where t.waba_id is null
  and w.tenant_id = t.tenant_id
  and w.is_default
  and w.active
  and w.waba_id is not null;

-- El selector del asistente filtra por (tenant, waba).
create index if not exists idx_whatsapp_templates_tenant_waba
  on whatsapp_templates(tenant_id, waba_id);

-- ── 3. Campañas multi-línea ─────────────────────────────────────────────────
-- El asistente ahora permite elegir VARIAS líneas (todas de la misma WABA).
-- target_number_id (singular) se conserva tal cual para no tocar las campañas
-- existentes: si target_number_ids es null o vacío, el envío usa el singular
-- exactamente como antes (y null en ambos = todas las líneas, sin filtro).
alter table campaigns add column if not exists target_number_ids uuid[];


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN — correr después y revisar los 3 resultados
-- ════════════════════════════════════════════════════════════════════════════

-- V1. Las columnas existen (deben salir 4 filas de whatsapp_templates + 1 de campaigns).
select table_name, column_name, data_type, is_nullable
from information_schema.columns
where (table_name = 'whatsapp_templates'
       and column_name in ('waba_id', 'approval_status', 'meta_template_id', 'status_synced_at'))
   or (table_name = 'campaigns' and column_name = 'target_number_ids')
order by table_name, column_name;

-- V2. El backfill corrió: ninguna plantilla debería quedar con waba_id null
--     (salvo tenants sin número default activo con waba_id cargado).
select t.tenant_id, te.name as tenant, t.waba_id, count(*) as plantillas
from whatsapp_templates t
join tenants te on te.id = t.tenant_id
group by t.tenant_id, te.name, t.waba_id
order by te.name;

-- V3. Coherencia: el waba_id de cada plantilla coincide con el de las líneas
--     del tenant (columna `coincide` en true para todas).
select te.name as tenant, t.name as plantilla, t.waba_id as waba_plantilla,
       w.waba_id as waba_linea_default,
       (t.waba_id is not distinct from w.waba_id) as coincide
from whatsapp_templates t
join tenants te on te.id = t.tenant_id
left join whatsapp_numbers w
  on w.tenant_id = t.tenant_id and w.is_default and w.active
order by te.name, t.name;
