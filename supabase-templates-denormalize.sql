-- Corrección de rumbo: modelo INDEPENDIENTE por cuenta. Cada WABA tiene su propia
-- plantilla (contenido + estado juntos en whatsapp_templates, una fila por
-- (name, language, waba_id)). Deshace la Fase 1 de normalización.
-- Idempotente. Correr a mano en Supabase → SQL Editor.
--
-- Por qué: se optó por que cada cuenta tenga su plantilla propia — contenido y estado
-- independientes, editar/eliminar por cuenta, contenido que puede diferir entre WABAs.
-- Ese es el modelo ORIGINAL de whatsapp_templates (fila por (name, waba)), así que
-- revertimos la tabla de estado y el índice de "contenido único" de la Fase 1.
--
-- Seguro para producción: el código en prod (commit 51a810d) NO lee
-- whatsapp_template_wabas ni depende del índice de contenido único; las campañas usan
-- el modelo plano de siempre. Esta migración solo saca un índice y una tabla auxiliar.

-- 1. Sacar el índice de "contenido único" (tenant, name, language). Bloqueaba el mismo
--    nombre en dos WABAs, que es JUSTO lo que el modelo independiente necesita permitir.
drop index if exists uq_whatsapp_templates_content;

-- 2. Una fila por plantilla POR CUENTA: evita duplicar la misma (name, language) dentro
--    de la MISMA WABA, pero permite el mismo nombre en WABAs distintas. Parcial (solo
--    filas con waba_id) para no enredarse con nulos.
create unique index if not exists uq_whatsapp_templates_por_cuenta
  on whatsapp_templates(tenant_id, name, language, waba_id)
  where waba_id is not null;

-- 3. Tabla de estado por WABA: ya no se usa (en el modelo independiente cada fila trae
--    su propio approval_status/meta_template_id). Sus datos eran copia de columnas que
--    siguen en whatsapp_templates, así que NO se pierde nada.
drop table if exists whatsapp_template_wabas;


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════

-- V1. El índice de contenido único ya NO aparece; el nuevo por-cuenta SÍ.
select indexname from pg_indexes
where tablename = 'whatsapp_templates'
  and indexname in ('uq_whatsapp_templates_content', 'uq_whatsapp_templates_por_cuenta')
order by indexname;

-- V2. La tabla de estado ya NO existe (debe devolver NULL).
select to_regclass('public.whatsapp_template_wabas') as tabla_estado_deberia_ser_null;

-- V3. Las plantillas quedaron intactas (contenido + estado en la misma fila).
select name, language, waba_id, approval_status from whatsapp_templates order by name;
