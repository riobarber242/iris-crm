-- ─────────────────────────────────────────────────────────────────────────────
-- IRIS — Caja de fichas y billeteras por operador (Etapa 2: modelo + lógica)
-- Correr ESTE bloque en el SQL Editor de Supabase (este proyecto NO tiene la
-- función exec_sql, así que el DDL no se puede correr por la API/service-role).
-- Es idempotente: se puede correr más de una vez sin romper nada.
--
-- Etapa 2 = solo estructura + funciones atómicas. NADA llama todavía a
-- fn_aplicar_movimiento desde el flujo de verificar comprobantes (eso es Etapa
-- 3). Mientras esta migración NO se haya corrido, el backend degrada con
-- elegancia (src/lib/caja.ts detecta tabla/función ausente y no rompe).
--
-- Toda la plata/fichas va en BIGINT.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Pozo único de fichas por tenant ───────────────────────────────────────
create table if not exists fichas_stock (
  tenant_id    uuid primary key references tenants(id) on delete cascade,
  stock_actual bigint not null default 0,
  updated_at   timestamptz default now()
);

-- ── 2. Historial de recargas del agente al pozo ──────────────────────────────
create table if not exists fichas_recargas (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  cantidad    bigint not null,
  agente_id   uuid references agents(id) on delete set null,
  agente_name text,
  created_at  timestamptz default now()
);
create index if not exists idx_fichas_recargas_tenant on fichas_recargas(tenant_id, created_at desc);

-- ── 3. Caja (billetera) por operador ─────────────────────────────────────────
create table if not exists operador_billetera (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  operador_id     uuid not null references agents(id) on delete cascade,
  saldo_actual    bigint not null default 0,
  turno_abierto   boolean default false,
  turno_inicio_at timestamptz,
  updated_at      timestamptz default now(),
  unique (tenant_id, operador_id)
);
create index if not exists idx_operador_billetera_tenant on operador_billetera(tenant_id);

-- ── 4. Movimientos: registro de todo cambio de fichas/billetera ──────────────
create table if not exists movimientos (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  operador_id      uuid references agents(id) on delete set null,
  tipo             text not null check (tipo in ('carga','pago','descarga','sueldo','traspaso')),
  monto            bigint not null,
  bono             integer,
  fichas_delta     bigint not null,
  billetera_delta  bigint not null,
  comprobante_id   uuid references comprobantes(id) on delete set null,
  contraparte_id   uuid references agents(id) on delete set null,   -- el otro operador (traspaso)
  creado_por       uuid references agents(id) on delete set null,
  creado_por_name  text,
  created_at       timestamptz default now(),
  editado          boolean default false,
  editado_por      uuid references agents(id) on delete set null,
  editado_at       timestamptz
);
create index if not exists idx_movimientos_tenant      on movimientos(tenant_id, created_at desc);
create index if not exists idx_movimientos_operador    on movimientos(tenant_id, operador_id, created_at desc);
create index if not exists idx_movimientos_comprobante on movimientos(comprobante_id);

-- ── 5. Traspasos: cierre de turno entre operadores ───────────────────────────
create table if not exists traspasos (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  operador_origen  uuid references agents(id) on delete set null,
  operador_destino uuid references agents(id) on delete set null,
  monto            bigint not null,
  comprobante_id   uuid references comprobantes(id) on delete set null,
  enviado_at       timestamptz default now(),
  verificado_at    timestamptz,
  verificado_por   uuid references agents(id) on delete set null,
  estado           text not null default 'pendiente' check (estado in ('pendiente','verificado'))
);
create index if not exists idx_traspasos_tenant on traspasos(tenant_id, enviado_at desc);

-- ── 6. Cierres de turno: reporte por operador ────────────────────────────────
create table if not exists cierres_turno (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  operador_id     uuid references agents(id) on delete set null,
  turno_inicio_at timestamptz,
  turno_fin_at    timestamptz,
  total_cargas    bigint default 0,
  total_pagos     bigint default 0,
  total_descargas bigint default 0,
  total_sueldo    bigint default 0,
  total_traspaso  bigint default 0,
  fichas_inicio   bigint default 0,
  fichas_fin      bigint default 0,
  billetera_final bigint default 0,
  traspaso_id     uuid references traspasos(id) on delete set null,
  created_at      timestamptz default now()
);
create index if not exists idx_cierres_turno_tenant on cierres_turno(tenant_id, created_at desc);

-- ── 7. comprobantes.tipo: qué clase de operación es el comprobante ───────────
alter table comprobantes add column if not exists tipo text default 'carga';
-- Check idempotente (no existe "add constraint if not exists" en Postgres viejo).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'comprobantes_tipo_check') then
    alter table comprobantes
      add constraint comprobantes_tipo_check check (tipo in ('carga','pago','descarga','traspaso'));
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- FUNCIONES ATÓMICAS (plpgsql). Cada llamada corre en UNA transacción: si algo
-- falla (raise), se revierte TODO. El guard de stock negativo es infalible
-- porque la verificación ocurre dentro de la misma transacción que el UPDATE,
-- que toma lock de fila → operaciones concurrentes se serializan sobre el pozo.
-- ─────────────────────────────────────────────────────────────────────────────

-- Recarga del pozo: SOLO la usa el agente/admin (el chequeo de rol está en el
-- backend, src/lib/caja.ts). Valida cantidad > 0. Devuelve el stock resultante.
create or replace function fn_recargar_fichas(
  p_tenant      uuid,
  p_cantidad    bigint,
  p_agente      uuid,
  p_agente_name text
) returns bigint
language plpgsql
as $$
declare
  v_stock bigint;
begin
  if p_cantidad is null or p_cantidad <= 0 then
    raise exception 'La cantidad a recargar debe ser mayor a 0';
  end if;

  insert into fichas_stock (tenant_id, stock_actual, updated_at)
  values (p_tenant, p_cantidad, now())
  on conflict (tenant_id)
  do update set stock_actual = fichas_stock.stock_actual + excluded.stock_actual,
                updated_at   = now()
  returning stock_actual into v_stock;

  insert into fichas_recargas (tenant_id, cantidad, agente_id, agente_name)
  values (p_tenant, p_cantidad, p_agente, p_agente_name);

  return v_stock;
end;
$$;

-- Aplica un movimiento: ajusta pozo + billetera del operador e inserta en
-- movimientos, todo atómico. Recibe los deltas ya calculados (la tabla
-- carga/pago/descarga/sueldo/traspaso vive en src/lib/caja.ts). Aborta si el
-- pozo quedaría negativo. Devuelve json con el movimiento y los saldos nuevos.
create or replace function fn_aplicar_movimiento(
  p_tenant          uuid,
  p_operador        uuid,
  p_tipo            text,
  p_monto           bigint,
  p_bono            integer,
  p_fichas_delta    bigint,
  p_billetera_delta bigint,
  p_comprobante     uuid,
  p_contraparte     uuid,
  p_creado_por      uuid,
  p_creado_por_name text
) returns json
language plpgsql
as $$
declare
  v_stock  bigint;
  v_saldo  bigint;
  v_mov_id uuid;
begin
  -- Asegurar el pozo del tenant (arranca en 0 si no existe).
  insert into fichas_stock (tenant_id, stock_actual)
  values (p_tenant, 0)
  on conflict (tenant_id) do nothing;

  -- Aplicar delta de fichas con lock de fila; el guard es infalible acá.
  update fichas_stock
     set stock_actual = stock_actual + p_fichas_delta,
         updated_at   = now()
   where tenant_id = p_tenant
   returning stock_actual into v_stock;

  if v_stock < 0 then
    raise exception 'No hay fichas suficientes';
  end if;

  -- Asegurar la billetera del operador (arranca en 0 si no existe).
  insert into operador_billetera (tenant_id, operador_id, saldo_actual)
  values (p_tenant, p_operador, 0)
  on conflict (tenant_id, operador_id) do nothing;

  -- Aplicar delta de billetera con lock de fila; mismo guard infalible que el
  -- pozo. Solo se dispara con deltas negativos (pago/descarga/sueldo/traspaso
  -- origen); carga y traspaso destino suman y nunca lo activan.
  update operador_billetera
     set saldo_actual = saldo_actual + p_billetera_delta,
         updated_at   = now()
   where tenant_id = p_tenant and operador_id = p_operador
   returning saldo_actual into v_saldo;

  if v_saldo < 0 then
    raise exception 'Saldo insuficiente en billetera';
  end if;

  insert into movimientos (
    tenant_id, operador_id, tipo, monto, bono,
    fichas_delta, billetera_delta, comprobante_id, contraparte_id,
    creado_por, creado_por_name
  ) values (
    p_tenant, p_operador, p_tipo, p_monto, p_bono,
    p_fichas_delta, p_billetera_delta, p_comprobante, p_contraparte,
    p_creado_por, p_creado_por_name
  ) returning id into v_mov_id;

  return json_build_object(
    'movimiento_id', v_mov_id,
    'stock_actual',  v_stock,
    'saldo_actual',  v_saldo
  );
end;
$$;
