// Helper de verificación (Etapa 4b): busca un operador real y emite un token de
// sesión válido (mismo HMAC que src/lib/session.ts) para probar /api/caja/operador.
// Uso interno; borrar tras verificar.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';

// Cargar .env.local a mano (sin dependencias).
const env = {};
const raw = readFileSync(new URL('../.env.local', import.meta.url), 'utf8').replace(/^﻿/, '');
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data, error } = await sb
  .from('agents').select('id, name, role, tenant_id').eq('role', 'operator').limit(1);
if (error) { console.error('DB error:', error.message); process.exit(1); }
if (!data?.length) { console.error('NO_OPERATOR'); process.exit(2); }
const op = data[0];

const enc = new TextEncoder();
const b64url = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const payload = {
  sub: op.id, name: op.name, role: op.role, tenant_id: op.tenant_id,
  exp: Math.floor(Date.now() / 1000) + 3600,
};
const payloadB64 = b64url(enc.encode(JSON.stringify(payload)));
const key = await crypto.subtle.importKey('raw', enc.encode(env.NEXTAUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payloadB64));
const token = `${payloadB64}.${b64url(new Uint8Array(sig))}`;

console.log(JSON.stringify({ operator: op, token }));
