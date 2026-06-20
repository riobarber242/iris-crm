import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import {
  AUTO_MSG_FLAG_KEY,
  AUTO_MSG_TEMPLATE_KEY,
  AUTO_MSG_DEFAULT_TEMPLATE,
  AUTO_MSG_MAX_LEN,
} from '@/lib/auto-msg';

// Configuración de la notificación automática "recarga confirmada":
//   · enabled  (flag on/off, key AUTO_MSG_FLAG_KEY).
//   · template (texto con la variable $monto, key AUTO_MSG_TEMPLATE_KEY).
// El template se renderiza al verificar una carga (ver comprobantes/route.ts).

export async function GET() {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const { data } = await supabaseAdmin
    .from('settings').select('key, value')
    .eq('tenant_id', session.tenant_id)
    .in('key', [AUTO_MSG_FLAG_KEY, AUTO_MSG_TEMPLATE_KEY]);

  const byKey = new Map((data ?? []).map((r: any) => [r.key, r.value]));
  const flag     = byKey.get(AUTO_MSG_FLAG_KEY);
  const template = byKey.get(AUTO_MSG_TEMPLATE_KEY);

  return NextResponse.json({
    enabled:  flag !== 'false',                          // default activado
    template: (template && String(template)) || AUTO_MSG_DEFAULT_TEMPLATE,
  });
}

export async function POST(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });
  // El template sale a los clientes por WhatsApp: solo staff lo edita.
  if (session.role !== 'admin' && session.role !== 'agent') {
    return new NextResponse('No autorizado', { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const tid = session.tenant_id;

  // Upsert de una key de settings (borra + inserta, como el resto del endpoint).
  async function setKey(key: string, value: string) {
    await supabaseAdmin.from('settings').delete().eq('key', key).eq('tenant_id', tid);
    await supabaseAdmin.from('settings').insert({ key, value, tenant_id: tid });
  }

  // Flag on/off (si vino).
  if (typeof body.enabled === 'boolean') {
    await setKey(AUTO_MSG_FLAG_KEY, body.enabled ? 'true' : 'false');
  }

  // Template (si vino). Validación: no vacío y dentro del tope.
  if (body.template != null) {
    const template = String(body.template).trim();
    if (!template) return new NextResponse('El mensaje no puede quedar vacío', { status: 400 });
    if (template.length > AUTO_MSG_MAX_LEN) {
      return new NextResponse(`El mensaje es demasiado largo (máx. ${AUTO_MSG_MAX_LEN})`, { status: 400 });
    }
    await setKey(AUTO_MSG_TEMPLATE_KEY, template);
  }

  return NextResponse.json({ ok: true });
}
