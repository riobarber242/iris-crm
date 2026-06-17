import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { generateAmountFromImage } from '@/lib/groq';
import { getSessionAgent } from '@/lib/current-agent';

export async function GET(req: NextRequest) {
  const session = await getSessionAgent();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });

  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id requerido' }, { status: 400 });

  // Solo comprobantes del propio tenant (mismo 404 para ajeno/inexistente).
  const { data: comprobante } = await supabaseAdmin
    .from('comprobantes')
    .select('image_url')
    .eq('id', id)
    .eq('tenant_id', session.tenant_id)
    .single();

  if (!comprobante?.image_url) {
    return NextResponse.json({ error: 'Comprobante sin imagen' }, { status: 404 });
  }

  try {
    const monto = await generateAmountFromImage(comprobante.image_url);
    return NextResponse.json({ monto });
  } catch (err: any) {
    const msg = err?.response?.data?.error?.message ?? err?.message ?? 'Error al analizar imagen';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
