import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';

// Ranking de Top Clientes por monto de recargas verificadas, filtrable por
// rango de fechas (sobre comprobantes.created_at). Scope por tenant.
export async function GET(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });
  // Top Clientes: el operador solo con el flag habilitado (admin/agente siempre).
  if (session.role === 'operator' && !session.can_see_top_clients) {
    return new NextResponse('No autorizado', { status: 403 });
  }

  const url  = new URL(request.url);
  const from = url.searchParams.get('from'); // ISO, inclusive
  const to   = url.searchParams.get('to');   // ISO, inclusive

  let q = supabaseAdmin
    .from('comprobantes')
    .select('contact_id, monto, created_at')
    .eq('tenant_id', session.tenant_id)
    .eq('estado', 'verificado');
  if (from) q = q.gte('created_at', from);
  if (to)   q = q.lte('created_at', to);

  const { data: comprobantes, error } = await q;
  if (error) return new NextResponse(error.message, { status: 500 });
  if (!comprobantes || comprobantes.length === 0) return NextResponse.json([]);

  // Agregar por contacto.
  const map = new Map<string, { total: number; monto: number }>();
  for (const c of comprobantes) {
    const prev = map.get(c.contact_id) ?? { total: 0, monto: 0 };
    map.set(c.contact_id, {
      total: prev.total + 1,
      monto: prev.monto + Number(c.monto ?? 0),
    });
  }

  const ids = Array.from(map.keys());
  const { data: contacts } = await supabaseAdmin
    .from('contacts')
    .select('id, phone, casino_username, status')
    .in('id', ids)
    .eq('tenant_id', session.tenant_id);
  const contactMap = new Map((contacts ?? []).map((c: any) => [c.id, c]));

  const result = Array.from(map.entries())
    // Solo contactos del tenant (descarta ids que no matchearon).
    .filter(([id]) => contactMap.has(id))
    .map(([id, agg]) => {
      const contact = contactMap.get(id) as any;
      return {
        contact_id:      id,
        total:           agg.total,
        monto_total:     agg.monto,
        phone:           contact?.phone ?? '—',
        casino_username: contact?.casino_username ?? null,
        status:          contact?.status ?? '—',
      };
    });

  result.sort((a, b) => b.monto_total - a.monto_total);
  return NextResponse.json(result);
}
