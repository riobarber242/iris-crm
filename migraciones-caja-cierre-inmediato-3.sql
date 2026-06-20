-- ═════════════════════════════════════════════════════════════════════════════
-- IRIS — Caja cierre inmediato (modelo A+B) + descargas automáticas
-- Idempotente. Correr COMPLETO en el SQL Editor DESPUÉS de
-- migraciones-caja-mejoras-2.sql (necesita saldo_congelado, cierres_turno, etc.).
--
-- Resumen de cambios:
--   · fn_cerrar_turno  → CIERRE INMEDIATO: vacía lo disponible del que cierra,
--                        marca el turno cerrado, registra el cierre y el
--                        movimiento de salida. NO acredita al receptor.
--   · fn_acreditar_traspaso → NUEVA: acredita al receptor recién al VERIFICAR.
--   · fn_aplicar_descarga   → NUEVA: descarga inmediata sin congelar.
--   · fn_cobrar_sueldo  → agrega guard "turno ya cerrado hoy".
-- ═════════════════════════════════════════════════════════════════════════════


-- ── 1) fn_cerrar_turno: CIERRE INMEDIATO para quien cierra.
--    Traspasa lo DISPONIBLE (saldo_actual - saldo_congelado): vacía el origen
--    (saldo_actual queda = saldo_congelado), marca el turno cerrado, registra el
--    cierre en cierres_turno y el movimiento 'traspaso' de SALIDA del origen.
--    NO acredita al destino: esa plata queda pendiente de verificación del
--    receptor (fn_acreditar_traspaso). El congelado no se toca.
create or replace function fn_cerrar_turno(
  p_tenant_id           uuid,
  p_operador_id         uuid,
  p_operador_destino_id uuid,
  p_comprobante_id      uuid
) returns json
language plpgsql
as $$
declare
  v_inicio    timestamptz;
  v_saldo     bigint;
  v_congelado bigint;
  v_cargas    bigint;
  v_pagos     bigint;
  v_descargas bigint;
  v_sueldo    bigint;
  v_traspaso  bigint;
  v_destino   uuid;
  v_stock     bigint;
  v_mov_id    uuid;
  v_cierre_id uuid;
begin
  if not fn_caja_enabled(p_tenant_id) then
    raise exception 'La caja está desactivada';
  end if;

  insert into operador_billetera (tenant_id, operador_id, saldo_actual)
  values (p_tenant_id, p_operador_id, 0)
  on conflict (tenant_id, operador_id) do nothing;

  -- Lock de fila: serializa el cierre sobre la billetera del origen.
  select saldo_actual, saldo_congelado, turno_inicio_at
    into v_saldo, v_congelado, v_inicio
    from operador_billetera
   where tenant_id = p_tenant_id and operador_id = p_operador_id
   for update;

  -- Fallback de inicio de turno: día actual en America/Argentina/Buenos_Aires.
  if v_inicio is null then
    v_inicio := (date_trunc('day', (now() at time zone 'America/Argentina/Buenos_Aires')))
                  at time zone 'America/Argentina/Buenos_Aires';
  end if;

  -- Totales del turno (movimientos del operador desde el inicio).
  select
    coalesce(sum(monto) filter (where tipo = 'carga'),    0),
    coalesce(sum(monto) filter (where tipo = 'pago'),     0),
    coalesce(sum(monto) filter (where tipo = 'descarga'), 0),
    coalesce(sum(monto) filter (where tipo = 'sueldo'),   0)
  into v_cargas, v_pagos, v_descargas, v_sueldo
  from movimientos
  where tenant_id = p_tenant_id and operador_id = p_operador_id and created_at >= v_inicio;

  -- Solo se traspasa lo DISPONIBLE; el congelado se queda en la billetera.
  v_traspaso := v_saldo - v_congelado;

  select coalesce(stock_actual, 0) into v_stock from fichas_stock where tenant_id = p_tenant_id;
  v_stock := coalesce(v_stock, 0);

  -- Destino: el operador elegido, o el agente del tenant si no hay.
  v_destino := p_operador_destino_id;
  if v_destino is null then
    select id into v_destino
      from agents
     where tenant_id = p_tenant_id and role = 'agent'
     order by created_at asc
     limit 1;
    if v_destino is null then
      raise exception 'No hay un agente para recibir el traspaso';
    end if;
  end if;

  -- Cerrar turno YA: saldo_actual queda = saldo_congelado (conserva lo congelado);
  -- el disponible sale de la billetera. El turno queda cerrado.
  update operador_billetera
     set saldo_actual = saldo_congelado, turno_abierto = false, turno_inicio_at = null, updated_at = now()
   where tenant_id = p_tenant_id and operador_id = p_operador_id;

  -- Movimiento de SALIDA del origen. El receptor NO se acredita acá: lo hace
  -- fn_acreditar_traspaso al verificar. Si no hay disponible, no hay movimiento.
  if v_traspaso <> 0 then
    insert into movimientos (
      tenant_id, operador_id, tipo, monto, bono,
      fichas_delta, billetera_delta, comprobante_id, contraparte_id,
      creado_por, creado_por_name
    ) values (
      p_tenant_id, p_operador_id, 'traspaso', v_traspaso, null,
      0, -v_traspaso, p_comprobante_id, v_destino,
      p_operador_id, null
    ) returning id into v_mov_id;
  end if;

  insert into cierres_turno (
    tenant_id, operador_id, operador_destino_id, turno_inicio_at, turno_fin_at,
    total_cargas, total_pagos, total_descargas, total_sueldo, total_traspaso,
    fichas_inicio, fichas_fin, billetera_inicio, billetera_final, traspaso_id
  ) values (
    p_tenant_id, p_operador_id, v_destino, v_inicio, now(),
    v_cargas, v_pagos, v_descargas, v_sueldo, v_traspaso,
    v_stock, v_stock, v_saldo, v_congelado, null
  ) returning id into v_cierre_id;

  return json_build_object(
    'cierre_id',        v_cierre_id,
    'turno_inicio_at',  v_inicio,
    'total_cargas',     v_cargas,
    'total_pagos',      v_pagos,
    'total_descargas',  v_descargas,
    'total_sueldo',     v_sueldo,
    'total_traspaso',   v_traspaso,
    'billetera_inicio', v_saldo,
    'saldo_congelado',  v_congelado,
    'destino_id',       v_destino
  );
end;
$$;


-- ── 2) fn_acreditar_traspaso: el RECEPTOR confirma que la plata le entró.
--    Acredita p_monto a la billetera del destino y registra el movimiento de
--    ENTRADA. Independiente del cierre (que ya pasó). Si el monto es 0, no hace
--    nada (cierre sin disponible).
create or replace function fn_acreditar_traspaso(
  p_tenant_id      uuid,
  p_destino_id     uuid,
  p_monto          bigint,
  p_comprobante_id uuid
) returns json
language plpgsql
as $$
declare
  v_saldo bigint;
  v_mov_id uuid;
begin
  if not fn_caja_enabled(p_tenant_id) then
    raise exception 'La caja está desactivada';
  end if;
  if p_destino_id is null then
    raise exception 'El traspaso no tiene destino';
  end if;
  if p_monto is null or p_monto <= 0 then
    return json_build_object('skipped', true);
  end if;

  insert into operador_billetera (tenant_id, operador_id, saldo_actual, updated_at)
  values (p_tenant_id, p_destino_id, p_monto, now())
  on conflict (tenant_id, operador_id)
  do update set saldo_actual = operador_billetera.saldo_actual + excluded.saldo_actual,
                updated_at   = now()
  returning saldo_actual into v_saldo;

  insert into movimientos (
    tenant_id, operador_id, tipo, monto, bono,
    fichas_delta, billetera_delta, comprobante_id, contraparte_id,
    creado_por, creado_por_name
  ) values (
    p_tenant_id, p_destino_id, 'traspaso', p_monto, null,
    0, p_monto, p_comprobante_id, null,
    p_destino_id, null
  ) returning id into v_mov_id;

  return json_build_object('movimiento_id', v_mov_id, 'saldo_actual', v_saldo);
end;
$$;


-- ── 3) fn_aplicar_descarga: descarga INMEDIATA, sin congelar ni verificar.
--    Chequea saldo DISPONIBLE (saldo_actual - saldo_congelado), descuenta del
--    operador y acredita al agente del tenant. Registra el movimiento 'descarga'.
create or replace function fn_aplicar_descarga(
  p_tenant_id      uuid,
  p_operador_id    uuid,
  p_agente_id      uuid,
  p_monto          bigint,
  p_comprobante_id uuid
) returns json
language plpgsql
as $$
declare
  v_saldo     bigint;
  v_congelado bigint;
  v_saldo_ag  bigint;
  v_mov_id    uuid;
begin
  if not fn_caja_enabled(p_tenant_id) then
    raise exception 'La caja está desactivada';
  end if;
  if p_monto is null or p_monto <= 0 then
    raise exception 'Monto de descarga inválido';
  end if;
  if p_agente_id is null then
    raise exception 'No hay un agente para recibir la descarga';
  end if;

  insert into operador_billetera (tenant_id, operador_id, saldo_actual)
  values (p_tenant_id, p_operador_id, 0)
  on conflict (tenant_id, operador_id) do nothing;

  select saldo_actual, saldo_congelado
    into v_saldo, v_congelado
    from operador_billetera
   where tenant_id = p_tenant_id and operador_id = p_operador_id
   for update;

  if (v_saldo - v_congelado) < p_monto then
    raise exception 'Saldo disponible insuficiente para la descarga';
  end if;

  update operador_billetera
     set saldo_actual = saldo_actual - p_monto, updated_at = now()
   where tenant_id = p_tenant_id and operador_id = p_operador_id
   returning saldo_actual into v_saldo;

  -- Acreditar al agente (UPSERT: crea la fila si no existe).
  insert into operador_billetera (tenant_id, operador_id, saldo_actual, updated_at)
  values (p_tenant_id, p_agente_id, p_monto, now())
  on conflict (tenant_id, operador_id)
  do update set saldo_actual = operador_billetera.saldo_actual + excluded.saldo_actual,
                updated_at   = now()
  returning saldo_actual into v_saldo_ag;

  insert into movimientos (
    tenant_id, operador_id, tipo, monto, bono,
    fichas_delta, billetera_delta, comprobante_id, contraparte_id,
    creado_por, creado_por_name
  ) values (
    p_tenant_id, p_operador_id, 'descarga', p_monto, null,
    0, -p_monto, p_comprobante_id, p_agente_id,
    p_operador_id, null
  ) returning id into v_mov_id;

  return json_build_object(
    'movimiento_id',  v_mov_id,
    'saldo_operador', v_saldo,
    'saldo_agente',   v_saldo_ag
  );
end;
$$;


-- ── 4) fn_cobrar_sueldo: un sueldo por turno + bloqueo si el turno YA cerró hoy.
--    Igual que en migraciones-caja-mejoras-2, agregando el guard de cierre: si
--    existe un cierre del operador en el turno vigente (desde v_inicio), aborta.
create or replace function fn_cobrar_sueldo(
  p_tenant_id   uuid,
  p_operador_id uuid
) returns json
language plpgsql
as $$
declare
  v_sueldo bigint;
  v_saldo  bigint;
  v_inicio timestamptz;
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

  insert into operador_billetera (tenant_id, operador_id, saldo_actual)
  values (p_tenant_id, p_operador_id, 0)
  on conflict (tenant_id, operador_id) do nothing;

  select saldo_actual, turno_inicio_at
    into v_saldo, v_inicio
    from operador_billetera
   where tenant_id = p_tenant_id and operador_id = p_operador_id
   for update;

  -- Fallback de inicio de turno: día actual en America/Argentina/Buenos_Aires.
  if v_inicio is null then
    v_inicio := (date_trunc('day', (now() at time zone 'America/Argentina/Buenos_Aires')))
                  at time zone 'America/Argentina/Buenos_Aires';
  end if;

  -- Guard NUEVO: si el operador ya cerró su turno en el período vigente, no
  -- puede cobrar sueldo (el turno está cerrado; cobra en el próximo).
  if exists (
    select 1 from cierres_turno
     where tenant_id = p_tenant_id and operador_id = p_operador_id
       and turno_fin_at >= v_inicio
  ) then
    raise exception 'Cerraste el turno; cobrás el sueldo en tu próximo turno';
  end if;

  -- Guard: un solo sueldo por turno (desde el inicio calculado hasta ahora).
  if exists (
    select 1 from movimientos
     where tenant_id = p_tenant_id and operador_id = p_operador_id
       and tipo = 'sueldo' and created_at >= v_inicio
  ) then
    raise exception 'Ya cobraste el sueldo en este turno';
  end if;

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


-- ═════════════════════════════════════════════════════════════════════════════
-- ── LIMPIEZA OPCIONAL (correr UNA sola vez) ──────────────────────────────────
-- Descongela las descargas viejas que quedaron PENDIENTES de las pruebas, para
-- que no quede plata trabada. Con el modelo nuevo las descargas son inmediatas y
-- ya no congelan, así que el congelado remanente es siempre de estas pruebas.
--
-- ⚠️ DESCOMENTAR el bloque de abajo y correrlo aparte (después de las funciones).
--    Marca esos comprobantes como 'rechazado' y pone el congelado en 0.
-- ─────────────────────────────────────────────────────────────────────────────
-- begin;
--   update comprobantes
--      set estado = 'rechazado', resolved_at = now()
--    where tipo = 'descarga' and estado = 'pendiente';
--   update operador_billetera
--      set saldo_congelado = 0, updated_at = now()
--    where saldo_congelado > 0;
-- commit;
