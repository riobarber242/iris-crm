-- IRIS CRM — Cache persistente del token del casino. Correr a mano en Supabase →
-- SQL Editor (este proyecto ejecuta la DDL manualmente; no hay una RPC exec_sql
-- confiable).
--
-- POR QUÉ: hasta ahora el token vivía SOLO en un Map de módulo, o sea por instancia
-- de función serverless. Cada cold start y cada instancia nueva arrancaba con el
-- cache vacío y volvía a pedir token. Medición del 21/08/2026 en prod: 47
-- Authenticate en 30 minutos (~94/hora, ~2.250/día), el 100% disparados por el
-- polling del chip de saldo — mientras el token que devuelve el casino dice durar
-- 3600s (1 hora). Con esta tabla el mismo tráfico necesita ~24 logins por día.
--
-- Importa además porque el Authenticate del casino está bloqueado por geografía
-- desde nuestras IPs de salida (ver el commit del diagnóstico de colo/país): cuanto
-- menos dependamos de ese endpoint, menos superficie expuesta a esa regla.
--
-- UNA FILA POR CONEXIÓN DE CASINO. Tabla aparte de casino_accounts a propósito:
-- separa el secreto rotativo (se reescribe seguido) de la config estable (se lee
-- seguido), y deja poner RLS deny-all sin tocar la fila que la UI ya lee.
--
-- El token se guarda CIFRADO con AES-256-GCM (lib/secure-secret, misma clave
-- SECRET_ENC_KEY que agent_password_enc): es un bearer token, un dump de la base no
-- debe alcanzar para operar contra el casino.
--
-- SEGURO DE CORRER ANTES DEL DEPLOY: el código tolera que la tabla no exista todavía
-- (cae a cache en memoria y avisa una vez por instancia), así que el orden entre esta
-- migración y el deploy no importa.

create table if not exists casino_sessions (
  account_id       uuid primary key references casino_accounts(id) on delete cascade,
  tenant_id        uuid references tenants(id) on delete cascade not null,
  access_token_enc text        not null,          -- token CIFRADO (gcm$iv$tag$ct)
  expires_at       timestamptz not null,          -- ya con el margen de seguridad aplicado
  obtained_at      timestamptz not null default now(),
  last_401_at      timestamptz                    -- último rechazo (diagnóstico)
);

create index if not exists idx_casino_sessions_tenant on casino_sessions(tenant_id);

-- RLS deny-all: sin policies, ni anon ni authenticated ven una fila. Sólo el
-- service_role (el backend) entra. Es un token de acceso al casino: no tiene por qué
-- ser legible desde el cliente ni siquiera para el propio tenant.
alter table casino_sessions enable row level security;

-- ── Verificación ─────────────────────────────────────────────────────────────
-- Correr DESPUÉS y mirar el resultado: una DDL manual puede quedar a medias en
-- silencio si la tabla ya existía con otro esquema.
--
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_name = 'casino_sessions'
--    order by ordinal_position;
--
-- Esperado: account_id/tenant_id uuid NOT NULL, access_token_enc text NOT NULL,
-- expires_at timestamptz NOT NULL, obtained_at timestamptz NOT NULL, last_401_at
-- timestamptz NULL.
--
--   select relrowsecurity from pg_class where relname = 'casino_sessions';
--
-- Esperado: true.
