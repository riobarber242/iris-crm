import { NextRequest, NextResponse } from 'next/server';
import { getSessionAgent } from '@/lib/current-agent';
import { logActivity, ACTIVITY } from '@/lib/activity-log';

// Registra el resultado de un intento de activación de notificaciones push, para
// que el fallo (o el éxito) quede consultable en activity_log sin depender de la
// consola del navegador del cliente. NUNCA es crítico: si algo falla acá, el
// banner del cliente ya mostró la causa igual. Reusa logActivity (que a su vez
// nunca traba nada y falla en silencio si activity_log no existe todavía).
export async function POST(req: NextRequest) {
  try {
    const session = await getSessionAgent();
    // Sin sesión no podemos atribuir por tenant (multi-tenant estricto). No es
    // un error para el cliente: solo no registramos.
    if (!session) return NextResponse.json({ ok: true, logged: false });

    const body = await req.json().catch(() => null);
    const {
      ok,               // boolean: true = se activó; false = falló
      code,             // string corto de describePushError (ej. 'push-service', 'permission-denied')
      errorName,        // err.name real (AbortError, InvalidAccessError, …)
      errorMessage,     // err.message real
      stage,            // 'sw-ready' | 'subscribe' | 'server-post' | 'permission'
      userAgent,
      permission,       // Notification.permission
      standalone,       // ¿corre como PWA instalada?
      pushSupported,    // ¿existían las APIs de push?
    } = body ?? {};

    await logActivity({
      session,
      action: ok ? ACTIVITY.PUSH_ACTIVATED : ACTIVITY.PUSH_ACTIVATION_FAILED,
      objectType: 'push',
      details: {
        code:          code ?? null,
        errorName:     errorName ?? null,
        errorMessage:  errorMessage ?? null,
        stage:         stage ?? null,
        userAgent:     userAgent ?? req.headers.get('user-agent') ?? null,
        permission:    permission ?? null,
        standalone:    standalone ?? null,
        pushSupported: pushSupported ?? null,
      },
    });

    return NextResponse.json({ ok: true, logged: true });
  } catch (err: any) {
    // Diagnóstico best-effort: nunca devolvemos error al cliente por esto.
    console.warn('[push/diagnostics POST] no se pudo registrar:', err?.message ?? err);
    return NextResponse.json({ ok: true, logged: false });
  }
}
