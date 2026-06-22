import { NextResponse } from 'next/server';
import { requireAgentOrAdmin } from '@/lib/current-agent';
import { getTenantSetting, setTenantSetting } from '@/lib/bot-config';

// Endpoint genérico de settings por tenant para el cliente. Whitelist EXPLÍCITA
// de claves: sin esto, exponer GET/POST de la tabla settings dejaría leer y
// pisar cualquier configuración (system_prompt, bot_enabled, etc.) desde el front.
const ALLOWED_KEYS = ['meta_business_verified'];

// GET /api/tenant-settings?key=meta_business_verified → { key, value }
export async function GET(request: Request) {
  const session = await requireAgentOrAdmin();
  if (!session) return new NextResponse('Requiere rol admin o agent', { status: 403 });

  const key = new URL(request.url).searchParams.get('key') ?? '';
  if (!ALLOWED_KEYS.includes(key)) {
    return NextResponse.json({ error: 'Clave no permitida' }, { status: 400 });
  }

  const value = await getTenantSetting(session.tenant_id, key);
  return NextResponse.json({ key, value });
}

// POST /api/tenant-settings  { key, value } → { ok: true }
export async function POST(request: Request) {
  const session = await requireAgentOrAdmin();
  if (!session) return new NextResponse('Requiere rol admin o agent', { status: 403 });

  const body = await request.json().catch(() => null);
  const key = String(body?.key ?? '');
  const value = String(body?.value ?? '');
  if (!ALLOWED_KEYS.includes(key)) {
    return NextResponse.json({ error: 'Clave no permitida' }, { status: 400 });
  }

  const err = await setTenantSetting(session.tenant_id, key, value);
  if (err) return NextResponse.json({ error: err }, { status: 500 });
  return NextResponse.json({ ok: true });
}
