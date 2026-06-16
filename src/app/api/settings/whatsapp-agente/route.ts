import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { requireAgentOrAdmin } from '@/lib/current-agent';
import { logActivity, ACTIVITY } from '@/lib/activity-log';

// WhatsApp del agente (Etapa 5): número internacional sin "+" (ej 5491112345678).
// Lo usa el operador para armar el link wa.me al "Descargar al agente". Admin y
// agent lo leen/editan desde Configuración, siempre scopeado a SU propio tenant
// (cada uno solo toca el whatsapp_agente de su tenant_id). El operador no entra.
// Se guarda en settings key 'whatsapp_agente'.
const KEY = 'whatsapp_agente';

export async function GET() {
  const session = await requireAgentOrAdmin();
  if (!session) return NextResponse.json({ error: 'No autorizado' }, { status: 403 });

  const { data } = await supabaseAdmin
    .from('settings').select('value').eq('key', KEY).eq('tenant_id', session.tenant_id).maybeSingle();
  return NextResponse.json({ whatsapp_agente: String(data?.value ?? '').trim() });
}

export async function POST(request: Request) {
  const session = await requireAgentOrAdmin();
  if (!session) return NextResponse.json({ error: 'No autorizado' }, { status: 403 });

  const body = await request.json().catch(() => ({} as any));
  // Sanea: dejamos solo dígitos (el número se guarda sin "+" ni espacios).
  const numero = String(body.whatsapp_agente ?? '').replace(/\D/g, '');
  if (numero && (numero.length < 8 || numero.length > 15)) {
    return NextResponse.json({ error: 'El número debe tener entre 8 y 15 dígitos (formato internacional, sin +).' }, { status: 400 });
  }

  // Scope al tenant del que llama: admin y agent solo escriben en su propio tenant.
  const { error } = await supabaseAdmin
    .from('settings')
    .upsert({ key: KEY, value: numero, tenant_id: session.tenant_id }, { onConflict: 'key,tenant_id' });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logActivity({
    session, action: ACTIVITY.CONFIG_CHANGED,
    objectType: 'config', objectId: KEY, details: { key: KEY, value: numero },
  });

  return NextResponse.json({ ok: true, whatsapp_agente: numero });
}
