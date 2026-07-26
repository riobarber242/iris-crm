-- ─────────────────────────────────────────────────────────────────────────────
-- IRIS CRM — Columnas de MEMBRESÍA de `tenants` (documentación + recreación).
-- Correr a mano en Supabase → SQL Editor. Idempotente.
--
-- POR QUÉ EXISTE ESTE ARCHIVO
-- Estas columnas se agregaron directamente en Supabase en su momento y NUNCA
-- estuvieron en el repo: `supabase-multitenant.sql` crea la tabla `tenants` sin
-- ninguna de ellas. Mientras `plan` era sólo una etiqueta comercial daba igual,
-- pero desde el plan LITE es la fuente de qué secciones ve cada cliente
-- (src/lib/plan.ts). Si hubiera que recrear la base desde el repo, el panel de
-- admin y TODO el gate de planes no arrancarían.
--
-- Sobre una base que YA las tiene (la de producción), correr esto no cambia
-- nada: todo es `if not exists`. Su valor es dejar el esquema reproducible.
--
-- Tipos y defaults tomados del esquema VIVO (OpenAPI de PostgREST, 26/07/2026),
-- no inventados.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Plan y estado comercial ─────────────────────────────────────────────────
-- plan: trial | lite | premium. El CHECK lo agrega supabase-plan-lite.sql, que
-- además recicló el valor viejo 'basic' como 'lite'. Correr ESTE archivo primero
-- y aquel después.
alter table tenants add column if not exists plan   text not null default 'trial';

-- status: active | suspended | cancelled. La validación vive en el PATCH de
-- /api/tenants (src/app/api/tenants/[id]/route.ts), no hay CHECK en la base.
alter table tenants add column if not exists status text not null default 'active';

-- ── Facturación (informativa: el sistema no cobra ni corta por sí solo) ──────
alter table tenants add column if not exists monthly_amount integer not null default 0;
alter table tenants add column if not exists trial_ends_at  timestamptz;
alter table tenants add column if not exists paid_until     timestamptz;

-- ── Presentación y notas internas ───────────────────────────────────────────
-- skin: casino | loteria | barberia. Igual que status, se valida en el código.
alter table tenants add column if not exists skin  text not null default 'casino';
alter table tenants add column if not exists notes text;

-- Cinturón y tirantes, igual que en max_whatsapp_numbers: nunca un monto negativo.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_monthly_amount_nonneg') then
    alter table tenants add constraint tenants_monthly_amount_nonneg check (monthly_amount >= 0);
  end if;
end $$;

-- NOTA — el cupo de números (`max_whatsapp_numbers`) NO está acá: ya lo crea
-- supabase-max-whatsapp-numbers.sql. No se deriva del plan; se edita a mano
-- desde el modal de Membresía (para un cliente Lite va en 1).

-- ── Verificación ────────────────────────────────────────────────────────────
select id, name, plan, status, monthly_amount, trial_ends_at, paid_until, skin, max_whatsapp_numbers
from tenants
order by created_at;
