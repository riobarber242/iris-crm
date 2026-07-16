-- Permitir role='system' en messages (chips de evento en el hilo, p.ej. click de
-- botón de campaña → "✅ Apretó: …"). Correr a mano en Supabase → SQL editor
-- (este proyecto ejecuta la DDL manualmente; no hay auto-migración).
--
-- BUG que corrige: messages tiene un CHECK (messages_role_check) que limita role a
-- ('user','assistant','human'). El commit edadbfd agregó insertMessage({role:'system'})
-- para el chip del click, pero nunca migró el constraint → Postgres rechaza el insert
-- (23514) y el webhook lo traga en un console.warn. Resultado: el contador agregado
-- (btn1_count/btn2_count) sube, pero el chip nunca entra en la conversación. Verificado
-- en prod 2026-07-16: "new row for relation messages violates check constraint
-- messages_role_check".
--
-- Roles válidos usados por la app:
--   user      → mensaje entrante del cliente
--   assistant → respuesta del bot
--   human     → mensaje del operador
--   system    → evento de sistema dentro del hilo (NO es burbuja; p.ej. chip de campaña)
--
-- Drop + add: idempotente si se vuelve a correr (drop if exists antes del add).

alter table messages drop constraint if exists messages_role_check;
alter table messages add constraint messages_role_check
  check (role in ('user', 'assistant', 'human', 'system'));
