-- IRIS CRM — Casino multi-tenant (Etapa 2, PR 1). Correr a mano en Supabase → SQL
-- Editor (este proyecto ejecuta la DDL manualmente; no hay una RPC exec_sql
-- confiable).
--
-- Una fila = una conexión de casino de un tenant, con las credenciales atómicas
-- (mismo espíritu que whatsapp_numbers: token+IDs del MISMO origen, nunca
-- mezclados). Reemplaza el modelo mono-cuenta que hoy vive en env vars globales
-- (gonza0106 / CeluApuestas) y que el client lee sin distinguir tenant.
--
-- El SEED de la fila de 17Star NO va en este archivo: el password del agente se
-- cifra por código con SECRET_ENC_KEY (lib/secure-secret) y ese secreto vive solo
-- en la env de Vercel. Se siembra con el endpoint admin, idempotente:
--   POST /api/admin/casino/migrate-global
--
-- Nada lo lee todavía (el client migra en el PR 2): crear esta tabla no cambia el
-- comportamiento en prod.

create table if not exists casino_accounts (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid references tenants(id) on delete cascade not null,
  label                  text,                    -- nombre visible ("Casino 17Star")
  agent_username         text not null,           -- usuario del agente (login del casino)
  agent_id               text not null,           -- ID del agente (DoDeposit / GetAgentBalance)
  skin_id                text not null,           -- skin del casino (lo exige AddPlayer)
  skin_domain            text not null,           -- dominio admin/API (destino del proxy)
  api_base_url           text,                    -- URL del panel/API (informativo + UI)
  player_url             text,                    -- {link1} del mensaje de credenciales al jugador
  player_url_2           text,                    -- {link2} opcional
  credentials_template   text,                    -- template del mensaje (null = usa el default)
  agent_password_enc     text,                    -- password/token CIFRADO (AES-256-GCM, secure-secret)
  connection_verified_at timestamptz,             -- último "probar conexión" OK (null = sin verificar)
  active                 boolean default true,
  is_default             boolean default false,   -- conexión por defecto del tenant
  created_at             timestamptz default now()
);

create index if not exists idx_casino_accounts_tenant on casino_accounts(tenant_id);

-- A lo sumo UNA conexión default por tenant (índice único parcial, igual que
-- whatsapp_numbers).
create unique index if not exists idx_casino_accounts_default
  on casino_accounts(tenant_id) where is_default;
