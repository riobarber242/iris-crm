import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export async function GET() {
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
  sixMonthsAgo.setDate(1);
  sixMonthsAgo.setHours(0, 0, 0, 0);

  const [contactsRes, comprobantesRes, recargasRes] = await Promise.all([
    supabaseAdmin.from('contacts').select('status, provincia'),
    supabaseAdmin.from('comprobantes').select('estado'),
    supabaseAdmin.from('comprobantes')
      .select('monto, created_at')
      .eq('estado', 'verificado')
      .gte('created_at', sixMonthsAgo.toISOString()),
  ]);

  // Contact status breakdown
  const statusCount: Record<string, number> = {};
  for (const c of contactsRes.data ?? []) {
    const s = c.status ?? 'nuevo';
    statusCount[s] = (statusCount[s] ?? 0) + 1;
  }
  const contactsByStatus = [
    { status: 'cliente_activo', label: 'Cliente activo', count: statusCount['cliente_activo'] ?? 0, color: '#C8FF00' },
    { status: 'nuevo',          label: 'Nuevo',          count: statusCount['nuevo']          ?? 0, color: '#4A90D9' },
    { status: 'inactivo',       label: 'Inactivo',       count: statusCount['inactivo']       ?? 0, color: '#aaa'    },
    { status: 'bloqueado',      label: 'Bloqueado',      count: statusCount['bloqueado']      ?? 0, color: '#FF4444' },
    { status: 'en_proceso',     label: 'En proceso',     count: statusCount['en_proceso']     ?? 0, color: '#FFB800' },
  ].filter((s) => s.count > 0);

  // Comprobantes breakdown
  const estadoCount: Record<string, number> = {};
  for (const c of comprobantesRes.data ?? []) {
    const e = c.estado ?? 'pendiente';
    estadoCount[e] = (estadoCount[e] ?? 0) + 1;
  }
  const comprobantesByEstado = [
    { estado: 'verificado', label: 'Verificado', count: estadoCount['verificado'] ?? 0, color: '#22C55E' },
    { estado: 'pendiente',  label: 'Pendiente',  count: estadoCount['pendiente']  ?? 0, color: '#F59E0B' },
    { estado: 'rechazado',  label: 'Rechazado',  count: estadoCount['rechazado']  ?? 0, color: '#EF4444' },
  ].filter((s) => s.count > 0);

  // Revenue by month (last 6)
  const byMonth: Record<string, number> = {};
  for (const r of recargasRes.data ?? []) {
    const d = new Date(r.created_at);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    byMonth[key] = (byMonth[key] ?? 0) + Number(r.monto ?? 0);
  }
  const now = new Date();
  const revenueByMonth = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    return { label: MONTHS_ES[d.getMonth()], monto: byMonth[key] ?? 0 };
  });

  // Province breakdown
  const provMap: Record<string, Record<string, number>> = {};
  for (const c of contactsRes.data ?? []) {
    if (!c.provincia) continue;
    if (!provMap[c.provincia]) provMap[c.provincia] = {};
    const s = c.status ?? 'nuevo';
    provMap[c.provincia][s] = (provMap[c.provincia][s] ?? 0) + 1;
  }
  // Dominant by business priority, NOT raw majority: a province with even one
  // cliente_activo paints green so active clients are never masked by 'nuevo' contacts.
  const STATUS_PRIORITY = ['cliente_activo', 'en_proceso', 'nuevo', 'inactivo', 'bloqueado'];
  const provinceData = Object.entries(provMap).map(([provincia, counts]) => {
    const total    = Object.values(counts).reduce((s, n) => s + n, 0);
    const dominant = STATUS_PRIORITY.find((s) => (counts[s] ?? 0) > 0)
                  ?? Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0]
                  ?? 'nuevo';
    return { provincia, total, dominant, counts };
  });

  return NextResponse.json({ contactsByStatus, comprobantesByEstado, revenueByMonth, provinceData });
}
