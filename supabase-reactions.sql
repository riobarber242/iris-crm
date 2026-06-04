-- Reacciones a mensajes (idempotente). Correr en Supabase → SQL editor.
-- Guarda el emoji de reacción aplicado a un mensaje (se envía al cliente por
-- la WhatsApp Reactions API). Sin esta columna las reacciones igual se envían,
-- pero no se persisten/muestran al recargar.
alter table messages add column if not exists reaction text;
