-- Realtime para la bandeja de Cargas/Pagos.
--
-- El componente ComprobantesClient se suscribe a postgres_changes sobre la tabla
-- `comprobantes`, pero la tabla nunca se había agregado a la publicación
-- `supabase_realtime`, así que los eventos (INSERT de una carga nueva desde el
-- chat) nunca llegaban y la bandeja sólo se actualizaba por el polling de 10 s.
--
-- Calcado de la migración de internal_messages (supabase-internal-chat.sql).
-- Envuelto en DO porque "alter publication ... add table" falla si la tabla ya
-- está en la publicación (idempotente al re-correr).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and tablename = 'comprobantes'
  ) then
    alter publication supabase_realtime add table comprobantes;
  end if;
end $$;

-- Verificación (opcional):
-- select tablename from pg_publication_tables
--  where pubname = 'supabase_realtime' and tablename = 'comprobantes';
