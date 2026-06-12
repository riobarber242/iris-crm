import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { sendWhatsAppReaction } from '@/lib/meta/client';

// POST { messageId, emoji } → reacciona (vía WhatsApp Reactions API) al mensaje
// del cliente. emoji '' quita la reacción. Solo funciona sobre mensajes que
// tienen whatsapp_message_id (los entrantes del cliente).
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const messageId = body?.messageId as string | undefined;
  const emoji     = typeof body?.emoji === 'string' ? body.emoji : undefined;

  if (!messageId || emoji === undefined) {
    return new NextResponse('Faltan messageId o emoji', { status: 400 });
  }

  const { data: msg, error: mErr } = await supabaseAdmin
    .from('messages')
    .select('id, contact_id, whatsapp_message_id')
    .eq('id', messageId)
    .single();

  if (mErr || !msg) return new NextResponse('Mensaje no encontrado', { status: 404 });
  if (!msg.whatsapp_message_id) {
    return new NextResponse('El mensaje no tiene id de WhatsApp (no se puede reaccionar)', { status: 409 });
  }

  const { data: contact, error: cErr } = await supabaseAdmin
    .from('contacts').select('phone, tenant_id, whatsapp_number_id').eq('id', msg.contact_id).single();
  if (cErr || !contact?.phone) return new NextResponse('Contacto no encontrado', { status: 404 });

  try {
    await sendWhatsAppReaction(contact.phone, msg.whatsapp_message_id, emoji, contact.tenant_id, contact.whatsapp_number_id);
  } catch {
    return new NextResponse('No se pudo enviar la reacción a WhatsApp', { status: 502 });
  }

  // Persistir la reacción (best-effort: si la columna no existe, se ignora).
  try {
    const { error } = await supabaseAdmin
      .from('messages').update({ reaction: emoji || null }).eq('id', messageId);
    if (error) console.warn('[react] No se pudo guardar reaction (¿falta la columna?):', error.message);
  } catch { /* noop */ }

  return NextResponse.json({ ok: true, reaction: emoji || null });
}
