-- Corrige el ORDEN de los triggers de contacts. Correr en Supabase → SQL editor.
-- Este proyecto NO tiene la RPC exec_sql, así que la DDL se ejecuta a mano.
--
-- EL PROBLEMA. Sobre contacts hay dos triggers BEFORE que se pisan:
--   · trg_sync_casino_username      (supabase-sync-username.sql) — si el contacto
--     tiene name y no tiene casino_username, COPIA el name al usuario.
--   · trg_contacts_sync_en_proceso  (supabase-en-proceso-por-usuario.sql) — sin
--     usuario ⇒ status 'en_proceso'.
--
-- Postgres dispara los BEFORE del mismo evento en orden ALFABÉTICO por nombre de
-- trigger, y "trg_c…" va antes que "trg_s…". O sea que el de en_proceso miraba el
-- usuario ANTES de que el otro lo completara: en un alta con name y sin usuario,
-- lo marcaba 'en_proceso' y recién después el sync le ponía el usuario. Quedaba
-- un contacto CON usuario y en 'en_proceso' — un estado que no puede existir.
--
-- Verificado en la base el 27/07: alta con name='PRUEBA' y sin usuario terminaba
-- con casino_username='PRUEBA' y status='en_proceso'.
--
-- LA CORRECCIÓN. Renombrar el trigger para que corra ÚLTIMO ('trg_zz_…') y así
-- decida sobre el usuario ya definitivo. La función no cambia.
--
-- No afecta a los 103 contactos ya migrados (no tienen name ni usuario, así que
-- el sync no les hace nada): esto es para las altas y ediciones de acá en más.

drop trigger if exists trg_contacts_sync_en_proceso on contacts;

create trigger trg_zz_contacts_sync_en_proceso
  before insert or update of casino_username, status on contacts
  for each row execute function contacts_sync_en_proceso();

-- ── Verificación ─────────────────────────────────────────────────────────────
-- V1. Los dos triggers, en el orden real de ejecución (alfabético). El de
--     en_proceso tiene que quedar DESPUÉS del de sync.
select tgname, tgenabled
from pg_trigger
where tgrelid = 'public.contacts'::regclass and not tgisinternal
order by tgname;

-- V2. Ningún contacto CON usuario puede quedar en 'en_proceso' (0 filas).
select id, casino_username, status
from contacts
where status = 'en_proceso'
  and coalesce(trim(casino_username), '') <> '';
