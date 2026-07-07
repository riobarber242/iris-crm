-- Respuestas citadas (reply-to) en mensajes entrantes de WhatsApp. Idempotente.
-- Correr a mano en Supabase → SQL editor.
--
-- Cuando un cliente responde citando un mensaje, Meta manda context.id = wamid del
-- mensaje citado. Guardamos ese wamid y un preview corto (resuelto desde nuestra
-- DB al momento de recibir) para mostrar "↩ Respondiendo a: …" en la burbuja.
-- Sin estas columnas, el mensaje igual se guarda (el insert reintenta sin ellas),
-- pero no se ve a qué mensaje respondía.
alter table messages add column if not exists reply_to_wamid   text;
alter table messages add column if not exists reply_to_preview text;
