-- FK campaign_message_status.contact_id → contacts(id) ON DELETE SET NULL.
-- Correr en Supabase → SQL editor. Este proyecto NO tiene la RPC exec_sql, así que la
-- DDL se ejecuta a mano. Idempotente: se puede correr más de una vez.
-- CORRIDO en prod el 29/09/2026: V2 = 0 huérfanas; las 45 quedaron en NULL.
--
-- Por qué: supabase-campaign-tracking.sql declara esta FK, pero la tabla ya existía
-- cuando se corrió y el `create table if not exists` fue no-op → en la base viva NO
-- está (verificado 29/09/2026 con el OpenAPI de PostgREST). Consecuencia: al borrar un
-- contacto, sus filas de tracking quedan con un contact_id colgando que apunta a un
-- contacto inexistente, en vez de pasar a NULL. El 29/09 eran 45 filas (44 contactos
-- borrados). Desde supabase-contact-optouts.sql cada fila guarda el `phone`, así que
-- pasar a NULL ya no pierde a quién se le mandó.
--
-- Orden (sin ventana de carrera):
--   1. Índice por contact_id (el ON DELETE SET NULL busca las filas hijas por cada
--      contacto borrado; sin índice, el borrado masivo haría un seq scan por contacto).
--   2. La FK como NOT VALID: desde ese momento ningún borrado deja un id colgando y
--      todo insert/update nuevo se valida, pero NO revisa las filas existentes.
--   3. Las huérfanas existentes → NULL.
--   4. VALIDATE: ahora sí revisa todas las filas (ya no queda ninguna huérfana).
-- Si se hiciera 3 antes de 2, un contacto borrado entre medio dejaría una huérfana
-- nueva y el ADD CONSTRAINT fallaría.

-- ── 1. Índice ────────────────────────────────────────────────────────────────
-- Ya lo declara supabase-contactos-borrado-masivo.sql; va de nuevo por si ese archivo
-- no se corrió entero (if not exists = no-op si ya está).
create index if not exists idx_cms_contact on campaign_message_status (contact_id);

-- ── 2. FK NOT VALID ──────────────────────────────────────────────────────────
-- Se busca CUALQUIER FK sobre contact_id (no solo por nombre): si alguien la creó a
-- mano con otro nombre, no se duplica. La verificación V1 muestra cuál quedó y con
-- qué ON DELETE.
do $$
declare
  v_attnum smallint;
begin
  select attnum into v_attnum
  from pg_attribute
  where attrelid = 'public.campaign_message_status'::regclass
    and attname  = 'contact_id';

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.campaign_message_status'::regclass
      and contype  = 'f'
      and conkey   = array[v_attnum]
  ) then
    alter table public.campaign_message_status
      add constraint campaign_message_status_contact_id_fkey
      foreign key (contact_id) references public.contacts(id)
      on delete set null
      not valid;
    raise notice 'FK campaign_message_status_contact_id_fkey creada (NOT VALID)';
  else
    raise notice 'Ya existía una FK sobre campaign_message_status.contact_id: no se crea otra';
  end if;
end $$;

-- ── 3. Huérfanas → NULL ──────────────────────────────────────────────────────
-- Solo las que apuntan a un contacto que no existe. Las filas conservan phone,
-- estado, botón y error: se pierde únicamente el id colgando, que ya no servía.
update public.campaign_message_status cms
set contact_id = null
where cms.contact_id is not null
  and not exists (select 1 from public.contacts c where c.id = cms.contact_id);

-- ── 4. VALIDATE ──────────────────────────────────────────────────────────────
-- Por nombre real (la del paso 2 o la que ya existiera), y solo si falta validar.
do $$
declare
  v_attnum smallint;
  v_name   text;
begin
  select attnum into v_attnum
  from pg_attribute
  where attrelid = 'public.campaign_message_status'::regclass
    and attname  = 'contact_id';

  select conname into v_name
  from pg_constraint
  where conrelid = 'public.campaign_message_status'::regclass
    and contype  = 'f'
    and conkey   = array[v_attnum]
    and not convalidated
  limit 1;

  if v_name is not null then
    execute format('alter table public.campaign_message_status validate constraint %I', v_name);
    raise notice 'FK % validada', v_name;
  end if;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════

-- V1. La FK existe, está validada, apunta a contacts y es ON DELETE SET NULL.
--     Esperado: 1 fila · convalidated = true · on_delete = 'n' (n = SET NULL).
select conname,
       confrelid::regclass as referencia,
       convalidated,
       confdeltype         as on_delete
from pg_constraint
where conrelid = 'public.campaign_message_status'::regclass
  and contype  = 'f'
  and conkey   = array[(select attnum from pg_attribute
                        where attrelid = 'public.campaign_message_status'::regclass
                          and attname  = 'contact_id')];

-- V2. Huérfanas. Esperado: 0.
select count(*) as huerfanas
from public.campaign_message_status cms
left join public.contacts c on c.id = cms.contact_id
where cms.contact_id is not null and c.id is null;

-- V3. Índice. Esperado: 1 fila.
select indexname from pg_indexes
where tablename = 'campaign_message_status' and indexname = 'idx_cms_contact';

-- V4. Filas con contact_id NULL. Esperado: las huérfanas de antes (45 el 29/09) más
--     las de contactos borrados después de correr esto.
select count(*) as contact_id_null from public.campaign_message_status where contact_id is null;
