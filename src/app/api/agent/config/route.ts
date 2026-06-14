import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { irisSystemPrompt } from '@/lib/system-prompt';

// Self-service del system prompt del bot para el panel del agente.
// Fuente de verdad: settings(key='system_prompt') scopeado por tenant_id —
// es el MISMO valor que lee el bot en handler.ts (getSystemPrompt). No usamos
// una columna tenants.system_prompt para no duplicar la fuente.
const KEY = 'system_prompt';
const MAX_LEN = 4000;

// El operador no administra el bot: solo admin + agent editan el system prompt.
async function requireStaff() {
  const session = await getSessionAgent();
  if (!session) return { error: new NextResponse('No autenticado', { status: 401 }) };
  if (session.role === 'operator') return { error: new NextResponse('No autorizado', { status: 403 }) };
  return { session };
}

export async function GET() {
  const { session, error } = await requireStaff();
  if (error) return error;

  const { data } = await supabaseAdmin
    .from('settings')
    .select('value')
    .eq('key', KEY)
    .eq('tenant_id', session.tenant_id)
    .limit(1)
    .maybeSingle();

  // Si todavía no se guardó nada, cae al prompt hardcodeado por defecto.
  return NextResponse.json({
    prompt: data?.value ?? irisSystemPrompt,
    default: irisSystemPrompt,
    maxLength: MAX_LEN,
  });
}

export async function PATCH(request: Request) {
  const { session, error } = await requireStaff();
  if (error) return error;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new NextResponse('JSON inválido', { status: 400 });
  }

  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    return new NextResponse('El prompt no puede estar vacío', { status: 400 });
  }
  if (prompt.length > MAX_LEN) {
    return new NextResponse(`El prompt supera el máximo de ${MAX_LEN} caracteres`, { status: 400 });
  }

  // settings tiene unicidad por (key, tenant_id) → reemplazamos la fila del tenant.
  await supabaseAdmin.from('settings').delete().eq('key', KEY).eq('tenant_id', session.tenant_id);
  const { error: dbError } = await supabaseAdmin
    .from('settings')
    .insert({ key: KEY, value: prompt, tenant_id: session.tenant_id });

  if (dbError) return new NextResponse(dbError.message, { status: 500 });
  return NextResponse.json({ ok: true, prompt });
}
