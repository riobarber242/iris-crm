-- IRIS CRM — Cupo de números de WhatsApp por cliente (PR2). Idempotente.
-- Correr en Supabase → SQL Editor ANTES de deployar el código del PR2 (el POST de
-- alta lee tenants.max_whatsapp_numbers; si la columna no existe, el enforcement
-- del cupo fallaría). Este proyecto ejecuta la DDL a mano.
--
-- max_whatsapp_numbers = tope de líneas que el cliente puede tener conectadas
-- (cuenta TODAS las filas de whatsapp_numbers del tenant, activas + inactivas:
-- cada phone_number_id ocupa lugar). Lo sube/baja el admin desde el modal de
-- Membresía. not null default 2 → las filas existentes toman 2 automáticamente.

alter table tenants
  add column if not exists max_whatsapp_numbers int not null default 2;

-- Cinturón y tirantes a nivel DB: nunca un cupo negativo (el PATCH ya valida ≥ 1).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_max_whatsapp_numbers_nonneg') then
    alter table tenants add constraint tenants_max_whatsapp_numbers_nonneg check (max_whatsapp_numbers >= 0);
  end if;
end $$;
