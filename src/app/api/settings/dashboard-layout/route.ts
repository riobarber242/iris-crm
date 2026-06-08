import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { mergeLayout, sanitizeLayout } from '@/lib/dashboard-layout';

// Personalización del dashboard por tenant. Se guarda como JSON en
// settings.dashboard_layout (value es text → JSON.stringify/parse).
const KEY = 'dashboard_layout';

export async function GET() {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const { data } = await supabaseAdmin
    .from('settings')
    .select('value')
    .eq('key', KEY)
    .eq('tenant_id', session.tenant_id)
    .limit(1)
    .maybeSingle();

  let parsed: unknown = null;
  if (data?.value) {
    try { parsed = JSON.parse(data.value); } catch { parsed = null; }
  }

  // Siempre devolvemos los 9 widgets mergeados con los defaults.
  return NextResponse.json({ layout: mergeLayout(parsed) });
}

export async function POST(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const layout   = sanitizeLayout(body.layout);
  const value    = JSON.stringify(layout);
  const tenantId = session.tenant_id;

  await supabaseAdmin.from('settings').delete().eq('key', KEY).eq('tenant_id', tenantId);
  const { error } = await supabaseAdmin.from('settings').insert({ key: KEY, value, tenant_id: tenantId });
  if (error) {
    console.error('[dashboard-layout POST] Insert error:', error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, layout });
}
