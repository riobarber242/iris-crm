-- ═════════════════════════════════════════════════════════════════════════════
-- IRIS — Agrega el tipo 'ajuste' al CHECK de movimientos.tipo
-- Idempotente. Correr en el SQL Editor DESPUÉS de migraciones-caja-mejoras-2.sql
-- (que ya habia ampliado el check con descarga_pendiente/descarga_rechazada).
--
-- 'ajuste' = override manual de billetera del agente (boton Editar / Reset 0 en
-- Fichas). Deja un movimiento con billetera_delta = nuevo - anterior para que el
-- saldo corriendo del detalle de billetera quede coherente.
-- ═════════════════════════════════════════════════════════════════════════════

-- Borra el check actual sobre `tipo` (cualquiera sea su nombre) y lo recrea
-- ampliado con 'ajuste'. Idempotente.
do $$
declare c text;
begin
  select conname into c
    from pg_constraint
   where conrelid = 'movimientos'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%tipo%';
  if c is not null then
    execute format('alter table movimientos drop constraint %I', c);
  end if;
end $$;

alter table movimientos add constraint movimientos_tipo_check
  check (tipo in (
    'carga','pago','descarga','sueldo','traspaso',
    'descarga_pendiente','descarga_rechazada','ajuste'
  ));
