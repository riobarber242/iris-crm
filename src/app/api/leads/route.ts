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
    .select('contact_id, monto, tipo, created_at')
    .eq('tenant_id', session.tenant_id)
    .eq('estado', 'verificado');
  if (from) q = q.gte('created_at', from);
  if (to)   q = q.lte('created_at', to);

  const { data: comprobantes, error } = await q;
  if (error) return new NextResponse(error.message, { status: 500 });
  if (!comprobantes || comprobantes.length === 0) return NextResponse.json([]);

  // Agregar por contacto, separando cargas (cliente recargó) de pagos (le pagamos).
  // Solo cuentan 'carga' y 'pago'; 'descarga'/'traspaso' (flujos de caja) se ignoran.
  type Agg = { cargasMonto: number; cargasTotal: number; pagosMonto: number; pagosTotal: number };
  const map = new Map<string, Agg>();
  for (const c of comprobantes) {
    if (c.tipo !== 'carga' && c.tipo !== 'pago') continue;
    const prev = map.get(c.contact_id) ?? { cargasMonto: 0, cargasTotal: 0, pagosMonto: 0, pagosTotal: 0 };
    const monto = Number(c.monto ?? 0);
    if (c.tipo === 'carga') { prev.cargasMonto += monto; prev.cargasTotal += 1; }
    else                    { prev.pagosMonto  += monto; prev.pagosTotal  += 1; }
    map.set(c.contact_id, prev);
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
    // Ranking de cargas: queda fuera quien no cargó en el período.
    .filter(([, agg]) => agg.cargasTotal > 0)
    .map(([id, agg]) => {
      const contact = contactMap.get(id) as any;
      return {
        contact_id:      id,
        cargas_total:    agg.cargasTotal,
        cargas_monto:    agg.cargasMonto,
        pagos_total:     agg.pagosTotal,
        pagos_monto:     agg.pagosMonto,
        // Alias por compatibilidad: el ranking es de cargas.
        total:           agg.cargasTotal,
        monto_total:     agg.cargasMonto,
        phone:           contact?.phone ?? '—',
        casino_username: contact?.casino_username ?? null,
        status:          contact?.status ?? '—',
      };
    });

  // Orden SOLO por cargas (total cargado); los pagos no influyen.
  result.sort((a, b) => b.cargas_monto - a.cargas_monto || b.cargas_total - a.cargas_total);
  return NextResponse.json(result);
}
