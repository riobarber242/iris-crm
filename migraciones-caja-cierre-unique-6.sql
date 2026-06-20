-- ═════════════════════════════════════════════════════════════════════════════
-- IRIS — Anti-duplicado de cierre de turno: unique index parcial + guard en fn
-- Idempotente. Correr en el SQL Editor DESPUÉS de
-- migraciones-caja-cierre-inmediato-3.sql.
--
-- fn_cerrar_turno insertaba en cierres_turno sin guard: dos llamadas seguidas
-- (p. ej. doble-tap antes de que el front refresque turno_cerrado) dejaban dos
-- filas (la 2ª con total_traspaso = 0). Acá:
--   1) dedup de cierres existentes (pre-requisito del index),
--   2) unique index parcial (tenant_id, operador_id, turno_inicio_at),
--   3) fn_cerrar_turno con guard silencioso: si ya hay cierre para ese turno,
--      devuelve el existente sin insertar de nuevo (no rompe, no duplica).
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 1) Pre-requisito: si ya hay duplicados de un cierre anterior, dejar una sola
--       fila por (tenant_id, operador_id, turno_inicio_at), conservando la MÁS
--       ANTIGUA (la primera llamada = el cierre real; las repetidas traen
--       total_traspaso = 0). Sin esto, el CREATE UNIQUE INDEX fallaría.
--       Idempotente: tras la 1ª corrida no quedan duplicados, la 2ª no borra nada.
delete from cierres_turno c
 using cierres_turno d
 where c.tenant_id       = d.tenant_id
   and c.operador_id     = d.operador_id
   and c.turno_inicio_at = d.turno_inicio_at
   and c.turno_inicio_at is not null
   and (c.created_at, c.id) > (d.created_at, d.id);

-- ── 2) Unique index parcial: bloquea futuros dobles inserts a nivel base.
--       Es PARCIAL (turno_inicio_at IS NOT NULL): fn_cerrar_turno siempre setea
--       turno_inicio_at, y así no afecta a filas legadas con inicio nulo.
create unique index if not exists uq_cierres_turno_operador_inicio
  on cierres_turno (tenant_id, operador_id, turno_inicio_at)
  where turno_inicio_at is not null;

-- ── 3) fn_cerrar_turno con GUARD silencioso. Idéntica a la de la migración -3,
--       agregando: si ya existe un cierre para este turno (mismo turno_inicio_at),
--       devuelve el cierre existente y corta — sin insertar ni mover plata de
--       nuevo. Espeja el unique index de arriba.
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

  -- GUARD silencioso: si ya hay un cierre para este turno (mismo inicio), no
  -- duplicar. Devuelve el cierre existente y corta, sin tocar plata. Espeja el
  -- unique index parcial uq_cierres_turno_operador_inicio.
  select id into v_cierre_id
    from cierres_turno
   where tenant_id = p_tenant_id and operador_id = p_operador_id
     and turno_inicio_at = v_inicio
   order by created_at asc
   limit 1;
  if v_cierre_id is not null then
    return json_build_object(
      'cierre_id',       v_cierre_id,
      'turno_inicio_at', v_inicio,
      'total_traspaso',  0,
      'already_closed',  true
    );
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
