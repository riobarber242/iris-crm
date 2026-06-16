import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { requireAdmin } from '@/lib/current-agent';
import { logActivity, ACTIVITY } from '@/lib/activity-log';

// WhatsApp del agente (Etapa 5): número internacional sin "+" (ej 5491112345678).
// Lo usa el operador para armar el link wa.me al "Descargar al agente". Solo admin
// lo lee/edita desde Configuración. Se guarda en settings key 'whatsapp_agente'.
const KEY = 'whatsapp_agente';

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Requiere rol admin' }, { status: 403 });

  const { data } = await supabaseAdmin
    .from('settings').select('value').eq('key', KEY).eq('tenant_id', admin.tenant_id).maybeSingle();
  return NextResponse.json({ whatsapp_agente: String(data?.value ?? '').trim() });
}

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Requiere rol admin' }, { status: 403 });

  const body = await request.json().catch(() => ({} as any));
  // Sanea: dejamos solo dígitos (el número se guarda sin "+" ni espacios).
  const numero = String(body.whatsapp_agente ?? '').replace(/\D/g, '');
  if (numero && (numero.length < 8 || numero.length > 15)) {
    return NextResponse.json({ error: 'El número debe tener entre 8 y 15 dígitos (formato internacional, sin +).' }, { status: 400 });
  }

  const { error } = await supabaseAdmin
    .from('settings')
    .upsert({ key: KEY, value: numero, tenant_id: admin.tenant_id }, { onConflict: 'key,tenant_id' });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logActivity({
    session: admin, action: ACTIVITY.CONFIG_CHANGED,
    objectType: 'config', objectId: KEY, details: { key: KEY, value: numero },
  });

  return NextResponse.json({ ok: true, whatsapp_agente: numero });
}
