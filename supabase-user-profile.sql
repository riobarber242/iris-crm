-- ─────────────────────────────────────────────────────────────────────────────
-- IRIS — Perfil de usuario: foto y teléfono
-- Correr ESTE bloque en el SQL Editor de Supabase (este proyecto NO tiene la
-- función exec_sql, así que el DDL no se puede correr por la API/service-role).
-- Es idempotente: se puede correr más de una vez sin romper nada.
--
-- La foto se sube al bucket de Storage "avatars" (público, 2MB máx,
-- jpg/png/webp), en carpetas {tenant_id}/{user_id}/. El bucket se crea por
-- API con la service role (no requiere SQL).
-- ─────────────────────────────────────────────────────────────────────────────

alter table agents add column if not exists avatar_url text;
alter table agents add column if not exists phone text;
