import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { hashPassword, verifyPassword } from '@/lib/auth';
import { getSessionAgent } from '@/lib/current-agent';

// POST /api/auth/change-password — el usuario logueado cambia SU propia contraseña.
// Verifica la contraseña actual con scrypt (igual que el login) y hashea la nueva
// con scrypt. Usa service-role (supabaseAdmin); no toca la lógica de auth ni RLS.
// Pensado para agent y operator (el admin no lo necesita por ahora), pero como
// exige la contraseña actual, es seguro para cualquier sesión autenticada.
export async function POST(request: Request) {
  const session = await getSessionAgent();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const currentPassword = String(body.currentPassword ?? '');
  const newPassword     = String(body.newPassword ?? '');
  const confirmPassword = String(body.confirmPassword ?? '');

  if (!currentPassword || !newPassword) {
    return NextResponse.json({ error: 'Faltan la contraseña actual o la nueva' }, { status: 400 });
  }
  if (newPassword.length < 6) {
    return NextResponse.json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' }, { status: 400 });
  }
  if (newPassword !== confirmPassword) {
    return NextResponse.json({ error: 'La nueva contraseña y su confirmación no coinciden' }, { status: 400 });
  }

  // Traemos el hash actual del propio usuario (por id de la sesión).
  const { data: agent, error: fetchErr } = await supabaseAdmin
    .from('agents')
    .select('id, password_hash')
    .eq('id', session.sub)
    .maybeSingle();

  if (fetchErr || !agent) {
    return NextResponse.json({ error: 'No se pudo verificar la cuenta' }, { status: 400 });
  }

  // Verificación de la contraseña actual con scrypt, idéntico al login.
  if (!verifyPassword(currentPassword, agent.password_hash)) {
    return NextResponse.json({ error: 'La contraseña actual es incorrecta' }, { status: 400 });
  }

  const { error: updateErr } = await supabaseAdmin
    .from('agents')
    .update({ password_hash: hashPassword(newPassword) })
    .eq('id', session.sub);

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
