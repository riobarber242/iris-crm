-- FK whatsapp_templates.tenant_id → tenants(id) ON DELETE CASCADE.
-- Correr en Supabase → SQL editor. Este proyecto NO tiene la RPC exec_sql, así que la
-- DDL se ejecuta a mano. Idempotente: se puede correr más de una vez.
-- CORRIDO en prod el 29/09/2026: V0/V2 = 0 huérfanas, FK validada con on_delete = 'c',
-- índice creado. Ojo: el SQL Editor muestra solo el resultado de la ÚLTIMA consulta;
-- para ver V0 y cada verificación, correrlas seleccionándolas de a una.
--
-- Por qué: supabase-whatsapp-templates.sql declara esta FK, pero en la base viva NO
-- está (auditoría del 29/09/2026 cruzando las FK del repo contra el OpenAPI de
-- PostgREST; mismo patrón que campaign_message_status.contact_id, arreglado con
-- supabase-cms-contact-fk.sql). Consecuencia: al borrar un tenant, sus plantillas
-- quedan huérfanas en vez de borrarse con él.
--
-- Estado al 29/09/2026: 8 plantillas, todas con un tenant existente (0 huérfanas);
-- tenant_id ya es NOT NULL. No hay nada que limpiar antes.
--
-- Orden: FK NOT VALID (desde ahí todo insert/update se valida) → VALIDATE. Si al
-- correrlo apareciera alguna huérfana nueva, el VALIDATE FALLA a propósito en vez de
-- borrarla: una plantilla huérfana puede ser una copia que alguien quiere conservar,
-- así que se revisa a mano con la consulta V0 antes de decidir. El SQL Editor corre
-- el script entero en una transacción: si el VALIDATE falla, se revierte TODO (no
-- queda ni el índice ni la FK) y la base queda como estaba. Por eso conviene mirar
-- el resultado de V0 primero.

-- ── V0 (antes). Huérfanas: esperado 0. ───────────────────────────────────────
select t.id, t.tenant_id, t.name, t.language, t.waba_id
from public.whatsapp_templates t
left join public.tenants tn on tn.id = t.tenant_id
where tn.id is null;

-- ── 1. Índice por tenant ─────────────────────────────────────────────────────
-- Lo declara supabase-whatsapp-templates.sql; va de nuevo por si no está (el create
-- de esa tabla también pudo haber sido no-op). Sirve para el CASCADE al borrar un
-- tenant y para las lecturas de plantillas, que siempre filtran por tenant.
create index if not exists idx_whatsapp_templates_tenant
  on public.whatsapp_templates (tenant_id, created_at);

-- ── 2. FK NOT VALID ──────────────────────────────────────────────────────────
-- Busca CUALQUIER FK sobre tenant_id (no solo por nombre) para no duplicarla si
-- alguien la creó a mano con otro nombre. V1 muestra cuál quedó y con qué ON DELETE.
do $$
declare
  v_attnum smallint;
begin
  select attnum into v_attnum
  from pg_attribute
  where attrelid = 'public.whatsapp_templates'::regclass
    and attname  = 'tenant_id';

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.whatsapp_templates'::regclass
      and contype  = 'f'
      and conkey   = array[v_attnum]
  ) then
    alter table public.whatsapp_templates
      add constraint whatsapp_templates_tenant_id_fkey
      foreign key (tenant_id) references public.tenants(id)
      on delete cascade
      not valid;
    raise notice 'FK whatsapp_templates_tenant_id_fkey creada (NOT VALID)';
  else
    raise notice 'Ya existía una FK sobre whatsapp_templates.tenant_id: no se crea otra';
  end if;
end $$;

-- ── 3. VALIDATE ──────────────────────────────────────────────────────────────
do $$
declare
  v_attnum smallint;
  v_name   text;
begin
  select attnum into v_attnum
  from pg_attribute
  where attrelid = 'public.whatsapp_templates'::regclass
    and attname  = 'tenant_id';

  select conname into v_name
  from pg_constraint
  where conrelid = 'public.whatsapp_templates'::regclass
    and contype  = 'f'
    and conkey   = array[v_attnum]
    and not convalidated
  limit 1;

  if v_name is not null then
    execute format('alter table public.whatsapp_templates validate constraint %I', v_name);
    raise notice 'FK % validada', v_name;
  end if;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════

-- V1. La FK existe, está validada, apunta a tenants y es ON DELETE CASCADE.
--     Esperado: 1 fila · convalidated = true · on_delete = 'c' (c = CASCADE).
select conname,
       confrelid::regclass as referencia,
       convalidated,
       confdeltype         as on_delete
from pg_constraint
where conrelid = 'public.whatsapp_templates'::regclass
  and contype  = 'f'
  and conkey   = array[(select attnum from pg_attribute
                        where attrelid = 'public.whatsapp_templates'::regclass
                          and attname  = 'tenant_id')];

-- V2. Huérfanas. Esperado: 0.
select count(*) as huerfanas
from public.whatsapp_templates t
left join public.tenants tn on tn.id = t.tenant_id
where tn.id is null;

-- V3. Índice. Esperado: 1 fila.
select indexname from pg_indexes
where tablename = 'whatsapp_templates' and indexname = 'idx_whatsapp_templates_tenant';
