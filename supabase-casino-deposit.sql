-- ─────────────────────────────────────────────────────────────────────────────
-- Integración DoDeposit: acreditar al player en el casino (celuapuestas) al
-- verificar un comprobante de tipo 'carga' en Iris.
--
-- Idempotente: seguro de correr varias veces. PREREQUISITO para activar el flag.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Trazabilidad / idempotencia del depósito, por comprobante.
--    casino_deposited_at != null  => ya se acreditó en el casino (no re-depositar).
alter table comprobantes add column if not exists casino_deposited_at timestamptz;
alter table comprobantes add column if not exists casino_deposit_ref  text;

-- 2. Flag por tenant. Default OFF: sin fila o value != 'true' => desactivado.
--    Con el flag OFF, la verificación funciona igual que hoy (no llama al casino).
insert into settings (key, value, tenant_id)
select 'casino_deposit_enabled', 'false', t.id
  from tenants t
on conflict (key, tenant_id) do nothing;

-- 3. Para ACTIVAR en Casino 17Star (tras setear CASINO_API_TOKEN / _BASE_URL en
--    Vercel y probar con un monto chico), correr a mano:
--
--   update settings set value = 'true'
--    where key = 'casino_deposit_enabled'
--      and tenant_id = 'f56fdb7c-cf5c-45df-854f-cd040fdd3b95';
