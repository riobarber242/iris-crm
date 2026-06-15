-- ─────────────────────────────────────────────────────────────────────────────
-- IRIS — Caja de fichas (Etapa 4a: Cargas + Pagos, "enviar a verificar")
-- Correr ESTE bloque en el SQL Editor de Supabase. Es idempotente
-- (if not exists / drop-recreate index), se puede correr más de una vez.
--
-- Requiere supabase-caja-fichas.sql (Etapa 2) y supabase-caja-fichas-stage3.sql.
-- Con el flag caja_enabled APAGADO nada de esto mueve saldos; los cambios de
-- esquema (columnas) son seguros de correr cuando quieras.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. source_message_id: liga un comprobante al mensaje del chat que lo originó.
--    A partir de Etapa 4a los comprobantes NO entran solos: nacen del botón
--    "Enviar a verificar" sobre un mensaje con imagen. Esta columna permite el
--    guard anti-duplicado (un mensaje = un solo comprobante).
alter table comprobantes add column if not exists source_message_id uuid;

-- Índice único PARCIAL: solo aplica a filas con source_message_id no nulo, así
-- los comprobantes históricos/manuales (sin mensaje de origen) no chocan entre sí.
drop index if exists uq_comprobantes_source_message;
create unique index uq_comprobantes_source_message
  on comprobantes (source_message_id)
  where source_message_id is not null;

-- ── 2. pago_agente: marca el pago manual cargado por el agente/admin desde
--    afuera (premio grande pagado fuera del sistema). Al verificarlo suben las
--    fichas al pozo PERO no baja ninguna billetera de operador.
alter table comprobantes add column if not exists pago_agente boolean not null default false;

-- ── 3. contact_id nullable: el pago manual del agente no viene de una
--    conversación, así que puede no tener contacto asociado.
alter table comprobantes alter column contact_id drop not null;

-- ── 4. tipo: el constraint de supabase-caja-fichas.sql ya admite
--    ('carga','pago','descarga','traspaso'). No hace falta tocarlo acá.
--    (Si ese SQL no se corrió, correlo primero.)
