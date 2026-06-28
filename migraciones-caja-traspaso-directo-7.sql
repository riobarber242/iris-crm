-- ═════════════════════════════════════════════════════════════════════════════
-- IRIS — Caja: traspaso DIRECTO de billetera entre operadores (P2)
-- Correr ESTE bloque en el SQL Editor de Supabase. Es idempotente
-- (create or replace). Requiere las etapas previas de la caja
-- (supabase-caja-fichas.sql … stage6 + migraciones-caja-* hasta la 6).
--
-- A diferencia del cierre de turno (fn_cerrar_turno, que traspasa la billetera
-- ENTERA con verificación diferida del receptor), esta función mueve un MONTO
-- ARBITRARIO de una billetera a otra AL INSTANTE, sin comprobante ni
-- verificación. La dispara SOLO el agente/admin desde /fichas (el chequeo de rol
-- vive en src/lib/caja.ts → traspasarEntreOperadores).
--
-- Atómico: lockea ambas billeteras en orden determinístico (evita deadlocks),
-- valida saldo del origen (guard de negativo infalible) y escribe DOS filas en
-- movimientos (origen -monto / destino +monto), ligadas por contraparte_id.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function fn_traspaso_directo(
  p_tenant          uuid,
  p_origen          uuid,
  p_destino         uuid,
  p_monto           bigint,
  p_creado_por      uuid,
  p_creado_por_name text
) returns json
language plpgsql
as $$
declare
  v_saldo_origen  bigint;
  v_saldo_destino bigint;
  v_mov_origen    uuid;
  v_mov_destino   uuid;
begin
  if not fn_caja_enabled(p_tenant) then
    raise exception 'La caja está desactivada';
  end if;
  if p_origen is null or p_destino is null then
    raise exception 'Falta el operador de origen o destino';
  end if;
  if p_origen = p_destino then
    raise exception 'El origen y el destino no pueden ser el mismo operador';
  end if;
  if p_monto is null or p_monto <= 0 then
    raise exception 'El monto a traspasar debe ser mayor a 0';
  end if;

  -- Asegurar ambas billeteras (arrancan en 0 si no existen).
  insert into operador_billetera (tenant_id, operador_id, saldo_actual)
  values (p_tenant, p_origen, 0) on conflict (tenant_id, operador_id) do nothing;
  insert into operador_billetera (tenant_id, operador_id, saldo_actual)
  values (p_tenant, p_destino, 0) on conflict (tenant_id, operador_id) do nothing;

  -- Lock de ambas filas en orden determinístico (por operador_id) ANTES de mover:
  -- si dos traspasos concurrentes tocan el mismo par en sentidos opuestos, se
  -- serializan sin deadlock.
  perform 1 from operador_billetera
   where tenant_id = p_tenant and operador_id in (p_origen, p_destino)
   order by operador_id
   for update;

  -- Descontar al origen con guard de negativo.
  update operador_billetera
     set saldo_actual = saldo_actual - p_monto, updated_at = now()
   where tenant_id = p_tenant and operador_id = p_origen
   returning saldo_actual into v_saldo_origen;
  if v_saldo_origen < 0 then
    raise exception 'Saldo insuficiente en la billetera de origen';
  end if;

  -- Acreditar al destino.
  update operador_billetera
     set saldo_actual = saldo_actual + p_monto, updated_at = now()
   where tenant_id = p_tenant and operador_id = p_destino
   returning saldo_actual into v_saldo_destino;

  -- Ledger: dos filas, perspectiva de cada lado, ligadas por contraparte_id.
  -- Las fichas del pozo NO se tocan (fichas_delta = 0).
  insert into movimientos (
    tenant_id, operador_id, tipo, monto, bono,
    fichas_delta, billetera_delta, comprobante_id, contraparte_id,
    creado_por, creado_por_name
  ) values (
    p_tenant, p_origen, 'traspaso', p_monto, null,
    0, -p_monto, null, p_destino,
    p_creado_por, p_creado_por_name
  ) returning id into v_mov_origen;

  insert into movimientos (
    tenant_id, operador_id, tipo, monto, bono,
    fichas_delta, billetera_delta, comprobante_id, contraparte_id,
    creado_por, creado_por_name
  ) values (
    p_tenant, p_destino, 'traspaso', p_monto, null,
    0, p_monto, null, p_origen,
    p_creado_por, p_creado_por_name
  ) returning id into v_mov_destino;

  return json_build_object(
    'mov_origen',    v_mov_origen,
    'mov_destino',   v_mov_destino,
    'saldo_origen',  v_saldo_origen,
    'saldo_destino', v_saldo_destino
  );
end;
$$;
