-- ═════════════════════════════════════════════════════════════════════════════
-- IRIS — Caja mejoras 2: guard de sueldo por turno + descargas con congelamiento
-- Rama: feature/caja-mejoras-2. Idempotente. Correr COMPLETO en el SQL Editor.
-- Requiere las etapas previas de caja ya corridas (stage2..stage6).
-- ═════════════════════════════════════════════════════════════════════════════


-- ── 2a) Saldo congelado por operador (plata reservada por descargas pendientes).
alter table operador_billetera
  add column if not exists saldo_congelado bigint not null default 0;


-- ── (A) Ampliar el CHECK de movimientos.tipo con los dos tipos nuevos.
--        Borra el check actual sobre `tipo` (cualquiera sea su nombre) y lo
--        recrea ampliado. Idempotente.
do $$
declare c text;
begin
  select conname into c
    from pg_constraint
   where conrelid = 'movimientos'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%tipo%';
  if c is not null then
    execute format('alter table movimientos drop constraint %I', c);
  end if;
end $$;

alter table movimientos add constraint movimientos_tipo_check
  check (tipo in (
    'carga','pago','descarga','sueldo','traspaso',
    'descarga_pendiente','descarga_rechazada'
  ));


-- ── CAMBIO 1) fn_cobrar_sueldo: un solo sueldo por turno.
--    Antes de descontar, verifica que no exista un movimiento 'sueldo' del
--    operador desde turno_inicio_at (o inicio del día AR si es null). Si existe,
--    aborta. Resto igual que antes.
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

  -- Asegurar la billetera del operador (arranca en 0 si no existe).
  insert into operador_billetera (tenant_id, operador_id, saldo_actual)
  values (p_tenant_id, p_operador_id, 0)
  on conflict (tenant_id, operador_id) do nothing;

  -- Lock de fila: serializa cobros concurrentes + lee el inicio de turno.
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


-- ── 2b) fn_cobrar_descarga: al pedir la descarga, CONGELA el monto (no descuenta).
--    Chequea saldo DISPONIBLE (saldo_actual - saldo_congelado). Inserta un
--    movimiento 'descarga_pendiente' con billetera_delta=0 (la plata sigue en la
--    billetera, solo reservada).
create or replace function fn_cobrar_descarga(
  p_tenant_id      uuid,
  p_operador_id    uuid,
  p_monto          bigint,
  p_comprobante_id uuid
) returns json
language plpgsql
as $$
declare
  v_saldo     bigint;
  v_congelado bigint;
  v_mov_id    uuid;
begin
  if not fn_caja_enabled(p_tenant_id) then
    raise exception 'La caja está desactivada';
  end if;
  if p_monto is null or p_monto <= 0 then
    raise exception 'Monto de descarga inválido';
  end if;

  insert into operador_billetera (tenant_id, operador_id, saldo_actual)
  values (p_tenant_id, p_operador_id, 0)
  on conflict (tenant_id, operador_id) do nothing;

  -- Lock de fila: serializa descargas/cierres concurrentes sobre la billetera.
  select saldo_actual, saldo_congelado
    into v_saldo, v_congelado
    from operador_billetera
   where tenant_id = p_tenant_id and operador_id = p_operador_id
   for update;

  if (v_saldo - v_congelado) < p_monto then
    raise exception 'Saldo disponible insuficiente para la descarga';
  end if;

  update operador_billetera
     set saldo_congelado = saldo_congelado + p_monto, updated_at = now()
   where tenant_id = p_tenant_id and operador_id = p_operador_id
   returning saldo_congelado into v_congelado;

  insert into movimientos (
    tenant_id, operador_id, tipo, monto, bono,
    fichas_delta, billetera_delta, comprobante_id, contraparte_id,
    creado_por, creado_por_name
  ) values (
    p_tenant_id, p_operador_id, 'descarga_pendiente', p_monto, null,
    0, 0, p_comprobante_id, null,
    p_operador_id, null
  ) returning id into v_mov_id;

  return json_build_object(
    'movimiento_id',    v_mov_id,
    'saldo_disponible', v_saldo - v_congelado,
    'saldo_congelado',  v_congelado
  );
end;
$$;


-- ── 2c) fn_verificar_descarga: al verificar, la plata SALE. Descuenta de
--    saldo_actual Y libera el congelado por igual, y acredita al agente que
--    verifica. Guard: tiene que haber congelado suficiente (se congeló al pedirla).
create or replace function fn_verificar_descarga(
  p_tenant_id      uuid,
  p_operador_id    uuid,
  p_monto          bigint,
  p_comprobante_id uuid,
  p_verificado_por uuid
) returns json
language plpgsql
as $$
declare
  v_saldo_op  bigint;
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

  insert into operador_billetera (tenant_id, operador_id, saldo_actual)
  values (p_tenant_id, p_operador_id, 0)
  on conflict (tenant_id, operador_id) do nothing;

  select saldo_actual, saldo_congelado
    into v_saldo_op, v_congelado
    from operador_billetera
   where tenant_id = p_tenant_id and operador_id = p_operador_id
   for update;

  if v_congelado < p_monto then
    raise exception 'La descarga no tiene fondos congelados suficientes';
  end if;

  -- Sale la plata: baja saldo_actual y libera el congelado por igual.
  update operador_billetera
     set saldo_actual    = saldo_actual    - p_monto,
         saldo_congelado = saldo_congelado - p_monto,
         updated_at = now()
   where tenant_id = p_tenant_id and operador_id = p_operador_id
   returning saldo_actual into v_saldo_op;

  -- Acreditar al agente que verifica (UPSERT: crea la fila si no existe).
  insert into operador_billetera (tenant_id, operador_id, saldo_actual, updated_at)
  values (p_tenant_id, p_verificado_por, p_monto, now())
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
    0, -p_monto, p_comprobante_id, p_verificado_por,
    p_verificado_por, null
  ) returning id into v_mov_id;

  return json_build_object(
    'movimiento_id',  v_mov_id,
    'monto',          p_monto,
    'saldo_operador', v_saldo_op,
    'saldo_agente',   v_saldo_ag
  );
end;
$$;


-- ── 2d) fn_rechazar_descarga: libera el congelado (la plata vuelve a DISPONIBLE).
--    NO toca saldo_actual ni acredita a nadie. No exige caja encendida (solo
--    libera una reserva). Inserta movimiento 'descarga_rechazada'.
create or replace function fn_rechazar_descarga(
  p_tenant_id      uuid,
  p_operador_id    uuid,
  p_monto          bigint,
  p_comprobante_id uuid
) returns json
language plpgsql
as $$
declare
  v_congelado bigint;
  v_mov_id    uuid;
begin
  if p_monto is null or p_monto <= 0 then
    raise exception 'Monto de descarga inválido';
  end if;

  insert into operador_billetera (tenant_id, operador_id, saldo_actual)
  values (p_tenant_id, p_operador_id, 0)
  on conflict (tenant_id, operador_id) do nothing;

  select saldo_congelado into v_congelado
    from operador_billetera
   where tenant_id = p_tenant_id and operador_id = p_operador_id
   for update;

  if v_congelado < p_monto then
    raise exception 'No hay fondos congelados suficientes para rechazar';
  end if;

  update operador_billetera
     set saldo_congelado = saldo_congelado - p_monto, updated_at = now()
   where tenant_id = p_tenant_id and operador_id = p_operador_id
   returning saldo_congelado into v_congelado;

  insert into movimientos (
    tenant_id, operador_id, tipo, monto, bono,
    fichas_delta, billetera_delta, comprobante_id, contraparte_id,
    creado_por, creado_por_name
  ) values (
    p_tenant_id, p_operador_id, 'descarga_rechazada', p_monto, null,
    0, 0, p_comprobante_id, null,
    p_operador_id, null
  ) returning id into v_mov_id;

  return json_build_object(
    'movimiento_id',   v_mov_id,
    'saldo_congelado', v_congelado
  );
end;
$$;


-- ── 2e) fn_cerrar_turno: solo traspasa lo DISPONIBLE (saldo_actual - saldo_congelado).
--    El congelado NO se traspasa ni se toca: saldo_actual queda = saldo_congelado,
--    para que las descargas pendientes se puedan verificar después.
create or replace function fn_cerrar_turno(
  p_tenant_id           uuid,
  p_operador_id         uuid,
  p_operador_destino_id uuid,
  p_comprobante_id      uuid
) returns json
language plpgsql
as $$
declare
  v_inicio       timestamptz;
  v_saldo        bigint;
  v_congelado    bigint;
  v_cargas       bigint;
  v_pagos        bigint;
  v_descargas    bigint;
  v_sueldo       bigint;
  v_traspaso     bigint;
  v_destino      uuid;
  v_stock        bigint;
  v_mov_id       uuid;
  v_cierre_id    uuid;
begin
  if not fn_caja_enabled(p_tenant_id) then
    raise exception 'La caja está desactivada';
  end if;

  insert into operador_billetera (tenant_id, operador_id, saldo_actual)
  values (p_tenant_id, p_operador_id, 0)
  on conflict (tenant_id, operador_id) do nothing;

  -- Lock de fila: leer saldo, congelado e inicio de turno serializando el cierre.
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

  -- Destino: el operador elegido, o el agente del tenant si no hay (sin traspaso).
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

  -- Cerrar turno: saldo_actual queda = saldo_congelado (conserva lo congelado);
  -- el disponible se va al destino. saldo_congelado NO se modifica.
  update operador_billetera
     set saldo_actual = saldo_congelado, turno_abierto = false, turno_inicio_at = null, updated_at = now()
   where tenant_id = p_tenant_id and operador_id = p_operador_id;

  if v_traspaso <> 0 then
    insert into operador_billetera (tenant_id, operador_id, saldo_actual, updated_at)
    values (p_tenant_id, v_destino, v_traspaso, now())
    on conflict (tenant_id, operador_id)
    do update set saldo_actual = operador_billetera.saldo_actual + excluded.saldo_actual,
                  updated_at   = now();

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
