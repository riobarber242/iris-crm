import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { createPlayer } from '@/lib/casino/client';
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

  const password = generatePassword();

  // Reintento correlativo: si el casino rechaza por usuario ya existente,
  // incrementamos el número (…1js → …2js → …) hasta 20 intentos.
  let result = await createPlayer(username, password);
  let attempts = 0;
  while (!result.success && result.taken && attempts < 20) {
    username = nextUsername(username);
    result = await createPlayer(username, password);
    attempts++;
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

  // Aviso de credenciales: lo guardamos en el chat y lo mandamos por WhatsApp.
  // Best-effort: si algo falla (ventana 24h, etc.), el usuario YA quedó creado y
  // guardado, así que no rompemos la respuesta. La contraseña real (generada
  // arriba) va en el mensaje; queda accesible en el chat.
  if (contact.phone) {
    try {
      const { data: urlRow } = await supabaseAdmin
        .from('settings').select('value')
        .eq('key', 'casino_api_base_url').eq('tenant_id', session.tenant_id).maybeSingle();
      const casinoUrl = String(urlRow?.value ?? process.env.CASINO_API_BASE_URL ?? '').trim();
      const urlLine = casinoUrl ? `Ingresá en ${casinoUrl} y empezá a jugar 🎲` : '¡Ya podés empezar a jugar! 🎲';
      const msg = `🎰 ¡Tu cuenta fue creada!\nUsuario: ${username}\nContraseña: ${password}\n${urlLine}`;

      await supabaseAdmin.from('messages').insert({
        contact_id: contactId, role: 'human', content: msg, tenant_id: session.tenant_id,
      });

      try {
        await sendWhatsAppText(contact.phone, msg, session.tenant_id, contact.whatsapp_number_id);
      } catch {
        console.warn('[casino/create-player] WhatsApp de credenciales falló (posible ventana 24h)');
      }
    } catch (err) {
      console.warn('[casino/create-player] aviso de credenciales falló (ignorado):', err);
    }
  }

  await logActivity({
    session, action: 'casino_create_player', objectType: 'contact', objectId: contactId,
    details: { username },
  });

  return NextResponse.json({ success: true, username, password });
}
