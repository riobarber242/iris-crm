import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';

// GET /api/contacts/export — descarga TODOS los contactos del tenant en CSV.
// Scope estricto por tenant_id (de la sesión, nunca del cliente). Devuelve la
// base completa del tenant (sin el filtro de casino_username de la lista).
// La columna "linea" muestra el NOMBRE (label) de la línea de WhatsApp; vacío
// si el contacto no tiene línea asignada.

// Escapa un valor para CSV: lo envuelve en comillas y duplica las internas.
// Siempre entrecomilla para que comas, saltos de línea y ';' no rompan columnas.
function csvCell(value: unknown): string {
  const s = value == null ? '' : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

const HEADERS = ['casino_username', 'name', 'phone', 'status', 'provincia', 'linea', 'blocked', 'created_at'];

export async function GET() {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  // Mapa id→label de las líneas del tenant (incluye inactivas, para resolver el
  // nombre aunque el contacto pertenezca a una línea ya desactivada).
  const { data: lines } = await supabaseAdmin
    .from('whatsapp_numbers')
    .select('id, label')
    .eq('tenant_id', session.tenant_id);
  const labelById = new Map<string, string>((lines ?? []).map((l: any) => [l.id, l.label ?? '']));

  const { data: contacts, error } = await supabaseAdmin
    .from('contacts')
    .select('casino_username, name, phone, status, provincia, blocked, created_at, whatsapp_number_id')
    .eq('tenant_id', session.tenant_id)
    .order('created_at', { ascending: false });

  if (error) return new NextResponse(error.message, { status: 500 });

  const rows = (contacts ?? []).map((c: any) => [
    c.casino_username ?? '',
    c.name ?? '',
    c.phone ?? '',
    c.status ?? '',
    c.provincia ?? '',
    c.whatsapp_number_id ? (labelById.get(c.whatsapp_number_id) ?? '') : '',
    c.blocked ? 'sí' : 'no',
    c.created_at ?? '',
  ]);

  // BOM (﻿) para que Excel interprete UTF-8 y respete los acentos.
  const csv = '﻿'
    + [HEADERS, ...rows].map((cols) => cols.map(csvCell).join(',')).join('\r\n')
    + '\r\n';

  const today = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="contactos-${today}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
