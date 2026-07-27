import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { logActivity } from '@/lib/activity-log';

// Borrado masivo de contactos POR FILTRO (categoría + búsqueda), no por lista de
// ids. Con 56k contactos en una categoría, mandar los ids desde el navegador es
// inviable: habría que paginar 567 veces solo para juntarlos.
//
// GET  → { count } exacto del filtro, para el cartel de confirmación.
// POST → borra de a lotes hasta agotar el filtro o gastar el presupuesto de
//        tiempo; devuelve { deleted, remaining, done } y el cliente reanuda.

// Mismas categorías que acepta el resto del endpoint de contactos.
const ALLOWED_STATUS = ['nuevo', 'cliente_activo', 'inactivo', 'en_proceso', 'bloqueado'];

// Filas por lote. Cada lote es UNA transacción corta (la RPC hace el DELETE con
// LIMIT): sin locks de tabla y sin el riesgo de que un DELETE gigante muera por
// timeout y haga rollback de todo el trabajo.
const BATCH = 2000;
const MIN_BATCH = 100;   // piso al partir el lote tras un timeout de statement

// Presupuesto por request. Vercel corta la función bastante después; cerramos
// antes para responder con el progreso y que el cliente vuelva a llamar. Lo ya
// borrado quedó borrado: el avance es monótono y reanudar es seguro.
const TIME_BUDGET_MS = 45_000;

// Borrar contactos de a miles es una acción destructiva y sin vuelta atrás: la
// habilitamos para admin y agente (el dueño del panel de cada cliente), no para
// operadores. Mismo criterio que pago-manual, fichas y los crons manuales. El
// borrado individual (DELETE /api/contacts) NO cambia: sigue sin restricción.
function puedeBorrarMasivo(session: { role?: string } | null): boolean {
  return !!session && (session.role === 'admin' || session.role === 'agent');
}

// Filtro compartido por el conteo y el borrado. Que salgan de la MISMA función es
// el punto: el número del cartel tiene que ser el que se borra.
//
// Incluye a los contactos SIN casino_username, que la pantalla nunca muestra
// (decisión explícita: se borra el total real de la categoría, no solo lo
// visible). El cartel de confirmación lo aclara.
function parseFilter(url: URL) {
  const categoryParam = url.searchParams.get('category');
  const category = categoryParam && ALLOWED_STATUS.includes(categoryParam) ? categoryParam : null;
  // Mismo saneo que la búsqueda del listado: se sacan los chars estructurales del
  // .or() de PostgREST y los wildcards.
  const search = (url.searchParams.get('q') ?? '').replace(/[,()*%]/g, ' ').trim().slice(0, 60);
  return { category, search };
}

// Aplica el filtro a una query de PostgREST (para el conteo).
function applyFilter(q: any, tenantId: string, category: string | null, search: string) {
  let out = q.eq('tenant_id', tenantId);
  if (category) out = out.eq('status', category);
  if (search) out = out.or(`casino_username.ilike.*${search}*,name.ilike.*${search}*,phone.ilike.*${search}*`);
  return out;
}

async function contarFiltro(tenantId: string, category: string | null, search: string) {
  return applyFilter(
    supabaseAdmin.from('contacts').select('*', { count: 'exact', head: true }),
    tenantId, category, search,
  );
}

export async function GET(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });
  if (!puedeBorrarMasivo(session)) return new NextResponse('Requiere rol admin o agente', { status: 403 });

  const { category, search } = parseFilter(new URL(request.url));
  const { count, error } = await contarFiltro(session.tenant_id, category, search);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ count: count ?? 0 });
}

export async function POST(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });
  if (!puedeBorrarMasivo(session)) return new NextResponse('Requiere rol admin o agente', { status: 403 });

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'JSON inválido en el body' }, { status: 400 });

  // El filtro viaja en el body pero se parsea con la MISMA función que el GET.
  const fakeUrl = new URL('http://x/?' + new URLSearchParams({
    category: String(body.category ?? ''),
    q:        String(body.q ?? ''),
  }));
  const { category, search } = parseFilter(fakeUrl);

  // Sin categoría ni búsqueda esto vaciaría la cuenta entera de un click. Ese no
  // es un caso de uso: para borrar todo hay que elegir una categoría (o buscar).
  if (!category && !search) {
    return NextResponse.json(
      { error: 'Elegí una categoría (o una búsqueda) antes de borrar en masa.' },
      { status: 400 },
    );
  }

  const started = Date.now();
  let deleted = 0;
  let batch = BATCH;
  let done = false;

  while (Date.now() - started < TIME_BUDGET_MS) {
    const { data, error } = await supabaseAdmin.rpc('delete_contacts_batch', {
      p_tenant: session.tenant_id,   // de la sesión, NUNCA del cliente
      p_status: category,
      p_search: search || null,
      p_limit:  batch,
    });

    if (error) {
      // 57014 = statement_timeout. Con un lote más chico suele pasar; recién si
      // ya estamos en el piso damos el error por bueno.
      if (error.code === '57014' && batch > MIN_BATCH) {
        batch = Math.max(MIN_BATCH, Math.floor(batch / 2));
        continue;
      }
      console.error('[contacts bulk-delete] fallo el lote', {
        code: error.code, message: error.message, details: error.details,
        batch, deleted, tenant_id: session.tenant_id, category, search,
      });
      return NextResponse.json({ error: error.message, deleted }, { status: 500 });
    }

    const n = Number(data ?? 0);
    deleted += n;
    // Menos de lo pedido = no quedaba nada más que matchee: terminamos.
    if (n < batch) { done = true; break; }
  }

  // Lo que queda para la próxima tanda (0 si terminó). Se cuenta con el mismo
  // filtro, así el cliente muestra progreso real y no una estimación.
  const { count: remaining } = await contarFiltro(session.tenant_id, category, search);

  // El log guarda el FILTRO y el total, no los ids: con 56k contactos, la lista
  // de ids serían megabytes de JSON por evento.
  if (deleted > 0) {
    await logActivity({
      session,
      action:     'contact_deleted',
      objectType: 'contact',
      objectId:   null,
      details:    { bulk: true, by_filter: true, category, search: search || null, count: deleted },
    });
  }

  return NextResponse.json({
    deleted,
    remaining: remaining ?? 0,
    done: done || (remaining ?? 0) === 0,
  });
}
