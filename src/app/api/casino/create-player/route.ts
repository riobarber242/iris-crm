import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { createPlayer, getPlayerTargetId } from '@/lib/casino/client';
import { sendWhatsAppText } from '@/lib/meta/client';
import { logActivity } from '@/lib/activity-log';
import type { SessionPayload } from '@/lib/session';

// Solo admin/agent: crear un usuario en el casino es una acción de staff.
function requireStaff(session: SessionPayload | null): session is SessionPayload {
  return !!session && (session.role === 'admin' || session.role === 'agent');
}

// Contraseña automática: "Suerte" + 4 dígitos → cumple ≥8 chars, 1 mayúscula,
// 1 minúscula y 1 dígito que exige el casino (ej: Suerte4821).
function generatePassword(): string {
  const n = Math.floor(1000 + Math.random() * 9000); // 1000–9999
  return `Suerte${n}`;
}

// Reglas del casino: ≥8 chars, una mayúscula, una minúscula y un dígito.
const PASSWORD_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;

// Dado un username con sufijo "<base><n>js" devuelve el siguiente correlativo
// (base + (n+1) + "js"). Si no matchea el patrón, antepone el número 2.
function nextUsername(username: string): string {
  const m = username.match(/^(.*?)(\d+)js$/i);
  if (m) return `${m[1]}${Number(m[2]) + 1}js`;
  return `${username}2`;
}

// POST /api/casino/create-player — crea un jugador en el casino y lo guarda en
// el contacto. Body: { contactId, suggestedUsername }.
// Respuesta: { success, username, password } | { success: false, error }.
export async function POST(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });
  if (!requireStaff(session)) return new NextResponse('No autorizado', { status: 403 });

  // Gate por tenant: solo donde casino_deposit_enabled = 'true'.
  const { data: flagRow } = await supabaseAdmin
    .from('settings').select('value')
    .eq('key', 'casino_deposit_enabled').eq('tenant_id', session.tenant_id).maybeSingle();
  if (flagRow?.value !== 'true') {
    return NextResponse.json({ success: false, error: 'El casino no está activado para este tenant' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const contactId = typeof body.contactId === 'string' ? body.contactId.trim() : '';
  let username = typeof body.suggestedUsername === 'string' ? body.suggestedUsername.trim().toLowerCase() : '';

  if (!contactId) return NextResponse.json({ success: false, error: 'Falta contactId' }, { status: 400 });
  if (!username)  return NextResponse.json({ success: false, error: 'Falta el username sugerido' }, { status: 400 });

  // El contacto debe existir y pertenecer al tenant. Si ya tiene usuario, no se
  // crea otro (evita pisar uno cargado a mano).
  const { data: contact } = await supabaseAdmin
    .from('contacts').select('id, casino_username, tenant_id, phone, whatsapp_number_id')
    .eq('id', contactId).eq('tenant_id', session.tenant_id).maybeSingle();
  if (!contact) return NextResponse.json({ success: false, error: 'Contacto no encontrado' }, { status: 404 });
  if (contact.casino_username) {
    return NextResponse.json({ success: false, error: `El contacto ya tiene usuario: ${contact.casino_username}` }, { status: 409 });
  }

  // Contraseña: la que mandó el operador (editable en el modal) o una generada.
  const providedPassword = typeof body.password === 'string' ? body.password.trim() : '';
  const password = providedPassword || generatePassword();
  if (!PASSWORD_RE.test(password)) {
    return NextResponse.json({ success: false, error: 'La contraseña debe tener al menos 8 caracteres, una mayúscula, una minúscula y un número.' }, { status: 400 });
  }

  // Reintento correlativo: si el casino rechaza por usuario ya existente,
  // incrementamos el número (…1js → …2js → …) hasta 20 intentos.
  let result = await createPlayer(username, password);
  let attempts = 0;
  while (!result.success && result.taken && attempts < 20) {
    username = nextUsername(username);
    result = await createPlayer(username, password);
    attempts++;
  }

  // Timeout pero quizás el casino SÍ creó el usuario (lo procesó pero tardó).
  // Confirmamos con un lookup: si aparece, lo tratamos como creado (evita fallar
  // y que un reintento manual genere un usuario duplicado).
  if (!result.success && /no respondió a tiempo/i.test(result.error ?? '')) {
    try {
      const targetId = await getPlayerTargetId(username);
      if (targetId) {
        console.log(`[create-player] timeout pero el usuario existe → tratado como creado: ${username}`);
        result = { success: true, username };
      }
    } catch (e: any) {
      console.warn('[create-player] lookup post-timeout falló:', e?.message ?? e);
    }
  }

  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error ?? 'No se pudo crear el usuario en el casino' }, { status: 502 });
  }

  // Persistimos el usuario en el contacto (tenant-scoped).
  const { error: updErr } = await supabaseAdmin
    .from('contacts').update({ casino_username: username })
    .eq('id', contactId).eq('tenant_id', session.tenant_id);
  if (updErr) {
    // El usuario SÍ se creó en el casino; avisamos para que lo carguen a mano.
    return NextResponse.json({
      success: false,
      error: `Usuario creado en el casino (${username}) pero no se pudo guardar en el contacto: ${updErr.message}`,
      username, password,
    }, { status: 500 });
  }

  // Aviso de credenciales. Best-effort (no rompe la respuesta 200). El mensaje se
  // guarda SIEMPRE en el chat (no requiere phone); el WhatsApp solo si hay phone.
  try {
    // URL que recibe el JUGADOR: priorizamos casino_player_url (la pública de
    // juego); si no está configurada, caemos a casino_api_base_url y al env, para
    // no romper tenants que aún no cargaron la URL nueva.
    const { data: urlRows } = await supabaseAdmin
      .from('settings').select('key, value')
      .in('key', ['casino_player_url', 'casino_api_base_url']).eq('tenant_id', session.tenant_id);
    const byKey = new Map((urlRows ?? []).map((r: any) => [r.key, String(r.value ?? '').trim()]));
    const casinoUrl = (byKey.get('casino_player_url')
      || byKey.get('casino_api_base_url')
      || String(process.env.CASINO_API_BASE_URL ?? '').trim());
    const urlLine = casinoUrl ? `Ingresá en ${casinoUrl} y empezá a jugar 🎲` : '¡Ya podés empezar a jugar! 🎲';
    const msg = `🎰 ¡Tu cuenta fue creada!\nUsuario: ${username}\nContraseña: ${password}\n${urlLine}`;

    // 1) Guardar en el chat SIEMPRE.
    const { error: msgErr } = await supabaseAdmin.from('messages').insert({
      contact_id: contactId, role: 'human', content: msg, tenant_id: session.tenant_id,
    });
    if (msgErr) console.warn('[casino/create-player] no se pudo guardar credenciales en el chat:', msgErr.message);
    else        console.log(`[casino/create-player] credenciales guardadas en el chat para ${contactId}`);

    // 2) WhatsApp solo si el contacto tiene teléfono.
    if (contact.phone) {
      try {
        await sendWhatsAppText(contact.phone, msg, session.tenant_id, contact.whatsapp_number_id);
        console.log(`[casino/create-player] WhatsApp de credenciales enviado a ${contact.phone}`);
      } catch (e: any) {
        console.warn('[casino/create-player] WhatsApp de credenciales falló (posible ventana 24h):', e?.message ?? e);
      }
    } else {
      console.warn(`[casino/create-player] contacto ${contactId} sin phone — no se envía WhatsApp (el mensaje quedó en el chat)`);
    }
  } catch (err) {
    console.warn('[casino/create-player] aviso de credenciales falló (ignorado):', err);
  }

  await logActivity({
    session, action: 'casino_create_player', objectType: 'contact', objectId: contactId,
    details: { username },
  });

  return NextResponse.json({ success: true, username, password });
}
