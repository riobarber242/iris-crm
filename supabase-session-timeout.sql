-- IRIS CRM — Temporizador de cierre de sesión configurable por operador (idempotente).
-- Correr en Supabase → SQL Editor. Este proyecto NO tiene la RPC exec_sql,
-- así que la DDL se ejecuta a mano.
--
-- Agrega a `agents` la configuración del auto-logout por inactividad, hoy fijo
-- en 20 min en el front (ActivityGuard). Los defaults replican el comportamiento
-- actual: todos los operadores existentes siguen con cierre a los 20 min.

alter table agents add column if not exists session_timeout_enabled boolean not null default true;
alter table agents add column if not exists session_timeout_minutes  integer not null default 20;
