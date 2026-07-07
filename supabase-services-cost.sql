-- Costo mensual por servicio (panel "Servicios & Pagos"). Idempotente.
-- Correr a mano en Supabase → SQL editor (este proyecto ejecuta la DDL manualmente).
--
-- IMPORTANTE: es un valor de carga MANUAL, editable desde el panel. NO hay
-- integración con la facturación real de Vercel/Supabase/Meta/etc.: sincronizar
-- eso requeriría integrar cada API de billing, que hoy no tenemos. El admin
-- mantiene estos números a mano.

alter table services add column if not exists monthly_cost_usd numeric(10,2);

-- Semilla de costos conocidos a julio 2026. Solo se cargan si están en null, para
-- NO pisar ediciones que el admin haya hecho después desde el panel.
update services set monthly_cost_usd = 20 where name = 'Vercel'   and monthly_cost_usd is null;  -- Vercel Pro   ~USD 20/mes
update services set monthly_cost_usd = 25 where name = 'Supabase' and monthly_cost_usd is null;  -- Supabase Pro ~USD 25/mes

-- Dominio irisonline.app, Meta WhatsApp API, Anthropic API y Groq API quedan en
-- null a propósito: son costo por uso (Meta/Anthropic/Groq) o anual/variable
-- (dominio), no un fijo mensual conocido. Se cargan desde el panel cuando se sepan.
