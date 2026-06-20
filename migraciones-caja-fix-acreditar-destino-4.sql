-- ═════════════════════════════════════════════════════════════════════════════
-- IRIS — Fix: fn_acreditar_traspaso resuelve destino null → agente del tenant
-- Idempotente. Correr en el SQL Editor DESPUÉS de
-- migraciones-caja-cierre-inmediato-3.sql.
--
-- Problema: al verificar un cierre cuyo comprobante tiene operador_destino_id
-- NULL (cierres "al agente" creados antes del deploy del modelo nuevo), la
-- función abortaba con 'El traspaso no tiene destino' → 400 y la plata no se
-- acreditaba. Ahora, si el destino llega null, se resuelve al agente del tenant
-- (mismo fallback que fn_cerrar_turno) en vez de abortar.
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function fn_acreditar_traspaso(
  p_tenant_id      uuid,
  p_destino_id     uuid,
  p_monto          bigint,
  p_comprobante_id uuid
) returns json
language plpgsql
as $$
declare
  v_destino uuid;
  v_saldo   bigint;
  v_mov_id  uuid;
begin
  if not fn_caja_enabled(p_tenant_id) then
    raise exception 'La caja está desactivada';
  end if;

  -- Destino: el del comprobante, o el agente del tenant si llega null (cierres
  -- "al agente" del modelo viejo, o cualquier comprobante sin destino guardado).
  v_destino := p_destino_id;
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

  if p_monto is null or p_monto <= 0 then
    return json_build_object('skipped', true, 'destino_id', v_destino);
  end if;

  insert into operador_billetera (tenant_id, operador_id, saldo_actual, updated_at)
  values (p_tenant_id, v_destino, p_monto, now())
  on conflict (tenant_id, operador_id)
  do update set saldo_actual = operador_billetera.saldo_actual + excluded.saldo_actual,
                updated_at   = now()
  returning saldo_actual into v_saldo;

  insert into movimientos (
    tenant_id, operador_id, tipo, monto, bono,
    fichas_delta, billetera_delta, comprobante_id, contraparte_id,
    creado_por, creado_por_name
  ) values (
    p_tenant_id, v_destino, 'traspaso', p_monto, null,
    0, p_monto, p_comprobante_id, null,
    v_destino, null
  ) returning id into v_mov_id;

  return json_build_object('movimiento_id', v_mov_id, 'saldo_actual', v_saldo, 'destino_id', v_destino);
end;
$$;


-- ═════════════════════════════════════════════════════════════════════════════
-- ── LIMPIEZA OPCIONAL (D) — correr UNA sola vez ──────────────────────────────
-- Rellena el destino de los cierres PENDIENTES que quedaron con operador_destino_id
-- NULL (creados antes del deploy), apuntándolos al agente del tenant. Con el fix
-- de arriba ya no hace falta para poder verificar, pero deja los datos prolijos.
--
-- ⚠️ DESCOMENTAR y correr aparte:
-- ─────────────────────────────────────────────────────────────────────────────
-- update comprobantes c
--    set operador_destino_id = (
--      select a.id from agents a
--       where a.tenant_id = c.tenant_id and a.role = 'agent'
--       order by a.created_at asc limit 1
--    )
--  where c.tipo = 'traspaso'
--    and c.estado = 'pendiente'
--    and c.operador_destino_id is null;
