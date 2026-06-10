import { NextResponse } from 'next/server';
import { getSessionAgent } from '@/lib/current-agent';
import { createMessageTemplate } from '@/lib/meta/client';
import { getTemplate } from '@/lib/meta/templates';

// Registra una plantilla del config en Meta (queda en revisión hasta aprobación).
// Solo admin. Body: { name?: string } — por defecto 'bienvenida_reactivacion'.
export async function POST(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });
  if (session.role !== 'admin') return new NextResponse('Requiere rol admin', { status: 403 });

  const body = await request.json().catch(() => ({}));
  const name = (body?.name as string) || 'bienvenida_reactivacion';

  const def = getTemplate(name);
  if (!def) return NextResponse.json({ error: `Plantilla "${name}" no está en el config` }, { status: 404 });

  try {
    const result = await createMessageTemplate({
      name:     def.name,
      language: def.language,
      category: def.category,
      bodyText: def.bodyText,
    });
    return NextResponse.json({ ok: true, template: def.name, result });
  } catch (err: any) {
    const reason = err?.response?.data?.error?.message || err?.message || 'Error registrando la plantilla';
    return NextResponse.json({ ok: false, error: reason }, { status: 502 });
  }
}
