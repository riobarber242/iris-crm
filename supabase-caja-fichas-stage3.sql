-- ─────────────────────────────────────────────────────────────────────────────
-- IRIS — Caja de fichas (Etapa 3: enganche + control del agente)
-- Correr ESTE bloque en el SQL Editor de Supabase. Es idempotente
-- (create or replace), se puede correr más de una vez sin romper nada.
--
-- Requiere que supabase-caja-fichas.sql (Etapa 2) ya esté corrido.
-- NOTA: con el flag caja_enabled APAGADO (default), nada de esto se ejecuta
-- desde la app; podés correr este SQL cuando quieras antes de encender la caja.
-- ─────────────────────────────────────────────────────────────────────────────

-- Reedita el movimiento de un comprobante: un comprobante tiene SIEMPRE un solo
-- movimiento neto. Al editar monto/bono, revertimos el efecto anterior y
-- reaplicamos el nuevo SOBRE LA MISMA fila (no se crea un segundo movimiento),
-- todo atómico y con el mismo guard de negativo que la verificación.
-- Si el comprobante no tenía movimiento (histórico, o caja apagada al verificar),
-- no se crea ninguno: devuelve applied=false y no toca stock/billetera.
create or replace function fn_editar_movimiento_comprobante(
  p_tenant              uuid,
  p_comprobante         uuid,
  p_tipo                text,
  p_monto               bigint,
  p_bono                integer,
  p_new_fichas_delta    bigint,
  p_new_billetera_delta bigint,
  p_editor              uuid,
  p_editor_name         text
) returns json
language plpgsql
as $$
declare
  v_mov_id     uuid;
  v_operador   uuid;
  v_old_fichas bigint;
  v_old_bill   bigint;
  v_net_fichas bigint;
  v_net_bill   bigint;
  v_stock      bigint;
  v_saldo      bigint;
begin
  -- El ÚNICO movimiento asociado al comprobante (lock para serializar ediciones).
  select id, operador_id, fichas_delta, billetera_delta
    into v_mov_id, v_operador, v_old_fichas, v_old_bill
  from movimientos
  where tenant_id = p_tenant and comprobante_id = p_comprobante
  order by created_at asc
  limit 1
  for update;

  -- Sin movimiento previo: no se crea ninguno (no reprocesamos históricos).
  if v_mov_id is null then
    return json_build_object('applied', false);
  end if;

  -- Delta neto = nuevo - viejo (reemplaza, NO acumula).
  v_net_fichas := p_new_fichas_delta - v_old_fichas;
  v_net_bill   := p_new_billetera_delta - v_old_bill;

  -- Aplicar el neto al pozo, con lock de fila y guard infalible.
  update fichas_stock
     set stock_actual = stock_actual + v_net_fichas, updated_at = now()
   where tenant_id = p_tenant
   returning stock_actual into v_stock;
  if v_stock < 0 then
    raise exception 'No hay fichas suficientes';
  end if;

  -- Aplicar el neto a la billetera del MISMO operador que resolvió, con guard.
  update operador_billetera
     set saldo_actual = saldo_actual + v_net_bill, updated_at = now()
   where tenant_id = p_tenant and operador_id = v_operador
   returning saldo_actual into v_saldo;
  if v_saldo < 0 then
    raise exception 'Saldo insuficiente en billetera';
  end if;

  -- Reemplazar el movimiento EN SU LUGAR (un solo movimiento neto por comprobante).
  update movimientos
     set monto = p_monto, bono = p_bono,
         fichas_delta = p_new_fichas_delta, billetera_delta = p_new_billetera_delta,
         editado = true, editado_por = p_editor, editado_at = now()
   where id = v_mov_id;

  return json_build_object(
    'applied', true, 'movimiento_id', v_mov_id,
    'stock_actual', v_stock, 'saldo_actual', v_saldo
  );
end;
$$;

-- Borra un movimiento y REVIERTE su efecto en el pozo y en la billetera del
-- operador, atómico. Override del agente: NO aplica guard de negativo (puede
-- dejar saldo/stock en negativo; el front avisa). Devuelve found=false si no
-- existe (idempotente ante doble click).
create or replace function fn_borrar_movimiento(
  p_tenant uuid,
  p_mov_id uuid
) returns json
language plpgsql
as $$
declare
  v_operador uuid;
  v_fichas   bigint;
  v_bill     bigint;
  v_stock    bigint;
  v_saldo    bigint;
begin
  select operador_id, fichas_delta, billetera_delta
    into v_operador, v_fichas, v_bill
  from movimientos
  where id = p_mov_id and tenant_id = p_tenant
  for update;

  if not found then
    return json_build_object('found', false);
  end if;

  -- Revertir el efecto en el pozo (restamos lo que el movimiento había sumado).
  update fichas_stock
     set stock_actual = stock_actual - coalesce(v_fichas, 0), updated_at = now()
   where tenant_id = p_tenant
   returning stock_actual into v_stock;

  -- Revertir el efecto en la billetera del operador (si tenía uno asociado).
  if v_operador is not null then
    update operador_billetera
       set saldo_actual = saldo_actual - coalesce(v_bill, 0), updated_at = now()
     where tenant_id = p_tenant and operador_id = v_operador
     returning saldo_actual into v_saldo;
  end if;

  delete from movimientos where id = p_mov_id and tenant_id = p_tenant;

  return json_build_object(
    'found', true,
    'operador_id', v_operador,
    'stock_actual', v_stock,
    'saldo_actual', v_saldo
  );
end;
$$;

-- Reset total de la caja del tenant (modo prueba), atómico: pozo a 0, todas las
-- billeteras a 0 (turno cerrado), borra movimientos y cierres_turno. Los
-- comprobantes NO se tocan salvo que p_borrar_comprobantes sea true.
create or replace function fn_reset_total(
  p_tenant              uuid,
  p_borrar_comprobantes boolean
) returns json
language plpgsql
as $$
declare
  v_movs    int;
  v_cierres int;
  v_comps   int := 0;
begin
  insert into fichas_stock (tenant_id, stock_actual, updated_at)
  values (p_tenant, 0, now())
  on conflict (tenant_id) do update set stock_actual = 0, updated_at = now();

  update operador_billetera
     set saldo_actual = 0, turno_abierto = false, turno_inicio_at = null, updated_at = now()
   where tenant_id = p_tenant;

  delete from movimientos where tenant_id = p_tenant;
  get diagnostics v_movs = row_count;

  delete from cierres_turno where tenant_id = p_tenant;
  get diagnostics v_cierres = row_count;

  if p_borrar_comprobantes then
    delete from comprobantes where tenant_id = p_tenant;
    get diagnostics v_comps = row_count;
  end if;

  return json_build_object(
    'movimientos_borrados', v_movs,
    'cierres_borrados', v_cierres,
    'comprobantes_borrados', v_comps
  );
end;
$$;
