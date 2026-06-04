import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { sendWhatsAppTemplate } from '@/lib/meta/client';

// Campaña de reactivación de contactos inactivos.
// Envía la plantilla de WhatsApp "reactivacion_inactivos" con {{1}} = nombre del
// contacto (o teléfono si no tiene nombre), usando el Phone Number ID indicado,
// y registra el envío en la tabla campaigns.
const TEMPLATE_NAME         = 'reactivacion_inactivos';
const TEMPLATE_LANG         = 'es';
const REACTIVACION_PHONE_ID = '1135649372965076';

type InactivoContact = { id: string; phone: string; name: string | null; casino_username: string | null };

// {{1}}: nombre del contacto, o teléfono si no tiene nombre.
// (Meta rechaza variables vacías, por eso el teléfono como fallback.)
function nombreParaTemplate(c: { name: string | null; phone: string }): string {
  return (c.name ?? '').trim() || c.phone;
}

// Mapa contact_id → fecha del último comprobante.
async function lastComprobanteByContact(ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const { data } = await supabaseAdmin
    .from('comprobantes')
    .select('contact_id, created_at')
    .in('contact_id', ids)
    .order('created_at', { ascending: false });
  for (const row of data ?? []) {
    if (!map.has(row.contact_id)) map.set(row.contact_id, row.created_at); // primero = más reciente
  }
  return map;
}

// GET → lista de contactos inactivos con fecha de último comprobante.
export async function GET() {
  const { data: contacts, error } = await supabaseAdmin
    .from('contacts')
    .select('id, phone, name, casino_username')
    .eq('status', 'inactivo')
    .neq('blocked', true)
    .order('created_at', { ascending: false });

  if (error) return new NextResponse(error.message, { status: 500 });

  const list = contacts ?? [];
  const lastMap = await lastComprobanteByContact(list.map((c: any) => c.id));

  return NextResponse.json(
    list.map((c: any) => ({ ...c, last_comprobante_at: lastMap.get(c.id) ?? null })),
  );
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

  const targetIds = (contacts as InactivoContact[]).map((c) => c.id);
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

  // Registrar la campaña: fecha (created_at default), cantidad (sent_count) y
  // lista de contactos (recipient_ids). Si la columna recipient_ids no existe
  // todavía, se reintenta sin ella para no perder el registro.
  const baseRow = {
    name:              `Reactivación de inactivos — ${new Date().toISOString().slice(0, 10)}`,
    message:           `[Plantilla ${TEMPLATE_NAME}]`,
    target_filter:     'inactivo',
    status:            'completada',
    sent_count:        sent,
    type:              'template_meta',
    template_name:     TEMPLATE_NAME,
    template_language: TEMPLATE_LANG,
  };

  let campaignId: string | null = null;
  const { data: campaign, error: cErr } = await supabaseAdmin
    .from('campaigns')
    .insert({ ...baseRow, recipient_ids: targetIds })
    .select('id')
    .single();

  if (cErr) {
    console.warn('[reactivacion] Insert con recipient_ids falló, reintento sin ella:', cErr.message);
    const { data: retry, error: rErr } = await supabaseAdmin
      .from('campaigns').insert(baseRow).select('id').single();
    if (rErr) console.error('[reactivacion] No se pudo registrar la campaña:', rErr.message);
    else campaignId = retry?.id ?? null;
  } else {
    campaignId = campaign?.id ?? null;
  }

  return NextResponse.json({ ok: true, sent, failed, total: contacts.length, campaignId });
}
