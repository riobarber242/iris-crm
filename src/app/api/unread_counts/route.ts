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
        .from('settings').select('value').eq('key', 'offline_mode').limit(1).maybeSingle();
      offline = data?.value === 'true';
    }

    // 1. Contactos con su estado y last_read_at. Agentes: solo los asignados.
    let contactsQuery = supabaseAdmin
      .from('contacts')
      .select('id, conversation_state, last_read_at');
    if (isAgent) contactsQuery = contactsQuery.eq('assigned_agent_id', session.sub);
    const { data: contacts, error: cErr } = await contactsQuery;
    if (cErr) return new NextResponse(cErr.message, { status: 500 });

    const contactMap = new Map<string, any>((contacts ?? []).map((c: any) => [c.id, c]));

    // 2. Último mensaje por contacto — TODOS los mensajes, sin filtro de fecha.
    const { data: msgs, error: mErr } = await supabaseAdmin
      .from('messages')
      .select('contact_id, role, created_at')
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

    // 4. Comprobantes pendientes (para agentes, solo los de sus contactos).
    let comprobantesQuery = supabaseAdmin
      .from('comprobantes')
      .select('id', { count: 'exact', head: true })
      .eq('estado', 'pendiente');
    if (isAgent) {
      const ownedIds = Array.from(contactMap.keys());
      comprobantesQuery = comprobantesQuery.in('contact_id', ownedIds.length ? ownedIds : ['00000000-0000-0000-0000-000000000000']);
    }
    const { count: comprobantesPending } = await comprobantesQuery;

    return NextResponse.json({
      total:               newPending + recurringPending,
      newPending,
      recurringPending,
      comprobantesPending: comprobantesPending ?? 0,
    });
  } catch (err: any) {
    return new NextResponse(String(err?.message ?? err), { status: 500 });
  }
}
