import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/current-agent';

// GET /api/admin/services/anthropic-balance — saldo de créditos de la API de Anthropic.
//
// ⚠️ A día de hoy Anthropic NO expone un endpoint público de balance
// (feature request abierto: github.com/anthropics/anthropic-sdk-python/issues/505).
// El saldo solo se ve en la Console (Billing). Esta ruta intenta el endpoint
// igualmente y degrada con elegancia: si no hay key, o el endpoint no existe /
// falla / no devuelve un número, responde { available: false } y la UI muestra
// "No se puede verificar saldo automáticamente". Queda forward-compatible: si
// Anthropic publica el endpoint, parsea el número sin cambios de UI.
export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Requiere rol admin' }, { status: 403 });
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return NextResponse.json({ available: false, reason: 'no_api_key' });
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch('https://api.anthropic.com/v1/organizations/balance', {
      method: 'GET',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      // 404 esperado: el endpoint no existe todavía.
      return NextResponse.json({ available: false, reason: `http_${res.status}` });
    }

    const data: any = await res.json().catch(() => null);
    // No conocemos la forma oficial (no hay endpoint). Probamos campos plausibles.
    const raw =
      data?.balance ??
      data?.available_balance ??
      data?.data?.balance ??
      data?.credits ??
      data?.available_credits;
    const amount = Number(raw);

    if (!Number.isFinite(amount)) {
      return NextResponse.json({ available: false, reason: 'no_balance_field' });
    }
    return NextResponse.json({ available: true, balance: amount });
  } catch (err: any) {
    return NextResponse.json({ available: false, reason: err?.name === 'AbortError' ? 'timeout' : 'fetch_error' });
  }
}
