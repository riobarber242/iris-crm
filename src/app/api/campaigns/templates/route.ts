import { NextResponse } from 'next/server';
import { getSessionAgent } from '@/lib/current-agent';
import { supabaseAdmin } from '@/lib/db';

// Plantillas del tenant para el selector de campañas. Lee de la tabla
// whatsapp_templates (gestionada desde Configuración), filtrando por el
// tenant_id del usuario autenticado. service-role / sin RLS, como el resto.
// Devuelve { name, language, body } — la forma que consume CampanasClient.
export async function GET() {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const { data, error } = await supabaseAdmin
    .from('whatsapp_templates')
    .select('name, language, body')
    .eq('tenant_id', session.tenant_id)
    .order('created_at', { ascending: true });

  if (error) {
    return NextResponse.json({ error: `No se pudieron cargar las plantillas: ${error.message}` }, { status: 500 });
  }
  return NextResponse.json(data ?? []);
}
