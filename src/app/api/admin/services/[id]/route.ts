import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { requireAdmin } from '@/lib/current-agent';

const FIELDS = 'id, name, icon, expires_at, notes, created_at';

// PATCH /api/admin/services/[id] — actualiza fecha de vencimiento y notas (solo admin).
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Requiere rol admin' }, { status: 403 });
  }

  const { id } = await params;
  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const updates: Record<string, any> = {};

  if (body.expires_at !== undefined) {
    const raw = body.expires_at == null ? '' : String(body.expires_at).trim();
    if (!raw) {
      updates.expires_at = null;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      updates.expires_at = raw;
    } else {
      return NextResponse.json({ error: 'Fecha inválida (usar YYYY-MM-DD)' }, { status: 400 });
    }
  }

  if (body.notes !== undefined) {
    updates.notes = body.notes == null ? null : (String(body.notes).trim() || null);
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Nada para actualizar' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('services')
    .update(updates)
    .eq('id', id)
    .select(FIELDS)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}
