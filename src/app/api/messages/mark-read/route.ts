import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { logActivity, ACTIVITY } from '@/lib/activity-log';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const contactId = body?.contactId;

  if (!contactId) {
    return new NextResponse('Falta contactId', { status: 400 });
  }

  // Sesión obligatoria: el marcado solo opera sobre mensajes del propio tenant.
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  try {
    // OJO: nunca pisar 'failed' — un mensaje que Meta rechazó no fue entregado
    // ni leído. Sin este filtro, abrir el chat convertía los fallidos en
    // "leídos" (doble tilde) y el error quedaba invisible.
    // Scope por tenant_id: un contactId de otro tenant no afecta nada.
    const { data, error } = await supabaseAdmin
      .from('messages')
      .update({ status: 'read' })
      .eq('contact_id', contactId)
      .eq('tenant_id', session.tenant_id)
      .eq('role', 'assistant')
      .neq('status', 'read')
      .neq('status', 'failed')
      .select('id');

    if (error) return new NextResponse(error.message, { status: 500 });

    const updated = data?.length ?? 0;

    // Registro de actividad: solo si realmente había mensajes nuevos sin leer
    // (el operador abrió un chat con actividad pendiente → atendió algo).
    if (updated > 0) {
      await logActivity({
        session,
        action:     ACTIVITY.CONVERSATION_ATTENDED,
        objectType: 'conversation',
        objectId:   contactId,
        details:    { messages_marked: updated },
      });
    }

    return NextResponse.json({ updated });
  } catch (err: any) {
    return new NextResponse(String(err.message ?? err), { status: 500 });
  }
}
