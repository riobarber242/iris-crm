import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { isCajaEnabled } from '@/lib/caja';

// ─────────────────────────────────────────────────────────────────────────────
// Panel de caja del OPERADOR (Etapa 4b) — SOLO LECTURA.
//
// A diferencia de /api/fichas (requireStaff, ve a TODOS los operadores), este
// endpoint está scopeado SIEMPRE al operador logueado (session.sub) y su tenant.
// No expone billeteras ni movimientos de otros operadores, y NO tiene ninguna
// acción de escritura: cualquier mutación de caja sigue pasando por /api/fichas,
// que devuelve 403 al operador. Acá la defensa es estructural (no hay POST).
//
// Vistas (?view=):
//   (default)      resumen: mi billetera, pozo, mis movs de hoy, pendientes.
//   billetera      mis movimientos de billetera (billetera_delta<>0), asc, con
//                  saldo corriendo.
//   pozo           últimos N movimientos del pozo (fichas_delta<>0) SIN atribuir
//                  a ningún operador (solo tipo/delta/fecha): el pozo es comunal.
//   hoy            mis movimientos de HOY (zona America/Argentina/Buenos_Aires).
//   pendientes     comprobantes pendientes del tenant (cola global).
//   comprobante&id reproduce un comprobante del tenant en modo lectura.
// ─────────────────────────────────────────────────────────────────────────────

const POZO_LIMIT = 30;

// Detecta tablas de caja ausentes (migración Etapa 2 sin correr) para degradar
// en vez de romper la UI del operador. Espeja el helper de /api/fichas.
function isMissingCajaTable(err: any): boolean {
  if (!err) return false;
  const code = String(err.code ?? '');
  const msg  = String(err.message ?? '');
  if (code === '42P01' || code === 'PGRST205' || code === 'PGRST204') return true;
  return /fichas_stock|operador_billetera|movimientos|schema cache|does not exist|could not find/i.test(msg);
}

// Rango UTC que corresponde a "hoy" en America/Argentina/Buenos_Aires.
// Argentina es UTC-3 fijo (sin horario de verano), así que el día local 00:00
// equivale a las 03:00 UTC de esa misma fecha. created_at se guarda en UTC.
function rangoHoyArgentina(): { startISO: string; endISO: string } {
  const AR_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC-3
  const now = new Date();
  // Corremos -3h y leemos las partes UTC → fecha del calendario argentino.
  const ar = new Date(now.getTime() - AR_OFFSET_MS);
  const start = new Date(Date.UTC(ar.getUTCFullYear(), ar.getUTCMonth(), ar.getUTCDate(), 0, 0, 0));
  // Reconvertimos a UTC sumando el offset → instante del 00:00 argentino en UTC.
  const startUtc = new Date(start.getTime() + AR_OFFSET_MS);
  const endUtc   = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  return { startISO: startUtc.toISOString(), endISO: endUtc.toISOString() };
}

export async function GET(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const yo   = session.sub;
  const tid  = session.tenant_id;
  const view = new URL(request.url).searchParams.get('view');

  const caja_enabled = await isCajaEnabled(session);

  // ── Mis movimientos de billetera (asc, con saldo corriendo) ────────────────
  if (view === 'billetera') {
    const { data, error } = await supabaseAdmin
      .from('movimientos')
      .select('id, tipo, monto, bono, billetera_delta, comprobante_id, created_at')
      .eq('tenant_id', tid)
      .eq('operador_id', yo)
      .neq('billetera_delta', 0)
      .order('created_at', { ascending: true });
    if (isMissingCajaTable(error)) return NextResponse.json({ caja_enabled, degraded: true, movimientos: [] });
    if (error) return new NextResponse(error.message, { status: 500 });

    let saldo = 0;
    const movimientos = (data ?? []).map((m: any) => {
      saldo += Number(m.billetera_delta);
      return {
        id:              m.id,
        tipo:            m.tipo,
        monto:           Number(m.monto),
        bono:            m.bono ?? null,
        billetera_delta: Number(m.billetera_delta),
        saldo_corriendo: saldo,
        comprobante_id:  m.comprobante_id ?? null,
        created_at:      m.created_at,
      };
    });
    return NextResponse.json({ caja_enabled, movimientos });
  }

  // ── Movimientos del pozo (comunal, SIN atribuir a operador) ─────────────────
  if (view === 'pozo') {
    const { data, error } = await supabaseAdmin
      .from('movimientos')
      .select('id, tipo, fichas_delta, created_at')
      .eq('tenant_id', tid)
      .neq('fichas_delta', 0)
      .order('created_at', { ascending: false })
      .limit(POZO_LIMIT);
    if (isMissingCajaTable(error)) return NextResponse.json({ caja_enabled, degraded: true, movimientos: [] });
    if (error) return new NextResponse(error.message, { status: 500 });

    const movimientos = (data ?? []).map((m: any) => ({
      id:           m.id,
      tipo:         m.tipo,
      fichas_delta: Number(m.fichas_delta),
      created_at:   m.created_at,
    }));
    return NextResponse.json({ caja_enabled, movimientos });
  }

  // ── Mis movimientos de HOY (zona Argentina) ────────────────────────────────
  if (view === 'hoy') {
    const { startISO, endISO } = rangoHoyArgentina();
    const { data, error } = await supabaseAdmin
      .from('movimientos')
      .select('id, tipo, monto, bono, fichas_delta, billetera_delta, comprobante_id, created_at')
      .eq('tenant_id', tid)
      .eq('operador_id', yo)
      .gte('created_at', startISO)
      .lt('created_at', endISO)
      .order('created_at', { ascending: false });
    if (isMissingCajaTable(error)) return NextResponse.json({ caja_enabled, degraded: true, movimientos: [] });
    if (error) return new NextResponse(error.message, { status: 500 });

    const movimientos = (data ?? []).map((m: any) => ({
      id:              m.id,
      tipo:            m.tipo,
      monto:           Number(m.monto),
      bono:            m.bono ?? null,
      fichas_delta:    Number(m.fichas_delta),
      billetera_delta: Number(m.billetera_delta),
      comprobante_id:  m.comprobante_id ?? null,
      created_at:      m.created_at,
    }));
    return NextResponse.json({ caja_enabled, movimientos });
  }

  // ── Comprobantes pendientes (cola GLOBAL del tenant) ───────────────────────
  if (view === 'pendientes') {
    const { data, error } = await supabaseAdmin
      .from('comprobantes')
      .select('id, tipo, monto, estado, created_at, contacts(name, phone, casino_username)')
      .eq('tenant_id', tid)
      .eq('estado', 'pendiente')
      .order('created_at', { ascending: false });
    if (error) return new NextResponse(error.message, { status: 500 });

    const comprobantes = (data ?? []).map((c: any) => ({
      id:         c.id,
      tipo:       c.tipo ?? 'carga',
      monto:      c.monto != null ? Number(c.monto) : null,
      created_at: c.created_at,
      contacto:   c.contacts?.name || c.contacts?.casino_username || c.contacts?.phone || null,
    }));
    return NextResponse.json({ caja_enabled, comprobantes });
  }

  // ── Detalle de un comprobante (lectura) ────────────────────────────────────
  if (view === 'comprobante') {
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return new NextResponse('Falta id', { status: 400 });
    const { data, error } = await supabaseAdmin
      .from('comprobantes')
      .select('id, tipo, monto, bono, estado, image_url, created_at, resolved_by_name, resolved_at, contacts(name, phone, casino_username)')
      .eq('tenant_id', tid)
      .eq('id', id)
      .maybeSingle();
    if (error) return new NextResponse(error.message, { status: 500 });
    if (!data) return new NextResponse('Comprobante no encontrado', { status: 404 });

    const c = data as any;
    return NextResponse.json({
      id:               c.id,
      tipo:             c.tipo ?? 'carga',
      monto:            c.monto != null ? Number(c.monto) : null,
      bono:             c.bono ?? null,
      estado:           c.estado,
      image_url:        c.image_url ?? null,
      created_at:       c.created_at,
      resolved_by_name: c.resolved_by_name ?? null,
      resolved_at:      c.resolved_at ?? null,
      contacto:         c.contacts?.name || c.contacts?.casino_username || c.contacts?.phone || null,
    });
  }

  // ── Resumen (default): números de las 4 cards ──────────────────────────────
  const { startISO, endISO } = rangoHoyArgentina();
  const [saldoRes, pozoRes, hoyRes, pendRes] = await Promise.all([
    supabaseAdmin.from('operador_billetera').select('saldo_actual').eq('tenant_id', tid).eq('operador_id', yo).maybeSingle(),
    supabaseAdmin.from('fichas_stock').select('stock_actual').eq('tenant_id', tid).maybeSingle(),
    supabaseAdmin.from('movimientos').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tid).eq('operador_id', yo).gte('created_at', startISO).lt('created_at', endISO),
    supabaseAdmin.from('comprobantes').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tid).eq('estado', 'pendiente'),
  ]);

  // Degradación elegante: tablas de caja ausentes → resumen en cero, sin romper.
  if (isMissingCajaTable(saldoRes.error) || isMissingCajaTable(pozoRes.error) || isMissingCajaTable(hoyRes.error)) {
    return NextResponse.json({
      caja_enabled, degraded: true,
      mi_saldo: 0, pozo: 0, mov_hoy_count: 0,
      pendientes_count: pendRes.count ?? 0,
    });
  }

  return NextResponse.json({
    caja_enabled,
    mi_saldo:         Number(saldoRes.data?.saldo_actual ?? 0), // COALESCE(.,0): sin fila → 0
    pozo:             Number(pozoRes.data?.stock_actual ?? 0),
    mov_hoy_count:    hoyRes.count ?? 0,
    pendientes_count: pendRes.count ?? 0,
  });
}
