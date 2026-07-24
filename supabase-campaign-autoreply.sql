-- Auto-enganche al click de botón de plantilla de campaña (configurable por tenant).
-- Idempotente. Correr a mano en Supabase → SQL Editor (este proyecto NO tiene la
-- RPC exec_sql; la DDL se ejecuta manualmente).
--
-- Qué guarda: por tenant, un switch on/off y una lista de mensajes automáticos por
-- POSICIÓN de botón. El índice del array = índice del botón (btn_0, btn_1, …), que
-- IRIS asigna por posición al enviar la plantilla (src/lib/meta/client.ts), NO por
-- el texto del botón. Convención en runtime: índice 0 = positivo (primer botón),
-- último índice = negativo. Si el tenant no cargó texto para una posición, se usa un
-- default razonable (positivo/negativo) — ver src/lib/campaigns/click-autoreply.ts.
--
--   messages = [
--     { "text": "…mensaje del botón positivo…", "fallback_template": "nombre_o_null" },
--     { "text": "…mensaje del botón negativo…", "fallback_template": null },
--     …una entrada por posición extra (plantillas de 3+ botones)…
--   ]
--
-- fallback_template: nombre de una plantilla YA aprobada en la WABA del tenant, que
-- se dispara SOLO si el auto-mensaje de texto libre falla por ventana cerrada
-- (error 131047). Gonzalo carga/aprueba esas plantillas por su cuenta; el sistema
-- solo las dispara si están configuradas.
--
-- enabled default FALSE: es opt-in. Ningún tenant empieza a auto-responder hasta
-- que se prende el switch en el panel de Campañas (así no cambia el comportamiento
-- de los tenants existentes en silencio).

create table if not exists campaign_click_autoreply (
  tenant_id  uuid primary key references tenants(id) on delete cascade,
  enabled    boolean not null default false,
  messages   jsonb   not null default '[]'::jsonb,
  updated_at timestamptz default now()
);

-- Por si la tabla YA existía sin estas columnas (patrón del repo: create table if
-- not exists es no-op si ya estaba con otro esquema).
alter table campaign_click_autoreply add column if not exists enabled    boolean not null default false;
alter table campaign_click_autoreply add column if not exists messages   jsonb   not null default '[]'::jsonb;
alter table campaign_click_autoreply add column if not exists updated_at timestamptz default now();


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════

-- V1. La tabla y sus columnas existen.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_name = 'campaign_click_autoreply'
order by ordinal_position;

-- V2. Config por tenant (vacío hasta que alguien la configure).
select tenant_id, enabled, jsonb_array_length(messages) as n_botones, updated_at
from campaign_click_autoreply
order by updated_at desc;
