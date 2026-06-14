import { NextResponse } from 'next/server';
import { getSessionAgent } from '@/lib/current-agent';
import { getOfflineMsg, setTenantSetting, validateBotText, DEFAULT_OFFLINE_MSG } from '@/lib/bot-config';
import { logActivity, ACTIVITY } from '@/lib/activity-log';

const MAX_LEN = 300;

// Mensaje que el bot envía a los clientes cuando el tenant está en modo offline.
// Lo ve el cliente, así que aplica validateBotText (sin "casino" ni promesas),
// igual que el editor de Iris AI. El on/off vive en /api/settings/offline-mode.
export async function GET() {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const msg = await getOfflineMsg(session.tenant_id);
  return NextResponse.json({ msg, default: DEFAULT_OFFLINE_MSG });
}

export async function POST(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const { msg } = await request.json();
  const value = String(msg ?? '').trim();

  if (!value) {
    return NextResponse.json({ ok: false, error: 'El mensaje no puede estar vacío.' }, { status: 400 });
  }
  if (value.length > MAX_LEN) {
    return NextResponse.json({ ok: false, error: `El mensaje supera el máximo de ${MAX_LEN} caracteres.` }, { status: 400 });
  }
  const invalid = validateBotText(value);
  if (invalid) {
    return NextResponse.json({ ok: false, error: `El mensaje ${invalid}.` }, { status: 400 });
  }

  const err = await setTenantSetting(session.tenant_id, 'offline_msg', value);
  if (err) {
    return NextResponse.json({ ok: false, error: err }, { status: 500 });
  }

  await logActivity({
    session,
    action:     ACTIVITY.CONFIG_CHANGED,
    objectType: 'config',
    objectId:   'offline_msg',
    details:    { key: 'offline_msg' },
  });

  return NextResponse.json({ ok: true, msg: value });
}
