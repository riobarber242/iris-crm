import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { sendWhatsAppTemplate } from '@/lib/meta/client';
import { getTemplate, previewTemplate } from '@/lib/meta/templates';

// Envía una plantilla de WhatsApp a un contacto desde el chat (fallback de la
// ventana de 24h). Body: { contactId, templateName }. {{1}} = nombre del contacto.
export async function POST(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const body         = await request.json().catch(() => null);
  const contactId    = body?.contactId as string | undefined;
  const templateName = body?.templateName as string | undefined;
  if (!contactId || !templateName) {
    return new NextResponse('Faltan contactId o templateName', { status: 400 });
  }

  const def = getTemplate(templateName);
  if (!def) return new NextResponse('Plantilla no encontrada', { status: 404 });

  // Acceso por tenant (igual que el resto de /api/messages).
  const { data: contact } = await supabaseAdmin
    .from('contacts')
    .select('id, phone, name, casino_username')
    .eq('id', contactId)
    .eq('tenant_id', session.tenant_id)
    .maybeSingle();
  if (!contact) return new NextResponse('Sin acceso a este contacto', { status: 403 });

  const nombre = (contact.name ?? '').trim() || (contact.casino_username ?? '').trim() || contact.phone;
  const vars   = def.variables.map((v) => (v === 'nombre' ? nombre : ''));

  let failureReason: string | null = null;
  try {
    await sendWhatsAppTemplate(contact.phone, def.name, def.language, vars, def.phoneId, session.tenant_id);
  } catch (err: any) {
    failureReason =
      err?.response?.data?.error?.message ||
      err?.message ||
      'WhatsApp rechazó la plantilla';
    console.error('[messages/template] Falló envío de plantilla:', failureReason);
  }

  // Guardamos en el chat el texto real enviado (placeholder ya resuelto).
  const { data: inserted, error } = await supabaseAdmin.from('messages').insert({
    contact_id: contactId,
    role:       'human',
    content:    previewTemplate(def, nombre),
    agent_id:   session.sub,
    agent_name: session.name,
    tenant_id:  session.tenant_id,
    status:     failureReason ? 'failed' : 'sent',
  }).select('*').single();

  if (error) return new NextResponse(error.message, { status: 500 });

  return NextResponse.json(failureReason ? { ...inserted, error: failureReason } : inserted);
}
