-- IRIS CRM — Índice para el listado paginado de Contactos
--
-- La pantalla Contactos (GET /api/contacts?limit=...) ordena los agendados por
-- casino_username con búsqueda + paginación por rango:
--   contacts.eq('tenant_id', X).not('casino_username', null).order('casino_username').range(...)
--
-- Sin este índice, con tenants grandes Postgres tiene que ORDENAR todas las filas
-- del tenant por casino_username en cada página (sort costoso a millones de filas).
-- Con (tenant_id, casino_username) el orden y el filtro not-null salen del índice
-- (index scan ordenado), y la búsqueda ilike igual se apoya en el prefijo por tenant.
--
-- No es necesario para tenants chicos (el sort de cientos/miles es trivial); importa
-- al escalar a decenas de miles / millones de agendados.
--
-- ⚠️ CREATE INDEX CONCURRENTLY: no bloquea escrituras, pero NO corre dentro de una
-- transacción — en el SQL Editor de Supabase, correr esta sentencia SOLA (no junto
-- a otras). Si falla a mitad deja un índice INVÁLIDO: DROP INDEX y reintentar.

create index concurrently if not exists idx_contacts_tenant_casino_username
  on contacts (tenant_id, casino_username);
