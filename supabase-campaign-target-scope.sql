-- Alcance por línea de los destinatarios de una campaña, separado de la categoría.
-- Idempotente. Correr a mano en Supabase → SQL editor (no hay RPC exec_sql).
--
-- POR QUÉ: 'suelto' y 'libre' habían quedado como si fueran categorías de
-- contacto dentro de target_filter, al lado de 'nuevo' / 'cliente_activo' /
-- 'inactivo'. No lo son: son dos dimensiones distintas.
--   · target_filter → QUÉ contactos (por su estado): todos, activo, inactivo,
--                     inactivo_Xd, nuevo, seleccion, phone:<tel>.
--   · target_scope  → DE DÓNDE salen (por línea).
-- Mezclarlas hacía imposible pedir, por ejemplo, "los inactivos de toda la base":
-- al elegir 'libre' se perdía el filtro de categoría.
--
-- Valores de target_scope:
--   'lineas' → contactos de las líneas emisoras MÁS los que no tienen línea
--              asignada (sueltos). Es el default y lo que hacían las campañas
--              anteriores a esta columna.
--   'suelto' → SOLO los contactos sin línea asignada.
--   'libre'  → todos los contactos del tenant, sin mirar líneas.
--
-- null = 'lineas'. Por eso la columna es nullable y no hay backfill: todas las
-- campañas existentes conservan exactamente su comportamiento.
--
-- OJO (patrón de este repo): `add column if not exists` es no-op si la columna ya
-- existía con otro tipo; verificá el esquema vivo si sospechás una migración a medias.

alter table campaigns add column if not exists target_scope text;


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════

-- V1. La columna existe, es text y es nullable.
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'campaigns' and column_name = 'target_scope';

-- V2. Ninguna campaña existente estrena alcance (todas siguen en el default).
--     Esperado: total = sin_alcance.
select count(*) as total, count(*) filter (where target_scope is null) as sin_alcance
from campaigns;

-- V3. Ninguna campaña quedó con el modelo viejo, donde el alcance vivía dentro
--     de target_filter. Esperado: 0 filas. Si aparece alguna, avisar antes de
--     seguir: el código la sigue interpretando bien, pero conviene migrarla.
select id, name, target_filter, status
from campaigns
where target_filter in ('suelto', 'libre');
