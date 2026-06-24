import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { logActivity, ACTIVITY } from '@/lib/activity-log';

// Configuración del casino — SOLO rol 'agent' (no admin ni operator). Guarda en
// la tabla `settings` (scopeado por tenant):
//   casino_deposit_enabled : 'true' | 'false'  (switch on/off de la integración)
//   casino_api_base_url    : URL del casino
//   casino_agent_password  : token/credenciales (enmascarado: nunca se devuelve)
//
// NOTA (Etapa 1): hoy solo `casino_deposit_enabled` lo consume el backend. La URL
// y el password se guardan pero el client del casino sigue leyendo de env vars;
// el cableado real queda para una segunda etapa.
const KEY_ENABLED  = 'casino_deposit_enabled';
const KEY_BASE_URL = 'casino_api_base_url';
const KEY_PASSWORD = 'casino_agent_password';

async function getSetting(tenantId: string, key: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('settings').select('value').eq('key', key).eq('tenant_id', tenantId).maybeSingle();
  return data?.value ?? null;
}

async function upsertSetting(tenantId: string, key: string, value: string) {
  return supabaseAdmin
    .from('settings')
    .upsert({ key, value, tenant_id: tenantId }, { onConflict: 'key,tenant_id' });
}

export async function GET() {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });
  if (session.role !== 'agent') return new NextResponse('No autorizado', { status: 403 });

  const tid = session.tenant_id;
  const [enabledRaw, baseUrl, password] = await Promise.all([
    getSetting(tid, KEY_ENABLED),
    getSetting(tid, KEY_BASE_URL),
    getSetting(tid, KEY_PASSWORD),
  ]);

  // El password NUNCA se devuelve: solo si hay uno guardado (para el placeholder).
  return NextResponse.json({
    enabled: enabledRaw === 'true',
    casino_api_base_url: String(baseUrl ?? '').trim(),
    has_password: !!(password && String(password).trim()),
  });
}

export async function POST(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });
  if (session.role !== 'agent') return new NextResponse('No autorizado', { status: 403 });

  const tid = session.tenant_id;
  const body = await request.json().catch(() => ({} as any));

  // Switch on/off (siempre viene del form).
  if (typeof body.enabled === 'boolean') {
    const { error } = await upsertSetting(tid, KEY_ENABLED, body.enabled ? 'true' : 'false');
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // URL del casino (string; se guarda trim).
  if (typeof body.casino_api_base_url === 'string') {
    const { error } = await upsertSetting(tid, KEY_BASE_URL, body.casino_api_base_url.trim());
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Password/token: SOLO se actualiza si mandan un valor nuevo no vacío. Si viene
  // vacío/undefined, se deja el que ya estaba (enmascarado en el form).
  if (typeof body.casino_agent_password === 'string' && body.casino_agent_password.trim()) {
    const { error } = await upsertSetting(tid, KEY_PASSWORD, body.casino_agent_password.trim());
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await logActivity({
    session, action: ACTIVITY.CONFIG_CHANGED, objectType: 'config', objectId: 'casino',
    // No logueamos el password; solo si se tocó.
    details: {
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      casino_api_base_url: typeof body.casino_api_base_url === 'string' ? body.casino_api_base_url.trim() : undefined,
      password_changed: !!(typeof body.casino_agent_password === 'string' && body.casino_agent_password.trim()),
    },
  });

  // Reflejamos el estado actualizado (sin exponer el password).
  const [enabledRaw, baseUrl, password] = await Promise.all([
    getSetting(tid, KEY_ENABLED),
    getSetting(tid, KEY_BASE_URL),
    getSetting(tid, KEY_PASSWORD),
  ]);
  return NextResponse.json({
    ok: true,
    enabled: enabledRaw === 'true',
    casino_api_base_url: String(baseUrl ?? '').trim(),
    has_password: !!(password && String(password).trim()),
  });
}
