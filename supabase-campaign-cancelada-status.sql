-- Permitir el estado 'cancelada' en campaigns (Pieza 1: botón Detener).
-- Idempotente. Correr a mano en Supabase → SQL editor (este proyecto ejecuta la
-- DDL manualmente; no hay auto-migración).
--
-- BUG que corrige: la tabla campaigns tiene un CHECK constraint (campaigns_status_check)
-- que limita status a un set de valores SIN 'cancelada'. Cuando el botón Detener hace
-- PATCH status='cancelada', Postgres lo rechaza (código 23514) y la API responde 500.
-- El estado 'cancelada' se agregó en el código (Pieza 1) pero el constraint nunca se
-- actualizó. Verificado en prod 2026-07-12: "new row for relation campaigns violates
-- check constraint campaigns_status_check".
--
-- Estados válidos usados por la app:
--   borrador   → creada, sin lanzar
--   enviando   → en curso
--   pausada    → pausada por horario / cupo diario / techo de Meta (la retoma el cron)
--   completada → terminó (o se forzó a terminal)
--   cancelada  → detenida por el operador (terminal; habilita Editar/Eliminar)
--
-- Drop + add: idempotente si se vuelve a correr (drop if exists antes del add).

alter table campaigns drop constraint if exists campaigns_status_check;
alter table campaigns add constraint campaigns_status_check
  check (status in ('borrador', 'enviando', 'completada', 'pausada', 'cancelada'));
