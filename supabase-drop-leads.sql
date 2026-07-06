-- IRIS CRM — Borrar la tabla `leads` (código muerto)
--
-- `leads` (id, contact_id, score, reason, qualified_at) era de un diseño viejo de
-- calificación de leads que quedó sin uso: 0 filas, ningún código la lee/escribe/
-- suscribe, ningún trigger la toca, y "Top Clientes" (/api/leads) calcula todo desde
-- comprobantes. La suscripción Realtime muerta ya se removió (commit 0588ddc).
--
-- DROP sin CASCADE a propósito: si algo dependiera de la tabla (un FK entrante, una
-- vista), queremos que ERRORE y lo veamos, no que se borre en silencio. La FK propia
-- leads.contact_id → contacts, su policy de RLS y su membresía en la publicación
-- supabase_realtime se van solas con la tabla (no bloquean el DROP).
--
-- Nota: `supabase-enable-rls.sql` (ya aplicado) menciona `leads`; no hay que re-correrlo.

drop table if exists public.leads;
