import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { logActivity, ACTIVITY } from '@/lib/activity-log';
import {
  recargarFichas, isCajaEnabled,
  setStock, setBilletera, borrarMovimiento, resetTotal,
  verificarDescarga, rechazarDescarga, verificarTraspaso,
} from '@/lib/caja';
import type { SessionPayload } from '@/lib/session';

// Caja de fichas — solo admin/agent. El operator NO entra (middleware lo frena
// igual; acá va la defensa server-side, fuente de verdad de los permisos).
function requireStaff(session: SessionPayload | null): session is SessionPayload {
  return !!session && (session.role === 'admin' || session.role === 'agent');
}

// Detecta tablas de caja ausentes (migración Etapa 2 sin correr) para degradar.
function isMissingCajaTable(err: any): boolean {
  if (!err) return false;
  const code = String(err.code ?? '');
  const msg  = String(err.message ?? '');
  if (code === '42P01' || code === 'PGRST205' || code === 'PGRST204') return true;
  return /fichas_stock|operador_billetera|movimientos|schema cache|does not exist|could not find/i.test(msg);
}

// GET /api/fichas — resumen de caja: stock, billeteras por operador y últimos
// movimientos. Reutilizado por la pantalla /fichas y por el dashboard.
export async function GET() {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });
  if (!requireStaff(session)) return new NextResponse('No autorizado', { status: 403 });

  const tid = session.tenant_id;
  const caja_enabled = await isCajaEnabled(session);

  const [stockRes, billRes, movRes, descPendRes, descHistRes, cierresRes] = await Promise.all([
    supabaseAdmin.from('fichas_stock').select('stock_actual').eq('tenant_id', tid).maybeSingle(),
    supabaseAdmin.from('operador_billetera').select('operador_id, saldo_actual, saldo_congelado, turno_abierto').eq('tenant_id', tid),
    supabaseAdmin.from('movimientos').select('*').eq('tenant_id', tid).order('created_at', { ascending: false }).limit(30),
    // Pendientes a verificar: descargas (Etapa 5) Y cierres de turno (traspaso,
    // Etapa 6). El receptor/agente los verifica acá. Degradan a [] si falta la
    // columna operador_id (stage5/6).
    supabaseAdmin.from('comprobantes').select('id, tipo, monto, operador_id, operador_destino_id, created_at')
      .eq('tenant_id', tid).in('tipo', ['descarga', 'traspaso']).eq('estado', 'pendiente').order('created_at', { ascending: false }),
    supabaseAdmin.from('comprobantes').select('id, monto, operador_id, resolved_by_name, resolved_at, created_at')
      .eq('tenant_id', tid).eq('tipo', 'descarga').eq('estado', 'verificado').order('resolved_at', { ascending: false }).limit(50),
    // Cierres de turno (Etapa 6): todos los del tenant para el panel del agente.
    supabaseAdmin.from('cierres_turno')
      .select('id, operador_id, operador_destino_id, turno_inicio_at, turno_fin_at, total_cargas, total_pagos, total_descargas, total_sueldo, total_traspaso, billetera_inicio, created_at')
      .eq('tenant_id', tid).order('created_at', { ascending: false }).limit(100),
  ]);

  // Degradación elegante: tablas ausentes → resumen vacío, sin romper la UI.
  if (isMissingCajaTable(stockRes.error) || isMissingCajaTable(billRes.error) || isMissingCajaTable(movRes.error)) {
    return NextResponse.json({ caja_enabled, degraded: true, stock: 0, total_billeteras: 0, billeteras: [], movimientos: [], descargas_pendientes: [], descargas_historial: [], mi_billetera_agente: 0, cierres: [] });
  }
  const anyErr = stockRes.error || billRes.error || movRes.error;
  if (anyErr) return new NextResponse(anyErr.message, { status: 500 });

  const billeteras  = (billRes.data ?? []) as any[];
  const movimientos = (movRes.data ?? []) as any[];
  // Si las columnas operador_id/operador_destino_id aún no existen, estas → [].
  const descPend = (descPendRes.error ? [] : (descPendRes.data ?? [])) as any[];
  const descHist = (descHistRes.error ? [] : (descHistRes.data ?? [])) as any[];
  const cierres  = (cierresRes.error ? [] : (cierresRes.data ?? [])) as any[];

  // Nombres de los operadores (un solo fetch a agents para todo lo que los use).
  const ids = new Set<string>();
  for (const b of billeteras)  if (b.operador_id) ids.add(b.operador_id);
  for (const m of movimientos) if (m.operador_id)  ids.add(m.operador_id);
  for (const d of descPend)    { if (d.operador_id) ids.add(d.operador_id); if (d.operador_destino_id) ids.add(d.operador_destino_id); }
  for (const d of descHist)    if (d.operador_id)  ids.add(d.operador_id);
  for (const c of cierres)     { if (c.operador_id) ids.add(c.operador_id); if (c.operador_destino_id) ids.add(c.operador_destino_id); }
  const nameById = new Map<string, { name: string; role: string }>();
  if (ids.size > 0) {
    const { data: ags } = await supabaseAdmin.from('agents').select('id, name, role').in('id', Array.from(ids));
    for (const a of ags ?? []) nameById.set(a.id, { name: a.name, role: a.role });
  }

  // Operadores con una descarga pendiente (para el panel "Operadores en turno").
  const descargaPendOpIds = new Set(
    descPend.filter((d: any) => (d.tipo ?? 'descarga') === 'descarga' && d.operador_id).map((d: any) => d.operador_id),
  );

  const billeterasOut = billeteras
    .map((b: any) => ({
      operador_id:   b.operador_id,
      name:          nameById.get(b.operador_id)?.name ?? '—',
      role:          nameById.get(b.operador_id)?.role ?? null,
      saldo:         Number(b.saldo_actual),
      saldo_congelado: Number(b.saldo_congelado ?? 0),
      turno_abierto: !!b.turno_abierto,
      tiene_descarga_pendiente: descargaPendOpIds.has(b.operador_id),
    }))
    .sort((a, b) => b.saldo - a.saldo);

  const total_billeteras = billeterasOut.reduce((s, b) => s + b.saldo, 0);

  const movimientosOut = movimientos.map((m: any) => ({
    id:              m.id,
    tipo:            m.tipo,
    monto:           Number(m.monto),
    bono:            m.bono ?? null,
    fichas_delta:    Number(m.fichas_delta),
    billetera_delta: Number(m.billetera_delta),
    operador_id:     m.operador_id,
    operador_name:   nameById.get(m.operador_id)?.name ?? m.creado_por_name ?? '—',
    creado_por_name: m.creado_por_name ?? null,
    comprobante_id:  m.comprobante_id ?? null,
    editado:         !!m.editado,
    created_at:      m.created_at,
  }));

  // Pendientes de verificar (Etapa 5 descargas + Etapa 6 traspasos). El `tipo`
  // decide qué acción dispara el botón Verificar en el front.
  const descargas_pendientes = descPend.map((d: any) => ({
    id:            d.id,
    tipo:          d.tipo ?? 'descarga',
    monto:         Number(d.monto),
    operador_id:   d.operador_id,
    operador_name: nameById.get(d.operador_id)?.name ?? '—',
    destino_name:  d.operador_destino_id ? (nameById.get(d.operador_destino_id)?.name ?? '—') : null,
    created_at:    d.created_at,
  }));

  // Cierres de turno del tenant (Etapa 6).
  const cierresOut = cierres.map((c: any) => ({
    id:              c.id,
    operador_id:     c.operador_id,
    operador_name:   nameById.get(c.operador_id)?.name ?? '—',
    destino_name:    c.operador_destino_id ? (nameById.get(c.operador_destino_id)?.name ?? '—') : '—',
    turno_inicio_at: c.turno_inicio_at,
    turno_fin_at:    c.turno_fin_at,
    total_cargas:    Number(c.total_cargas ?? 0),
    total_pagos:     Number(c.total_pagos ?? 0),
    total_descargas: Number(c.total_descargas ?? 0),
    total_sueldo:    Number(c.total_sueldo ?? 0),
    total_traspaso:  Number(c.total_traspaso ?? 0),
    billetera_inicio: Number(c.billetera_inicio ?? 0),
    created_at:      c.created_at,
  }));
  const descargas_historial = descHist.map((d: any) => ({
    id:            d.id,
    monto:         Number(d.monto),
    operador_id:   d.operador_id,
    operador_name: nameById.get(d.operador_id)?.name ?? '—',
    verificado_por: d.resolved_by_name ?? '—',
    verificado_at:  d.resolved_at ?? d.created_at,
  }));

  // Billetera del agente logueado (lo que recibe por descargas verificadas).
  const mi_billetera_agente = Number(
    billeteras.find((b: any) => b.operador_id === session.sub)?.saldo_actual ?? 0,
  );

  return NextResponse.json({
    caja_enabled,
    stock: Number(stockRes.data?.stock_actual ?? 0),
    total_billeteras,
    billeteras: billeterasOut,
    movimientos: movimientosOut,
    descargas_pendientes,
    descargas_historial,
    mi_billetera_agente,
    cierres: cierresOut,
  });
}

// POST /api/fichas — acciones de caja. Parte 2: recargar pozo + on/off del flag.
// (Las acciones manuales/destructivas del agente se agregan en la Parte 4.)
export async function POST(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });
  if (!requireStaff(session)) return new NextResponse('No autorizado', { status: 403 });

  const body = await request.json().catch(() => ({} as any));
  const action = body?.action;

  switch (action) {
    case 'recargar': {
      const r = await recargarFichas(session, Number(body.cantidad));
      if (!r.ok) return new NextResponse(r.error, { status: r.degraded ? 409 : 400 });
      return NextResponse.json({ ok: true, stock: r.stock });
    }

    case 'set_caja_enabled': {
      const enabled = !!body.enabled;
      const { error } = await supabaseAdmin
        .from('settings')
        .upsert({ tenant_id: session.tenant_id, key: 'caja_enabled', value: enabled ? 'true' : 'false' }, { onConflict: 'key,tenant_id' });
      if (error) return new NextResponse(error.message, { status: 500 });
      await logActivity({
        session, action: ACTIVITY.CONFIG_CHANGED, objectType: 'config', objectId: 'caja_enabled',
        details: { key: 'caja_enabled', value: enabled },
      });
      return NextResponse.json({ ok: true, caja_enabled: enabled });
    }

    // ── Controles manuales del agente (Parte 4). Cada uno revalida el rol
    //    server-side dentro de su función de caja (operator → 'No autorizado').
    case 'set_stock': {
      const r = await setStock(session, Number(body.stock));
      if (!r.ok) return new NextResponse(r.error, { status: r.degraded ? 409 : 400 });
      return NextResponse.json(r);
    }

    case 'set_billetera': {
      const r = await setBilletera(session, String(body.operadorId ?? ''), Number(body.saldo));
      if (!r.ok) return new NextResponse(r.error, { status: r.degraded ? 409 : 400 });
      return NextResponse.json(r);
    }

    case 'reset_billetera': {
      const r = await setBilletera(session, String(body.operadorId ?? ''), 0);
      if (!r.ok) return new NextResponse(r.error, { status: r.degraded ? 409 : 400 });
      return NextResponse.json(r);
    }

    case 'borrar_movimiento': {
      const r = await borrarMovimiento(session, String(body.movimientoId ?? ''));
      if (!r.ok) return new NextResponse(r.error, { status: r.degraded ? 409 : 400 });
      return NextResponse.json(r);
    }

    // Verificar una descarga pendiente (Etapa 5): mueve el monto de la billetera
    // del operador a la del agente que verifica. El guard de saldo y caja vive en
    // fn_verificar_descarga; el mensaje real del guard sube al front.
    case 'verificar_descarga': {
      const r = await verificarDescarga(session, String(body.comprobanteId ?? ''));
      if (!r.ok) return new NextResponse(r.error, { status: r.degraded ? 409 : 400 });
      return NextResponse.json({ ok: true, saldo_operador: r.saldoOperador, saldo_agente: r.saldoAgente });
    }

    // Rechazar una descarga pendiente: libera el congelado del operador y marca
    // el comprobante 'rechazado'. Solo staff (mismo lugar que verificar_descarga).
    case 'rechazar_descarga': {
      const r = await rechazarDescarga(session, String(body.comprobanteId ?? ''));
      if (!r.ok) return new NextResponse(r.error, { status: r.degraded ? 409 : 400 });
      return NextResponse.json({ ok: true });
    }

    // Verificar un cierre de turno (Etapa 6): recién acá fn_cerrar_turno mueve la
    // plata (origen→0, destino+=saldo) e inserta el cierre en cierres_turno.
    case 'verificar_traspaso': {
      const r = await verificarTraspaso(session, String(body.comprobanteId ?? ''));
      if (!r.ok) return new NextResponse(r.error, { status: r.degraded ? 409 : 400 });
      return NextResponse.json({ ok: true, resumen: r.resumen });
    }

    case 'reset_total': {
      // Confirmación fuerte obligatoria server-side: el cliente debe mandar
      // confirm === 'RESET'. Comprobantes solo si se tilda explícitamente.
      if (body.confirm !== 'RESET') {
        return new NextResponse('Confirmación inválida: escribí RESET para confirmar', { status: 400 });
      }
      const r = await resetTotal(session, body.borrar_comprobantes === true);
      if (!r.ok) return new NextResponse(r.error, { status: r.degraded ? 409 : 400 });
      return NextResponse.json(r);
    }

    default:
      return new NextResponse('Acción inválida', { status: 400 });
  }
}
