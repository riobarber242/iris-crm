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

  // Ranking agregado en Postgres (COUNT/SUM por tipo, HAVING cargas>0, JOIN contacts,
  // orden por monto de cargas). Antes se traían TODOS los comprobantes del rango sin
  // paginar (cap-1000 → el ranking subcontaba con >1000) + agregación en Node + un
  // `.in('id', ids)` (riesgo 414). Ver supabase-leads-ranking-rpc.sql.
  const { data, error } = await supabaseAdmin.rpc('fn_leads_ranking', {
    p_tenant_id: session.tenant_id,
    p_from:      from || null,
    p_to:        to   || null,
  });
  if (error) return new NextResponse(error.message, { status: 500 });

  const result = (data ?? []).map((r: any) => ({
    contact_id:      r.contact_id,
    cargas_total:    Number(r.cargas_total ?? 0),
    cargas_monto:    Number(r.cargas_monto ?? 0),
    pagos_total:     Number(r.pagos_total ?? 0),
    pagos_monto:     Number(r.pagos_monto ?? 0),
    // Alias por compatibilidad: el ranking es de cargas.
    total:           Number(r.cargas_total ?? 0),
    monto_total:     Number(r.cargas_monto ?? 0),
    phone:           r.phone ?? '—',
    casino_username: r.casino_username ?? null,
    status:          r.status ?? '—',
  }));
  return NextResponse.json(result);
}
