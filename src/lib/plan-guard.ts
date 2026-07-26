// Guards de plan del lado del SERVIDOR (Node). Complemento del gate del
// middleware, no reemplazo:
//
//   - El middleware (Edge) decide con el plan que viaja en el TOKEN. Es la
//     primera línea y cubre página + API por prefijo, pero un token viejo (la
//     cookie dura 7 días) puede traer un plan desactualizado: si bajás un tenant
//     de premium a lite, sus sesiones abiertas seguirían pasando.
//   - Estos guards leen el plan de la BASE en cada request. Son más caros (una
//     query) pero son los autoritativos, y además cubren cualquier ruta que el
//     matcher del middleware no llegue a contemplar.
//
// Correr los dos NO es redundancia inútil: el barato filtra el 99% y el caro
// cierra la ventana del token desactualizado.

import { notFound } from 'next/navigation';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from './db';
import { getSessionAgent } from './current-agent';
import { hasFeature, normalizePlan, type Feature, type Plan } from './plan';

// Plan del tenant, leído de la base. Ante un error de lectura devuelve
// 'premium' (mismo criterio que normalizePlan): un fallo de la base no puede
// dejar sin secciones a un cliente que sí las paga.
export async function planForTenant(tenantId: string | null | undefined): Promise<Plan> {
  if (!tenantId) return 'premium';
  const { data, error } = await supabaseAdmin
    .from('tenants').select('plan').eq('id', tenantId).maybeSingle();
  if (error) {
    console.warn('[plan] No se pudo leer el plan del tenant, se asume premium:', error.message);
    return 'premium';
  }
  return normalizePlan(data?.plan);
}

// Plan del tenant de la sesión actual. Sin sesión → 'premium': la falta de
// sesión ya la resuelven el middleware y los guards de auth de cada ruta; acá
// solo nos ocupamos del plan.
async function currentPlan(): Promise<Plan> {
  const session = await getSessionAgent();
  return planForTenant(session?.tenant_id);
}

// Para PÁGINAS (server components): si el plan no incluye la feature, la página
// devuelve el 404 real de Next, igual que una ruta inexistente. notFound() lanza
// una excepción de control de Next, así que corta la ejecución acá.
export async function requireFeaturePage(feature: Feature): Promise<void> {
  if (!hasFeature(await currentPlan(), feature)) notFound();
}

// Para ROUTE HANDLERS: devuelve una respuesta 404 si la feature está fuera del
// plan, o null si puede seguir. Uso:
//
//   const blocked = await featureBlocked('caja');
//   if (blocked) return blocked;
//
// El cuerpo va vacío a propósito: no confirma que el endpoint exista ni explica
// por qué (un 403 con "requiere Premium" delataría la sección).
export async function featureBlocked(feature: Feature): Promise<NextResponse | null> {
  if (hasFeature(await currentPlan(), feature)) return null;
  return new NextResponse(null, { status: 404 });
}
