import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { classifyPending } from '@/lib/pending';

// Devuelve los pendientes según la regla de negocio (ver lib/pending.ts):
//   newPending       (🟠 naranja): último mensaje de un robot, sin leer.
//   recurringPending (🔴 rojo):    online + onboarding 'done', sin leer.
// Sin filtro de fecha: mira TODOS los mensajes. Solo la lectura humana limpia.
// Los agentes solo cuentan sus chats asignados; el admin, todos.
export async function GET() {
  try {
    const session = await getSessionAgent();
    if (!session) return new NextResponse('No autenticado', { status: 401 });
    const isAgent = session.role !== 'admin';

    // Modo offline global: sin offline NO hay ROJO (la regla de done→rojo aplica
    // solo cuando el CRM está operando).
    let offline = false;
    {
      const { data } = await supabaseAdmin
        .from('settings').select('value').eq('key', 'offline_mode').eq('tenant_id', session.tenant_id).limit(1).maybeSingle();
      offline = data?.value === 'true';
    }

    // 1. Contactos con su estado y last_read_at. Agentes: solo los asignados.
    let contactsQuery = supabaseAdmin
      .from('contacts')
      .select('id, conversation_state, last_read_at')
      .eq('tenant_id', session.tenant_id);
    if (isAgent) contactsQuery = contactsQuery.eq('assigned_agent_id', session.sub);
    const { data: contacts, error: cErr } = await contactsQuery;
    if (cErr) return new NextResponse(cErr.message, { status: 500 });

    const contactMap = new Map<string, any>((contacts ?? []).map((c: any) => [c.id, c]));

    // 2. Último mensaje por contacto — TODOS los mensajes, sin filtro de fecha.
    const { data: msgs, error: mErr } = await supabaseAdmin
      .from('messages')
      .select('contact_id, role, created_at')
      .eq('tenant_id', session.tenant_id)
      .order('created_at', { ascending: false });
    if (mErr) return new NextResponse(mErr.message, { status: 500 });

    const lastMsg = new Map<string, { role: string; created_at: string }>();
    for (const m of (msgs ?? [])) {
      if (!lastMsg.has(m.contact_id)) lastMsg.set(m.contact_id, { role: m.role, created_at: m.created_at });
    }

    // 3. Clasificar cada contacto.
    let newPending       = 0; // 🟠
    let recurringPending = 0; // 🔴
    for (const [cId, c] of contactMap.entries()) {
      const lm = lastMsg.get(cId);
      const level = classifyPending({
        lastRole:          lm?.role,
        lastMsgAt:         lm?.created_at,
        lastReadAt:        c.last_read_at,
        conversationState: c.conversation_state,
        offline,
      });
      if (level === 'red')         recurringPending++;
      else if (level === 'orange') newPending++;
    }

    // 4. Pendientes de la bandeja, separados por tipo (cargas / pagos). Para
    //    agentes, solo los de sus contactos. `tipoFilter`=null → no filtra por
    //    tipo (degradación si la columna `tipo` aún no existe).
    const ownedIds = Array.from(contactMap.keys());
    async function countPendientes(tipoFilter: 'carga' | 'pago' | null): Promise<number | null> {
      let q = supabaseAdmin
        .from('comprobantes')
        .select('id', { count: 'exact', head: true })
        .eq('estado', 'pendiente')
        .eq('tenant_id', session!.tenant_id);
      if (tipoFilter) q = q.eq('tipo', tipoFilter);
      if (isAgent) q = q.in('contact_id', ownedIds.length ? ownedIds : ['00000000-0000-0000-0000-000000000000']);
      const { count, error } = await q;
      if (error) return null; // columna ausente u otro error → degradar
      return count ?? 0;
    }

    let cargasPending = await countPendientes('carga');
    let pagosPending  = await countPendientes('pago');
    // Si filtrar por tipo falló (migración sin correr), contamos todo como cargas.
    if (cargasPending === null) {
      cargasPending = (await countPendientes(null)) ?? 0;
      pagosPending  = 0;
    }
    pagosPending = pagosPending ?? 0;

    return NextResponse.json({
      total:               newPending + recurringPending,
      newPending,
      recurringPending,
      // `comprobantesPending` se mantiene como alias de cargas para compat.
      comprobantesPending: cargasPending,
      cargasPending,
      pagosPending,
    });
  } catch (err: any) {
    return new NextResponse(String(err?.message ?? err), { status: 500 });
  }
}
