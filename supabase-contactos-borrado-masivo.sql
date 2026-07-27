-- Borrado masivo de contactos por categoría. Correr en Supabase → SQL editor.
-- Este proyecto NO tiene la RPC exec_sql, así que la DDL se ejecuta a mano.
--
-- Dos piezas: un índice que hace barato el ON DELETE SET NULL del tracking, y la
-- función que borra UN lote acotado (el endpoint la llama en loop con presupuesto
-- de tiempo, ver /api/contacts/bulk-delete).

-- ── 1. Índice de apoyo para el borrado ───────────────────────────────────────
-- campaign_message_status.contact_id tiene FK a contacts con ON DELETE SET NULL:
-- por CADA contacto borrado, Postgres busca sus filas hijas para anularlas. Sin
-- índice eso es un seq scan por contacto — con 56k contactos y una tabla de
-- tracking que crece con cada campaña, es la diferencia entre segundos y horas.
-- Las otras dos FK (messages, comprobantes) ya tienen su índice por contact_id.
create index if not exists idx_cms_contact on campaign_message_status (contact_id);

-- ── 2. Borrado por filtro, de a lotes ────────────────────────────────────────
-- Borra hasta p_limit contactos que matcheen el filtro y devuelve cuántos borró.
-- Un lote = una transacción CORTA: sin locks de tabla y sin el riesgo de que un
-- DELETE gigante muera por timeout y haga rollback de todo el trabajo.
--
-- El filtro es el MISMO que usa el conteo previo del cartel de confirmación, así
-- que el número que ve el operador es el que se borra:
--   · p_status null = cualquier categoría; si no, contacts.status = p_status
--   · p_search null/'' = sin búsqueda; si no, ilike sobre usuario, nombre o teléfono
--   · NO excluye a los contactos sin casino_username: el borrado alcanza también
--     a los que la pantalla nunca muestra (decisión explícita, va aclarada en el
--     cartel de confirmación).
--
-- OJO: por las FK ON DELETE CASCADE esto borra también los mensajes y comprobantes
-- de esos contactos. campaign_recipients NO tiene FK, así que sus filas quedan
-- huérfanas a propósito: son el histórico de a quién se le mandó cada campaña.
create or replace function delete_contacts_batch(
  p_tenant uuid,
  p_status text,
  p_search text,
  p_limit  int
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted bigint;
begin
  -- El tenant es obligatorio: sin él esto borraría cruzando cuentas.
  if p_tenant is null then
    raise exception 'delete_contacts_batch: p_tenant es obligatorio';
  end if;

  with objetivo as (
    select c.id
    from contacts c
    where c.tenant_id = p_tenant
      and (p_status is null or c.status = p_status)
      and (
        p_search is null or p_search = ''
        or c.casino_username ilike '%' || p_search || '%'
        or c.name            ilike '%' || p_search || '%'
        or c.phone           ilike '%' || p_search || '%'
      )
    limit greatest(1, least(coalesce(p_limit, 1000), 5000))
  ),
  borrados as (
    delete from contacts c
    using objetivo o
    where c.id = o.id
    returning c.id
  )
  select count(*) into v_deleted from borrados;

  return v_deleted;
end;
$$;

-- Solo el server (service_role) puede ejecutarla. Es SECURITY DEFINER y recibe el
-- tenant por parámetro: si quedara ejecutable por anon/authenticated, cualquiera
-- con la anon key podría vaciar los contactos de OTRA cuenta pasando su uuid.
-- El endpoint la llama con el tenant de la sesión, nunca con uno del cliente.
revoke all on function delete_contacts_batch(uuid, text, text, int) from public;
revoke all on function delete_contacts_batch(uuid, text, text, int) from anon, authenticated;
grant execute on function delete_contacts_batch(uuid, text, text, int) to service_role;
