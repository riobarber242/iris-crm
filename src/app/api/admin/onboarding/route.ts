import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/current-agent';
import { createAgentOnboarding, OnboardingError, type OnboardingInput } from '@/lib/onboarding';

// POST /api/admin/onboarding — alta guiada de un agente nuevo (wizard admin).
//
// Punto de entrada admin-only. La creación en sí vive en createAgentOnboarding
// (src/lib/onboarding.ts), invocable desde otro entry point self-service futuro
// sin tocar esta lógica.
export async function POST(request: Request) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Requiere rol admin' }, { status: 403 });
  }

  let body: OnboardingInput;
  try { body = await request.json(); } catch { body = {} as OnboardingInput; }

  try {
    const result = await createAgentOnboarding(body);
    return NextResponse.json(result);
  } catch (err: any) {
    if (err instanceof OnboardingError) {
      return NextResponse.json({ error: err.message, field: err.field }, { status: 400 });
    }
    console.error('[onboarding] alta falló:', err);
    return NextResponse.json({ error: err?.message ?? 'No se pudo crear el agente' }, { status: 500 });
  }
}
