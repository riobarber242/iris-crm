-- ─────────────────────────────────────────────────────────────────────────────
-- IRIS — Caja de fichas (Etapa 5: Descargas + Sueldo)
-- Correr ESTE bloque en el SQL Editor de Supabase. Es idempotente
-- (if not exists / create or replace / on conflict do nothing).
--
-- Requiere las etapas previas:
--   supabase-caja-fichas.sql        (Etapa 2: modelo + fn_aplicar_movimiento)
--   supabase-caja-fichas-stage3.sql (Etapa 3)
--   supabase-caja-fichas-stage4.sql (Etapa 4)
--
-- Con el flag caja_enabled APAGADO (default) nada de esto mueve saldos: las dos
-- funciones nuevas (sueldo y descarga) verifican el flag y abortan si está OFF.
-- Los cambios de esquema (columnas + settings) son seguros de correr cuando
-- quieras antes de encender la caja.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. settings.whatsapp_agente: número de WhatsApp del agente (sin +, formato
--    internacional, ej 5491112345678). Lo usa el operador para armar el link
--    wa.me al "Descargar al agente". Arranca vacío por tenant; se completa desde
--    Configuración. Idempotente: si la fila ya existe, no la pisa.
insert into settings (key, value, tenant_id)
select 'whatsapp_agente', '', t.id
  from tenants t
on conflict (key, tenant_id) do nothing;

-- ── 2. agents.sueldo_diario: sueldo diario del operador (en fichas/$, BIGINT).
--    Default 18000. Editable por el agente desde Configuración.
alter table agents add column if not exists sueldo_diario bigint not null default 18000;

-- ── 3. comprobantes.operador_id: qué operador originó el comprobante. Hoy solo
--    lo usa la DESCARGA (el comprobante de descarga nace del operador, sin
--    contacto), para saber a qué billetera descontar al verificar. Nullable: los
--    comprobantes de carga/pago no lo usan. ('descarga' ya está admitido por el
--    check de comprobantes.tipo desde la Etapa 2, no hace falta tocarlo.)
alter table comprobantes add column if not exists operador_id uuid references agents(id) on delete set null;
create index if not exists idx_comprobantes_operador on comprobantes(tenant_id, operador_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- FUNCIONES ATÓMICAS (plpgsql). Cada llamada corre en UNA transacción con lock
-- de fila sobre la billetera, así operaciones concurrentes se serializan y el
-- guard de saldo es infalible. caja_enabled manda: si está OFF, abortan.
-- ─────────────────────────────────────────────────────────────────────────────

-- Lee el flag caja_enabled del tenant desde settings. Default OFF (sin fila o
-- value != 'true' → false). Helper interno de las dos funciones de abajo.
create or replace function fn_caja_enabled(p_tenant uuid)
returns boolean
language sql
stable
as $$
  select coalesce((select value = 'true'
                     from settings
                    where key = 'caja_enabled' and tenant_id = p_tenant
                    limit 1), false);
$$;

-- Cobro de sueldo del operador. SOLO lo inicia el operador (el chequeo de rol va
-- en el backend). Verifica caja encendida, lee sueldo_diario del operador, exige
-- saldo suficiente en su billetera y descuenta, registrando el movimiento.
-- Devuelve json con el movimiento y el saldo nuevo.
create or replace function fn_cobrar_sueldo(
  p_tenant_id   uuid,
  p_operador_id uuid
) returns json
language plpgsql
as $$
declare
  v_sueldo bigint;
  v_saldo  bigint;
  v_mov_id uuid;
begin
  if not fn_caja_enabled(p_tenant_id) then
    raise exception 'La caja está desactivada';
  end if;

  select sueldo_diario into v_sueldo
    from agents
   where id = p_operador_id;
  if v_sueldo is null then
    raise exception 'No se encontró el sueldo del operador';
  end if;
  if v_sueldo <= 0 then
    raise exception 'El sueldo configurado debe ser mayor a 0';
  end if;

  -- Asegurar la billetera del operador (arranca en 0 si no existe).
  insert into operador_billetera (tenant_id, operador_id, saldo_actual)
  values (p_tenant_id, p_operador_id, 0)
  on conflict (tenant_id, operador_id) do nothing;

  -- Lock de fila: serializa cobros concurrentes sobre la misma billetera.
  select saldo_actual into v_saldo
    from operador_billetera
   where tenant_id = p_tenant_id and operador_id = p_operador_id
   for update;

  if v_saldo < v_sueldo then
    raise exception 'Saldo insuficiente para cobrar sueldo';
  end if;

  update operador_billetera
     set saldo_actual = saldo_actual - v_sueldo, updated_at = now()
   where tenant_id = p_tenant_id and operador_id = p_operador_id
   returning saldo_actual into v_saldo;

  insert into movimientos (
    tenant_id, operador_id, tipo, monto, bono,
    fichas_delta, billetera_delta, comprobante_id, contraparte_id,
    creado_por, creado_por_name
  ) values (
    p_tenant_id, p_operador_id, 'sueldo', v_sueldo, null,
    0, -v_sueldo, null, null,
    p_operador_id, null
  ) returning id into v_mov_id;

  return json_build_object(
    'movimiento_id', v_mov_id,
    'monto',         v_sueldo,
    'saldo_actual',  v_saldo
  );
end;
$$;

-- Verificación de una descarga (la inicia el operador, la verifica el agente).
-- Mueve fichas/$ de la billetera del operador a la billetera del AGENTE que
-- verifica (p_verificado_por, siempre admin/agent). Verifica caja encendida,
-- exige saldo suficiente en la billetera del operador y descuenta; suma a la del
-- agente con UPSERT (por si todavía no tiene fila). Inserta UN movimiento tipo
-- 'descarga' desde la perspectiva del operador (billetera_delta=-monto), con
-- contraparte_id = el agente. Devuelve json con el movimiento y los saldos.
create or replace function fn_verificar_descarga(
  p_tenant_id     uuid,
  p_operador_id   uuid,
  p_monto         bigint,
  p_comprobante_id uuid,
  p_verificado_por uuid
) returns json
language plpgsql
as $$
declare
  v_saldo_op    bigint;
  v_saldo_ag    bigint;
  v_mov_id      uuid;
begin
  if not fn_caja_enabled(p_tenant_id) then
    raise exception 'La caja está desactivada';
  end if;

  if p_monto is null or p_monto <= 0 then
    raise exception 'Monto de descarga inválido';
  end if;

  -- Asegurar la billetera del operador (arranca en 0 si no existe).
  insert into operador_billetera (tenant_id, operador_id, saldo_actual)
  values (p_tenant_id, p_operador_id, 0)
  on conflict (tenant_id, operador_id) do nothing;

  -- Lock de fila sobre la billetera del operador: serializa la descarga.
  select saldo_actual into v_saldo_op
    from operador_billetera
   where tenant_id = p_tenant_id and operador_id = p_operador_id
   for update;

  if v_saldo_op < p_monto then
    raise exception 'Saldo insuficiente para descarga';
  end if;

  -- Descontar al operador.
  update operador_billetera
     set saldo_actual = saldo_actual - p_monto, updated_at = now()
   where tenant_id = p_tenant_id and operador_id = p_operador_id
   returning saldo_actual into v_saldo_op;

  -- Sumar al agente (UPSERT: crea la fila si no existe).
  insert into operador_billetera (tenant_id, operador_id, saldo_actual, updated_at)
  values (p_tenant_id, p_verificado_por, p_monto, now())
  on conflict (tenant_id, operador_id)
  do update set saldo_actual = operador_billetera.saldo_actual + excluded.saldo_actual,
                updated_at   = now()
  returning saldo_actual into v_saldo_ag;

  -- Un solo movimiento, desde la perspectiva del operador (billetera -monto),
  -- con el agente como contraparte. Las fichas del pozo NO se tocan.
  insert into movimientos (
    tenant_id, operador_id, tipo, monto, bono,
    fichas_delta, billetera_delta, comprobante_id, contraparte_id,
    creado_por, creado_por_name
  ) values (
    p_tenant_id, p_operador_id, 'descarga', p_monto, null,
    0, -p_monto, p_comprobante_id, p_verificado_por,
    p_verificado_por, null
  ) returning id into v_mov_id;

  return json_build_object(
    'movimiento_id',     v_mov_id,
    'monto',             p_monto,
    'saldo_operador',    v_saldo_op,
    'saldo_agente',      v_saldo_ag
  );
end;
$$;
