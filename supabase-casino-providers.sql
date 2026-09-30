-- IRIS CRM — Proveedores de casino por tenant + protección contra depósitos dobles.
-- Correr a mano en Supabase → SQL Editor (este proyecto no tiene la RPC exec_sql).
-- Idempotente: se puede correr más de una vez.
-- CORRIDO en prod el 30/09/2026. Control: 1 fila de casino (17Star, provider =
-- 'celuapuestas'), 4 campos opcionales, 3 reglas nuevas, 2 columnas nuevas en
-- comprobantes y 0 comprobantes con estado.
--
-- CÓMO CORRERLO: por partes, en orden. El SQL Editor muestra solo el resultado de la
-- ÚLTIMA consulta, así que cada V (verificación) se corre seleccionándola sola y se
-- compara con lo "Esperado" antes de seguir. Una DDL manual puede quedar a medias en
-- silencio si la tabla ya tenía otro esquema (pasó antes): no dar nada por bueno sin
-- mirar la V de después.
--
-- POR QUÉ
--   Hasta ahora casino_accounts servía a un único tipo de casino (celuapuestas: login
--   de agente + token, vía el proxy). IRIS pasa a soportar varios PROVEEDORES, uno por
--   tenant, cada uno con su adaptador en src/lib/casino/providers/. La lista de
--   proveedores vive en el código (el registro), NO en la base: sumar un casino nuevo
--   es agregar un adaptador, sin migración.
--
--   · provider     → qué adaptador usa la fila. Default 'celuapuestas': la fila que ya
--                    existe (17Star) queda exactamente igual sin tocarla.
--   · config       → campos NO secretos del proveedor (jsonb). Los proveedores nuevos
--                    guardan acá; celuapuestas sigue usando sus columnas propias.
--   · secrets_enc  → secretos del proveedor (p. ej. la API key), como UN blob cifrado
--                    AES-256-GCM (lib/secure-secret, clave SECRET_ENC_KEY), igual que
--                    agent_password_enc y los tokens de WhatsApp. Nunca en texto plano.
--   · agent_username / agent_id / skin_id / skin_domain dejan de ser NOT NULL para
--     todas las filas: son campos de celuapuestas y otro proveedor no los tiene. La
--     base los sigue EXIGIENDO cuando provider = 'celuapuestas' (CHECK de la parte 2),
--     además de la validación del adaptador al guardar.
--
--   comprobantes.casino_deposit_state / casino_deposit_started_at: marca atómica de
--   "depósito en curso". El flujo de verificar reserva el comprobante con un UPDATE
--   condicional ANTES de llamar al casino: si dos pedidos llegan juntos (doble click,
--   dos operadores), solo uno gana. Estados:
--     null        → nunca se intentó, o se liberó porque el depósito seguro NO entró
--     'in_flight' → hay un depósito en curso
--     'unknown'   → no se sabe si entró (timeout, etc.): se resuelve A MANO
--     'done'      → acreditado (además de casino_deposited_at)
--   Por ahora solo lo usan los proveedores del modelo nuevo; el camino de celuapuestas
--   no lo toca (va en un trabajo separado).
--
-- SEGURO DE CORRER ANTES DEL DEPLOY: el código de hoy no lee ninguna de estas columnas
-- y la fila existente queda con provider='celuapuestas'. Conviene correrla ANTES del
-- deploy: el código nuevo no deposita con un proveedor nuevo si faltan las columnas
-- de comprobantes (fail-closed).

-- ── V0 (antes). Esquema actual — guardar el resultado para comparar. ─────────────
-- Esperado hoy: agent_username/agent_id/skin_id/skin_domain con is_nullable = NO, y
-- todavía NO están provider, config ni secrets_enc.
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public' and table_name = 'casino_accounts'
 order by ordinal_position;

-- ── V0b (antes). Filas actuales. Esperado: 1 fila (Casino 17Star, admin.celuapuestas.fans).
select id, tenant_id, label, skin_domain, active, is_default, connection_verified_at
  from public.casino_accounts;

-- ── V0c (antes). Columnas de casino en comprobantes. Esperado: casino_deposited_at y
-- casino_deposit_ref; todavía NO casino_deposit_state ni casino_deposit_started_at.
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public' and table_name = 'comprobantes' and column_name like 'casino%'
 order by column_name;


-- ═══ PARTE 1 — casino_accounts: proveedor + config + secretos ═══════════════════

alter table public.casino_accounts
  add column if not exists provider text not null default 'celuapuestas';

-- Solo el FORMATO del id (minúsculas, dígitos, guion bajo). Los valores válidos los
-- decide el registro del código: así un proveedor nuevo no necesita migración.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.casino_accounts'::regclass
       and conname = 'casino_accounts_provider_format'
  ) then
    alter table public.casino_accounts
      add constraint casino_accounts_provider_format check (provider ~ '^[a-z0-9_]{2,40}$');
  end if;
end $$;

alter table public.casino_accounts
  add column if not exists config jsonb not null default '{}'::jsonb;

alter table public.casino_accounts
  add column if not exists secrets_enc text;   -- blob cifrado "gcm$iv$tag$ct" (JSON de secretos)

-- ── V1 (después de la parte 1). Esperado: provider text NOT NULL default
-- 'celuapuestas'::text, config jsonb NOT NULL default '{}'::jsonb, secrets_enc text NULL.
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public' and table_name = 'casino_accounts'
   and column_name in ('provider', 'config', 'secrets_enc')
 order by column_name;

-- ── V1b. La fila existente. Esperado: 17Star con provider = 'celuapuestas',
-- config = {} y secrets_enc NULL (sigue usando agent_password_enc como siempre).
select id, label, provider, config, secrets_enc is not null as tiene_secrets_enc,
       agent_password_enc is not null as tiene_password
  from public.casino_accounts;


-- ═══ PARTE 2 — campos de celuapuestas: obligatorios SOLO para celuapuestas ═══════
-- Antes eran NOT NULL para todas las filas. Ahora la regla es condicional: la base
-- los sigue exigiendo cuando provider = 'celuapuestas' (misma garantía que hoy para
-- 17Star) y los deja vacíos para otros proveedores.
--
-- Orden a propósito: PRIMERO el CHECK, DESPUÉS se sacan los NOT NULL, así nunca hay
-- un instante sin la regla. El SQL Editor corre todo en una transacción: si el CHECK
-- fallara (alguna fila celuapuestas con un campo vacío — hoy no hay ninguna, eran
-- NOT NULL), se revierte la parte entera y los NOT NULL quedan como estaban.
-- Mismo criterio que el NOT NULL de antes: exige presencia (no null), no contenido.

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.casino_accounts'::regclass
       and conname = 'casino_accounts_celuapuestas_fields'
  ) then
    alter table public.casino_accounts
      add constraint casino_accounts_celuapuestas_fields
      check (
        provider <> 'celuapuestas'
        or (agent_username is not null and agent_id is not null
            and skin_id is not null and skin_domain is not null)
      );
  end if;
end $$;

-- DROP NOT NULL es idempotente (no falla si ya era nullable). No cambia ningún dato.
alter table public.casino_accounts alter column agent_username drop not null;
alter table public.casino_accounts alter column agent_id       drop not null;
alter table public.casino_accounts alter column skin_id        drop not null;
alter table public.casino_accounts alter column skin_domain    drop not null;

-- ── V2. Esperado: las cuatro con is_nullable = YES (la exigencia pasó al CHECK).
select column_name, is_nullable
  from information_schema.columns
 where table_schema = 'public' and table_name = 'casino_accounts'
   and column_name in ('agent_username', 'agent_id', 'skin_id', 'skin_domain')
 order by column_name;

-- ── V2b. El CHECK existe. Esperado: 1 fila con la definición de arriba.
select conname, pg_get_constraintdef(oid) as definicion
  from pg_constraint
 where conrelid = 'public.casino_accounts'::regclass
   and conname = 'casino_accounts_celuapuestas_fields';

-- ── V2c (opcional, prueba del CHECK sin dejar rastro). Debe FALLAR con
-- "violates check constraint casino_accounts_celuapuestas_fields". Va dentro de una
-- transacción con rollback: aunque no fallara, no queda nada escrito.
--   begin;
--   insert into public.casino_accounts (tenant_id, provider, agent_username)
--     values ((select id from public.tenants limit 1), 'celuapuestas', null);
--   rollback;


-- ═══ PARTE 3 — comprobantes: marca atómica del depósito ══════════════════════════

alter table public.comprobantes
  add column if not exists casino_deposit_state text;

alter table public.comprobantes
  add column if not exists casino_deposit_started_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.comprobantes'::regclass
       and conname = 'comprobantes_casino_deposit_state_check'
  ) then
    alter table public.comprobantes
      add constraint comprobantes_casino_deposit_state_check
      check (casino_deposit_state is null or casino_deposit_state in ('in_flight', 'unknown', 'done'));
  end if;
end $$;

-- ── V3. Esperado: casino_deposit_state text NULL y casino_deposit_started_at
-- timestamp with time zone NULL (además de las dos que ya estaban).
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public' and table_name = 'comprobantes' and column_name like 'casino%'
 order by column_name;

-- ── V3b. Constraints nuevas. Esperado: 3 filas (provider_format,
-- celuapuestas_fields y deposit_state_check).
select conrelid::regclass as tabla, conname, pg_get_constraintdef(oid) as definicion
  from pg_constraint
 where conname in ('casino_accounts_provider_format', 'casino_accounts_celuapuestas_fields',
                   'comprobantes_casino_deposit_state_check');

-- ── V3c. Ningún comprobante quedó con estado. Esperado: 0.
select count(*) as con_estado from public.comprobantes where casino_deposit_state is not null;
