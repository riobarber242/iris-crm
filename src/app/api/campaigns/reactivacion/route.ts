import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { sendWhatsAppTemplate } from '@/lib/meta/client';

// Campaña de reactivación de contactos inactivos.
// Envía la plantilla de WhatsApp "reactivacion_inactivos" con {{1}} = nombre del
// contacto, usando el Phone Number ID indicado, y registra el envío en campaigns.
const TEMPLATE_NAME       = 'reactivacion_inactivos';
const TEMPLATE_LANG       = 'es';
const REACTIVACION_PHONE_ID = '1135649372965076';

type InactivoContact = { id: string; phone: string; name: string | null; casino_username: string | null };

// Nombre para {{1}} — Meta rechaza variables vacías, así que siempre hay fallback.
function nombreParaTemplate(c: InactivoContact): string {
  return (c.name ?? '').trim() || (c.casino_username ?? '').trim() || 'amigo';
}

// GET → lista de contactos inactivos (para mostrar/seleccionar en la UI).
export async function GET() {
  const { data, error } = await supabaseAdmin
    .from('contacts')
    .select('id, phone, name, casino_username')
    .eq('status', 'inactivo')
    .neq('blocked', true)
    .order('created_at', { ascending: false });

  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json(data ?? []);
}

// POST → envía la campaña a todos los inactivos (o a los contactIds seleccionados).
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const contactIds: string[] | undefined = Array.isArray(body?.contactIds) ? body.contactIds : undefined;

  let query = supabaseAdmin
    .from('contacts')
    .select('id, phone, name, casino_username')
    .eq('status', 'inactivo')
    .neq('blocked', true);

  if (contactIds && contactIds.length > 0) query = query.in('id', contactIds);

  const { data: contacts, error } = await query;
  if (error) return new NextResponse(error.message, { status: 500 });
  if (!contacts || contacts.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, failed: 0, total: 0, campaignId: null });
  }

  let sent = 0;
  let failed = 0;

  for (const c of contacts as InactivoContact[]) {
    const nombre = nombreParaTemplate(c);
    try {
      await sendWhatsAppTemplate(c.phone, TEMPLATE_NAME, TEMPLATE_LANG, [nombre], REACTIVACION_PHONE_ID);
      await supabaseAdmin.from('messages').insert({
        contact_id: c.id,
        role:       'human',
        content:    `[Campaña reactivación] plantilla ${TEMPLATE_NAME} ({{1}}=${nombre})`,
      });
      sent++;
    } catch {
      failed++;
      console.error(`[reactivacion] Falló envío a ${c.phone}`);
    }
    // Pequeño respiro para no saturar la API de WhatsApp.
    await new Promise((r) => setTimeout(r, 150));
  }

  // Registrar la campaña enviada (fecha = created_at default, cantidad = sent_count).
  const { data: campaign, error: cErr } = await supabaseAdmin
    .from('campaigns')
    .insert({
      name:               `Reactivación de inactivos — ${new Date().toISOString().slice(0, 10)}`,
      message:            `[Plantilla ${TEMPLATE_NAME}]`,
      target_filter:      'inactivo',
      status:             'completada',
      sent_count:         sent,
      type:               'template_meta',
      template_name:      TEMPLATE_NAME,
      template_language:  TEMPLATE_LANG,
    })
    .select('id')
    .single();

  if (cErr) console.error('[reactivacion] No se pudo registrar la campaña:', cErr.message);

  return NextResponse.json({
    ok: true,
    sent,
    failed,
    total: contacts.length,
    campaignId: campaign?.id ?? null,
  });
}
