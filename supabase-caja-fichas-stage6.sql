-- ─────────────────────────────────────────────────────────────────────────────
-- IRIS — Caja de fichas (Etapa 6: Cierre de turno con traspaso)
-- Correr ESTE bloque en el SQL Editor de Supabase. Es idempotente
-- (if not exists / create or replace).
--
-- Requiere las etapas previas:
--   supabase-caja-fichas.sql        (Etapa 2: modelo + cierres_turno + fn base)
--   supabase-caja-fichas-stage3.sql (Etapa 3)
--   supabase-caja-fichas-stage4.sql (Etapa 4)
--   supabase-caja-fichas-stage5.sql (Etapa 5: fn_caja_enabled + comprobantes.operador_id)
--
-- MODELO (idéntico al de descargas, Etapa 5):
--   1) El operador "cierra turno" desde Mi Caja → se crea un comprobante
--      tipo='traspaso' en estado 'pendiente'. La billetera NO se toca todavía.
--   2) El receptor / agente verifica el comprobante en /fichas → recién ahí
--      fn_cerrar_turno mueve la plata (origen→0, destino+=monto), inserta el
--      cierre en cierres_turno y resetea el turno.
--
-- caja_enabled manda: fn_cerrar_turno aborta si el flag está OFF.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. cierres_turno: completar columnas que falten respecto del modelo final.
--    La tabla ya existe desde la Etapa 2; agregamos solo lo nuevo.
--      billetera_inicio    → saldo del operador al ejecutarse el cierre (= traspaso).
--      operador_destino_id → a quién se traspasó (operador u agente). Para mostrar
--                            el destino en "Mis cierres" y en el panel del agente.
alter table cierres_turno add column if not exists billetera_inicio    bigint default 0;
alter table cierres_turno add column if not exists operador_destino_id uuid references agents(id) on delete set null;
-- Por las dudas (si algún entorno quedó con la tabla incompleta), aseguramos el resto.
alter table cierres_turno add column if not exists total_cargas    bigint default 0;
alter table cierres_turno add column if not exists total_pagos     bigint default 0;
alter table cierres_turno add column if not exists total_descargas bigint default 0;
alter table cierres_turno add column if not exists total_sueldo    bigint default 0;
alter table cierres_turno add column if not exists total_traspaso  bigint default 0;
alter table cierres_turno add column if not exists fichas_inicio   bigint default 0;
alter table cierres_turno add column if not exists fichas_fin      bigint default 0;
alter table cierres_turno add column if not exists billetera_final bigint default 0;

-- ── 2. comprobantes.operador_destino_id: a quién va el traspaso del cierre.
--    Nullable: "sin traspaso" (depositar al agente) lo deja en null y el destino
--    se resuelve al admin del tenant dentro de fn_cerrar_turno. ('traspaso' ya está
--    admitido por el check de comprobantes.tipo desde la Etapa 2, no se toca.)
alter table comprobantes add column if not exists operador_destino_id uuid references agents(id) on delete set null;

-- ── 3. movimientos.tipo: el check de la Etapa 2 ya admite 'traspaso'
--    (check (tipo in ('carga','pago','descarga','sueldo','traspaso'))). No se toca.

-- ─────────────────────────────────────────────────────────────────────────────
-- fn_cerrar_turno — se ejecuta AL VERIFICAR el comprobante de traspaso (no al
-- cerrar). Mueve la plata de la billetera del operador a la del destino, registra
-- el cierre con la foto del turno y resetea el turno. Atómico, con lock de fila
-- sobre la billetera del origen. Mismo patrón que fn_verificar_descarga.
--
--   p_operador_destino_id null → destino = admin del tenant (agente más antiguo).
--   p_comprobante_id           → se liga al movimiento de traspaso.
-- ─────────────────────────────────────────────────────────────────────────────
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

  -- Asegurar la billetera del operador (arranca en 0 si no existe).
  insert into operador_billetera (tenant_id, operador_id, saldo_actual)
  values (p_tenant_id, p_operador_id, 0)
  on conflict (tenant_id, operador_id) do nothing;

  -- Lock de fila: leer saldo e inicio de turno serializando el cierre.
  select saldo_actual, turno_inicio_at
    into v_saldo, v_inicio
    from operador_billetera
   where tenant_id = p_tenant_id and operador_id = p_operador_id
   for update;

  -- Fallback: si no hay turno abierto (turno_inicio_at null), tomamos el inicio
  -- del día actual en America/Argentina/Buenos_Aires (UTC-3) para los totales.
  if v_inicio is null then
    v_inicio := (date_trunc('day', (now() at time zone 'America/Argentina/Buenos_Aires')))
                  at time zone 'America/Argentina/Buenos_Aires';
  end if;

  -- Totales del turno (movimientos del operador desde el inicio). El movimiento de
  -- traspaso se inserta MÁS ABAJO, así que no se cuenta a sí mismo.
  select
    coalesce(sum(monto) filter (where tipo = 'carga'),    0),
    coalesce(sum(monto) filter (where tipo = 'pago'),     0),
    coalesce(sum(monto) filter (where tipo = 'descarga'), 0),
    coalesce(sum(monto) filter (where tipo = 'sueldo'),   0)
  into v_cargas, v_pagos, v_descargas, v_sueldo
  from movimientos
  where tenant_id = p_tenant_id and operador_id = p_operador_id and created_at >= v_inicio;

  v_traspaso := v_saldo;  -- lo que queda = lo que se traspasa

  -- Snapshot del pozo (no cambia por operador, pero lo dejamos registrado).
  select coalesce(stock_actual, 0) into v_stock from fichas_stock where tenant_id = p_tenant_id;
  v_stock := coalesce(v_stock, 0);

  -- Destino: el operador elegido, o el admin del tenant si no hay (sin traspaso).
  v_destino := p_operador_destino_id;
  if v_destino is null then
    select id into v_destino
      from agents
     where tenant_id = p_tenant_id and role = 'admin'
     order by created_at asc
     limit 1;
    if v_destino is null then
      raise exception 'No hay un agente (admin) para recibir el traspaso';
    end if;
  end if;

  -- Mover el saldo: origen → 0 (turno cerrado), destino += traspaso.
  update operador_billetera
     set saldo_actual = 0, turno_abierto = false, turno_inicio_at = null, updated_at = now()
   where tenant_id = p_tenant_id and operador_id = p_operador_id;

  if v_traspaso <> 0 then
    insert into operador_billetera (tenant_id, operador_id, saldo_actual, updated_at)
    values (p_tenant_id, v_destino, v_traspaso, now())
    on conflict (tenant_id, operador_id)
    do update set saldo_actual = operador_billetera.saldo_actual + excluded.saldo_actual,
                  updated_at   = now();

    -- Movimiento de traspaso, perspectiva del origen (billetera_delta=-traspaso),
    -- con el destino como contraparte. Las fichas del pozo NO se tocan.
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

  -- Registrar el cierre con la foto del turno.
  insert into cierres_turno (
    tenant_id, operador_id, operador_destino_id, turno_inicio_at, turno_fin_at,
    total_cargas, total_pagos, total_descargas, total_sueldo, total_traspaso,
    fichas_inicio, fichas_fin, billetera_inicio, billetera_final, traspaso_id
  ) values (
    p_tenant_id, p_operador_id, v_destino, v_inicio, now(),
    v_cargas, v_pagos, v_descargas, v_sueldo, v_traspaso,
    v_stock, v_stock, v_saldo, 0, null
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
    'destino_id',       v_destino
  );
end;
$$;
