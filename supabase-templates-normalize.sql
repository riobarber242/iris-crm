-- FASE 1 (aditiva) — Normalización de plantillas: separar CONTENIDO de ESTADO-POR-WABA.
-- Idempotente. Correr a mano en Supabase → SQL Editor (este proyecto NO tiene la RPC
-- exec_sql; la DDL se ejecuta manualmente).
--
-- Modelo nuevo:
--   · whatsapp_templates       = CONTENIDO único por tenant (name, language, body, buttons).
--   · whatsapp_template_wabas  = ESTADO por WABA (approval_status, meta_template_id, …),
--                                una fila por (plantilla, WABA).
--
-- ⚠ Esta fase es SOLO ADITIVA: crea la tabla nueva, la rellena, y agrega la unicidad
--   de contenido. NO borra ninguna columna de whatsapp_templates (waba_id,
--   approval_status, meta_template_id, status_synced_at siguen ahí, dormidas, para el
--   dual-write de la Fase 2 y el rollback). El DROP se hace en una Fase 3 aparte, ya
--   verificada en prod. Las campañas en curso NO se ven afectadas: el loop de envío
--   lee buttons/body de whatsapp_templates (intactas) y manda por nombre vía Meta.
--
-- Contexto de datos (auditoría 2026-07-24): 8 filas, 0 nombres duplicados, 0 body
-- divergente, 0 legacy (waba_id null). La migración es un no-evento.

-- ── 1. Tabla de estado por WABA ──────────────────────────────────────────────
create table if not exists whatsapp_template_wabas (
  id               uuid primary key default gen_random_uuid(),
  template_id      uuid not null references whatsapp_templates(id) on delete cascade,
  waba_id          text not null,
  approval_status  text,         -- APPROVED / PENDING / IN_APPEAL / REJECTED / PAUSED / DISABLED / null
  meta_template_id text,         -- id de la plantilla en ESA WABA (distinto por WABA)
  status_synced_at timestamptz,  -- última lectura de estado desde Meta para esa WABA
  created_at       timestamptz default now(),
  unique (template_id, waba_id)  -- un estado por (plantilla, WABA)
);

create index if not exists idx_tpl_wabas_template on whatsapp_template_wabas(template_id);
create index if not exists idx_tpl_wabas_waba     on whatsapp_template_wabas(waba_id);

-- ── 2. Backfill: una fila de estado por cada plantilla que hoy tiene waba_id ──
-- 0 legacy en prod → las 8 filas migran. Las legacy (waba_id null) NO generan fila
-- (quedan "sin enviar" en toda WABA, que es lo correcto). Idempotente por el unique.
insert into whatsapp_template_wabas (template_id, waba_id, approval_status, meta_template_id, status_synced_at)
select id, waba_id, approval_status, meta_template_id, status_synced_at
from whatsapp_templates
where waba_id is not null
on conflict (template_id, waba_id) do nothing;

-- ── 3. Unicidad de CONTENIDO (auditoría: 0 duplicados → aplica sin conflicto) ─
-- Índice único (idempotente con `if not exists`, a diferencia de un constraint).
-- name/language/tenant_id son NOT NULL, así que no hay problema de nulos.
create unique index if not exists uq_whatsapp_templates_content
  on whatsapp_templates(tenant_id, name, language);


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════

-- V1. La tabla nueva existe con sus columnas.
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'whatsapp_template_wabas'
order by ordinal_position;

-- V2. Conteo: filas de estado vs plantillas con waba_id (deben coincidir).
select
  (select count(*) from whatsapp_template_wabas)                          as filas_estado,
  (select count(*) from whatsapp_templates where waba_id is not null)     as plantillas_con_waba,
  (select count(*) from whatsapp_templates where waba_id is null)         as plantillas_legacy;

-- V3. Huérfanos: plantillas SIN ninguna fila de estado (esperado = solo las legacy).
select t.id, t.name, t.language, t.waba_id
from whatsapp_templates t
left join whatsapp_template_wabas w on w.template_id = t.id
where w.id is null;

-- V4. Mapa contenido → estado por WABA (lo que va a mostrar la pantalla nueva).
select t.name, t.language, w.waba_id, w.approval_status, w.meta_template_id is not null as tiene_meta_id
from whatsapp_templates t
join whatsapp_template_wabas w on w.template_id = t.id
order by t.name, w.waba_id;

-- V5. El índice único de contenido existe.
select indexname from pg_indexes where tablename = 'whatsapp_templates' and indexname = 'uq_whatsapp_templates_content';
