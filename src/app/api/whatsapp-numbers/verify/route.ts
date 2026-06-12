import { NextResponse } from 'next/server';
import axios from 'axios';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';

// Verifica un número contra la Graph API de Meta:
// GET /{phone_number_id}?fields=display_phone_number con el token del número
// (o el global de env si la fila no tiene token propio). Solo rol admin.
export async function POST(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });
  if (session.role !== 'admin') return new NextResponse('Requiere rol admin', { status: 403 });

  const body = await request.json().catch(() => null);
  const id = body?.id as string | undefined;
  if (!id) return new NextResponse('Falta id', { status: 400 });

  const { data: num } = await supabaseAdmin
    .from('whatsapp_numbers')
    .select('phone_number_id, access_token')
    .eq('id', id)
    .eq('tenant_id', session.tenant_id)
    .maybeSingle();
  if (!num) return new NextResponse('Número no encontrado', { status: 404 });

  const token = num.access_token || process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) {
    return NextResponse.json({ ok: false, error: 'Sin access token (ni propio ni global en env)' });
  }

  try {
    const res = await axios.get(`https://graph.facebook.com/v18.0/${num.phone_number_id}`, {
      headers: { Authorization: `Bearer ${token}` },
      params:  { fields: 'display_phone_number' },
      timeout: 10000,
    });
    return NextResponse.json({ ok: true, display_phone_number: res.data?.display_phone_number ?? null });
  } catch (err: any) {
    const error = err?.response?.data?.error?.message ?? err?.message ?? 'Error desconocido';
    return NextResponse.json({ ok: false, error });
  }
}
