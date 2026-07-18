import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { requireAdmin } from '@/lib/current-agent';
import { encryptSecret, isSecretEncryptionConfigured, isEncryptedSecret } from '@/lib/secure-secret';

// POST /api/admin/whatsapp-numbers/encrypt-backfill — Etapa cifrado de tokens (PR1).
//
// Cifra hacia las columnas *_enc los access_token / app_secret que hoy están en
// texto plano, SIN borrar el plano (la lectura dual lo sigue teniendo de red hasta
// el corte del PR5). Idempotente: solo toca filas con plano presente y *_enc vacío;
// correrlo dos veces no hace nada la segunda. Devuelve un resumen SIN secretos.
//
// Corre en Vercel (necesita SECRET_ENC_KEY). Guard: requireAdmin.
export async function POST() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Requiere rol admin' }, { status: 403 });
  }
  if (!isSecretEncryptionConfigured()) {
    return NextResponse.json({ error: 'Falta SECRET_ENC_KEY (clave de cifrado) en el entorno' }, { status: 500 });
  }

  const { data: rows, error } = await supabaseAdmin
    .from('whatsapp_numbers')
    .select('id, access_token, access_token_enc, app_secret, app_secret_enc');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let tokenEncrypted = 0;
  let secretEncrypted = 0;
  const failures: string[] = [];

  for (const r of rows ?? []) {
    const updates: Record<string, string> = {};

    const plainToken = (r.access_token ?? '').trim();
    // Cifrar solo si hay plano, todavía no hay *_enc, y el plano no es ya un cifrado.
    if (plainToken && !r.access_token_enc && !isEncryptedSecret(plainToken)) {
      updates.access_token_enc = encryptSecret(plainToken);
    }

    const plainSecret = (r.app_secret ?? '').trim();
    if (plainSecret && !r.app_secret_enc && !isEncryptedSecret(plainSecret)) {
      updates.app_secret_enc = encryptSecret(plainSecret);
    }

    if (Object.keys(updates).length === 0) continue;

    // NO tocamos las columnas planas: se conservan como red de la lectura dual.
    const { error: upErr } = await supabaseAdmin
      .from('whatsapp_numbers').update(updates).eq('id', r.id);
    if (upErr) { failures.push(`${r.id}: ${upErr.message}`); continue; }

    if (updates.access_token_enc) tokenEncrypted++;
    if (updates.app_secret_enc)   secretEncrypted++;
  }

  return NextResponse.json({
    ok: failures.length === 0,
    rows_scanned: rows?.length ?? 0,
    access_token_encrypted: tokenEncrypted,
    app_secret_encrypted: secretEncrypted,
    failures,
  });
}
