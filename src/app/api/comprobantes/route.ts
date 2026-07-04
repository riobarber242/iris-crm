import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { sendMetaPurchaseEvent } from '@/lib/meta/conversions';
import { sendWhatsAppText } from '@/lib/meta/client';
import { reconcileContactStatus } from '@/lib/contact-status';
import { logActivity, ACTIVITY } from '@/lib/activity-log';
import { aplicarCargaComprobante, aplicarPagoComprobante, editarMovimientoComprobante } from '@/lib/caja';
import { creditPlayer } from '@/lib/casino/client';
import { AUTO_MSG_FLAG_KEY, AUTO_MSG_TEMPLATE_KEY, AUTO_MSG_DEFAULT_TEMPLATE, renderAutoMsg } from '@/lib/auto-msg';
import { insertMessage } from '@/lib/messages';
import type { SessionPayload } from '@/lib/session';

// Bono en fichas (entero). Reglas Etapa 1: vacío → null; 0 o valor inválido →
// null ("0 no se guarda como bono"); entero > 0 → ese valor.
function normalizeBono(raw: any): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// ¿Esta sesión puede editar este comprobante? admin/agent: cualquiera de su
// tenant; operator: solo el que él mismo resolvió (resolved_by === su id).
function canEditComprobante(session: SessionPayload, resolvedBy: string | null | undefined): boolean {
  if (session.role === 'admin' || session.role === 'agent') return true;
  return !!resolvedBy && resolvedBy === session.sub;
}

export async function GET(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const url = new URL(request.url);
  const estado    = url.searchParams.get('estado');
  const tipo      = url.searchParams.get('tipo');      // 'carga' | 'pago' | null (todos)
  const contactId = url.searchParams.get('contactId'); // filtrar por contacto (chat)

  let query = supabaseAdmin
    .from('comprobantes')
    .select('*, contacts(phone, name, casino_username)')
    .eq('tenant_id', session.tenant_id);
  if (estado && estado !== 'all') {
    query = query.eq('estado', estado);
  }
  if (contactId) {
    query = query.eq('contact_id', contactId);
  }
  // Filtro por tipo (Cargas vs Pagos). Los comprobantes históricos tienen
  // tipo='carga' por el default de la columna, así que /cargas los sigue viendo.
  if (tipo === 'carga' || tipo === 'pago') {
    query = query.eq('tipo', tipo);
  }

  let { data, error } = await query.order('created_at', { ascending: false });

  // Degradación elegante: si la columna `tipo` aún no existe (migración sin
  // correr) y se pidió filtrar por tipo, reintentamos sin el filtro para no
  // romper la bandeja.
  if (error && tipo && /tipo|column|schema cache/i.test(error.message)) {
    let retry = supabaseAdmin
      .from('comprobantes')
      .select('*, contacts(phone, name, casino_username)')
      .eq('tenant_id', session.tenant_id);
    if (estado && estado !== 'all') retry = retry.eq('estado', estado);
    if (contactId) retry = retry.eq('contact_id', contactId);
    ({ data, error } = await retry.order('created_at', { ascending: false }));
  }

  if (error) {
    return new NextResponse(error.message, { status: 500 });
  }

  // can_edit por item: el front decide mostrar el botón "Editar" sin conocer el
  // rol; el backend sigue siendo la fuente de verdad (revalida en la acción).
  const withPerms = (data ?? []).map((c: any) => ({
    ...c,
    can_edit: canEditComprobante(session, c.resolved_by),
  }));

  return NextResponse.json(withPerms);
}

// Extrae la URL de imagen del contenido de un mensaje. Cubre el formato media
// JSON ({_type:'image', url}) y los mensajes viejos guardados como URL pelada.
function imageUrlFromMessage(content: string | null): string | null {
  const c = (content ?? '').trim();
  if (!c) return null;
  try {
    const p = JSON.parse(c);
    if ((p?._type === 'image' || p?._type === 'document') && typeof p.url === 'string') return p.url;
  } catch {}
  if (/^https?:\/\//i.test(c) && /\.(jpe?g|png|webp|gif|pdf)(\?|$)/i.test(c)) return c;
  return null;
}

// POST: "Enviar a verificar" desde la conversación. Crea un comprobante a partir
// de un mensaje con imagen del chat. El tipo se deriva del rol del mensaje:
//   entrante (role 'user', la mandó el cliente)        → 'carga'  (bandeja Cargas)
//   saliente (role 'human'/'assistant', la mandamos)   → 'pago'   (bandeja Pagos)
// Anti-duplicado: un mensaje genera UN solo comprobante (source_message_id único).
export async function POST(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const body = await request.json().catch(() => ({}));
  const messageId = body.messageId;
  if (!messageId) return new NextResponse('Falta messageId', { status: 400 });

  // El mensaje debe ser de este tenant (defensa server-side).
  const { data: msg, error: msgErr } = await supabaseAdmin
    .from('messages')
    .select('id, contact_id, role, content')
    .eq('id', messageId)
    .eq('tenant_id', session.tenant_id)
    .single();
  if (msgErr || !msg) return new NextResponse('Mensaje no encontrado', { status: 404 });

  const imageUrl = imageUrlFromMessage(msg.content);
  if (!imageUrl) return new NextResponse('El mensaje no tiene un archivo para verificar', { status: 400 });

  // Tipo según quién mandó la imagen (defensa server-side, espeja el front):
  //   cliente (role 'user')          → carga  (bandeja Cargas)
  //   staff   (role 'human')         → pago   (bandeja Pagos)
  //   bot     (role 'assistant')/otro → no se puede mandar a verificar.
  let tipo: 'carga' | 'pago';
  if (msg.role === 'user') tipo = 'carga';
  else if (msg.role === 'human') tipo = 'pago';
  else return new NextResponse('Solo se pueden verificar imágenes del cliente o del equipo', { status: 400 });

  // Anti-duplicado: si ya se mandó a verificar este mensaje, devolvemos el
  // comprobante existente (idempotente; el front muestra "En verificación").
  {
    const { data: existing } = await supabaseAdmin
      .from('comprobantes')
      .select('*')
      .eq('tenant_id', session.tenant_id)
      .eq('source_message_id', messageId)
      .maybeSingle();
    if (existing) return NextResponse.json({ ...existing, duplicate: true });
  }

  const insertPayload: Record<string, any> = {
    contact_id:        msg.contact_id,
    image_url:         imageUrl,
    monto:             0,
    estado:            'pendiente',
    tipo,
    source_message_id: messageId,
    tenant_id:         session.tenant_id,
  };

  let { data, error } = await supabaseAdmin
    .from('comprobantes').insert(insertPayload).select('*').single();

  // Degradación elegante: si faltan columnas nuevas (tipo/source_message_id)
  // porque las migraciones no se corrieron, reintentamos sin ellas. Sin
  // source_message_id NO hay anti-duplicado persistente, pero no rompemos.
  if (error && /tipo|source_message_id|column|schema cache/i.test(error.message)) {
    ({ data, error } = await supabaseAdmin
      .from('comprobantes')
      .insert({ contact_id: msg.contact_id, image_url: imageUrl, monto: 0, estado: 'pendiente', tenant_id: session.tenant_id })
      .select('*').single());
  }
  if (error) return new NextResponse(error.message, { status: 500 });

  await logActivity({
    session,
    action:     ACTIVITY.COMPROBANTE_ENVIADO,
    objectType: 'comprobante',
    objectId:   data.id,
    details:    { tipo, contact_id: msg.contact_id, source_message_id: messageId },
  });

  return NextResponse.json(data, { status: 201 });
}

export async function PATCH(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const body = await request.json();
  const comprobanteId = body.comprobanteId;
  const action = body.action;

  if (!comprobanteId || !['verificar', 'rechazar', 'update_monto', 'editar'].includes(action)) {
    return new NextResponse('Faltan comprobanteId o acción válida', { status: 400 });
  }

  // editar: cambia monto y/o bono de un comprobante ya resuelto (botón "Editar").
  // No toca estado ni la atribución de verificación; sí registra quién editó.
  if (action === 'editar') {
    const monto = Number(body.monto);
    if (isNaN(monto) || monto <= 0) {
      return new NextResponse('Monto inválido', { status: 400 });
    }
    const bono = normalizeBono(body.bono);

    const { data: prev, error: prevErr } = await supabaseAdmin
      .from('comprobantes').select('*').eq('id', comprobanteId).eq('tenant_id', session.tenant_id).single();
    if (prevErr || !prev) {
      return new NextResponse('Comprobante no encontrado', { status: 404 });
    }

    // Permiso: admin/agent cualquiera; operator solo el que él resolvió.
    if (!canEditComprobante(session, prev.resolved_by)) {
      return new NextResponse('No tenés permiso para editar este comprobante', { status: 403 });
    }

    // Etapa 3: un comprobante tiene UN solo movimiento neto. Al editar,
    // revertimos el anterior y reaplicamos con los valores nuevos (no se crea
    // un segundo movimiento). Consistencia: si el reajuste falla (ej. sin
    // fichas), abortamos y NO persistimos la edición. El tipo/pago_agente del
    // comprobante decide los deltas (carga con bono, pago, o pago del agente).
    const movEdit = await editarMovimientoComprobante(session, {
      comprobanteId, monto, bono,
      tipo:       prev.tipo === 'pago' ? 'pago' : 'carga',
      pagoAgente: !!prev.pago_agente,
    });
    if (!movEdit.ok) return new NextResponse(movEdit.error, { status: 400 });

    const editPayload: Record<string, any> = {
      monto,
      bono,
      edited_by:      session.sub,
      edited_by_name: session.name,
      edited_at:      new Date().toISOString(),
    };

    let { data, error } = await supabaseAdmin
      .from('comprobantes').update(editPayload).eq('id', comprobanteId).eq('tenant_id', session.tenant_id).select('*').single();

    // Degradación elegante: si faltan columnas nuevas (bono/edited_*) porque la
    // migración supabase-bono-comprobante.sql no se corrió, reintentamos solo
    // con monto para no romper la edición.
    if (error && /bono|edited_by|edited_at|column|schema cache/i.test(error.message)) {
      ({ data, error } = await supabaseAdmin
        .from('comprobantes').update({ monto }).eq('id', comprobanteId).eq('tenant_id', session.tenant_id).select('*').single());
    }
    if (error) return new NextResponse(error.message, { status: 500 });

    await logActivity({
      session,
      action:     ACTIVITY.COMPROBANTE_EDITADO,
      objectType: 'comprobante',
      objectId:   comprobanteId,
      details: {
        antes:   { monto: prev.monto ?? null, bono: prev.bono ?? null },
        despues: { monto, bono },
        contact_id: prev.contact_id,
      },
    });

    return NextResponse.json(data);
  }

  // update_monto: only update monto, no estado change
  if (action === 'update_monto') {
    const monto = Number(body.monto);
    if (isNaN(monto) || monto <= 0) {
      return new NextResponse('Monto inválido', { status: 400 });
    }
    const { data, error } = await supabaseAdmin
      .from('comprobantes').update({ monto }).eq('id', comprobanteId).eq('tenant_id', session.tenant_id).select('*').single();
    if (error) return new NextResponse(error.message, { status: 500 });
    return NextResponse.json(data);
  }

  const estado = action === 'verificar' ? 'verificado' : 'rechazado';

  const { data: comprobante, error: fetchError } = await supabaseAdmin
    .from('comprobantes').select('*').eq('id', comprobanteId).eq('tenant_id', session.tenant_id).single();
  if (fetchError || !comprobante) {
    return new NextResponse('Comprobante no encontrado', { status: 404 });
  }

  // Accept optional monto from operator input
  const updatePayload: Record<string, any> = { estado };
  if (body.monto !== undefined) {
    const parsed = Number(body.monto);
    if (!isNaN(parsed) && parsed >= 0) updatePayload.monto = parsed;
  }
  // Bono (fichas) cargado a mano al verificar. Solo dato en Etapa 1.
  if (action === 'verificar' && body.bono !== undefined) {
    updatePayload.bono = normalizeBono(body.bono);
  }

  // Atribución permanente: quién resolvió (verificó/rechazó) este comprobante.
  updatePayload.resolved_by      = session.sub;
  updatePayload.resolved_by_name = session.name;
  updatePayload.resolved_at      = new Date().toISOString();

  // Monto/bono efectivos que quedarán guardados (input del operador o lo previo).
  const efectiveMonto = updatePayload.monto ?? comprobante.monto;
  const efectiveBono  = updatePayload.bono !== undefined ? updatePayload.bono : (comprobante.bono ?? null);

  // Etapa 3/4a: si la caja está activa, aplicar el movimiento ANTES de marcar
  // verificado. Consistencia: si el movimiento falla (sin fichas / sin saldo en
  // billetera), NO se verifica. Branch por tipo:
  //   carga → fichas -(monto+bono), billetera del verificador +monto.
  //   pago  → fichas +monto, billetera del verificador -monto (guard de saldo).
  //           Si es pago del agente (pago_agente), la billetera no se toca.
  if (estado === 'verificado') {
    const esPago = comprobante.tipo === 'pago';

    // ¿Casino habilitado para el tenant? Con el casino activo, el "stock" es el
    // saldo del casino (no el pozo interno de fichas). Leemos el flag UNA sola
    // vez acá y lo reusamos para el gate del depósito más abajo.
    const { data: casinoFlagRow } = await supabaseAdmin
      .from('settings').select('value')
      .eq('key', 'casino_deposit_enabled').eq('tenant_id', session.tenant_id).maybeSingle();
    const casinoDepositEnabled = casinoFlagRow?.value === 'true';

    // Movimiento de caja interno. Con el casino habilitado el pozo NO se toca
    // (fichas_delta=0): la carga acredita la billetera del operador (+monto) y el
    // pago la descuenta (-monto). El crédito real al jugador lo hace creditPlayer
    // más abajo. Sin casino, flujo normal (pozo + billetera).
    const movRes = esPago
      ? await aplicarPagoComprobante(session, {
          comprobanteId,
          monto:        Number(efectiveMonto ?? 0),
          pagoAgente:   !!comprobante.pago_agente,
          casinoEnabled: casinoDepositEnabled,
        })
      : await aplicarCargaComprobante(session, {
          comprobanteId,
          tipo:  comprobante.tipo,
          monto: Number(efectiveMonto ?? 0),
          bono:  efectiveBono,
          casinoEnabled: casinoDepositEnabled,
        });
    if (!movRes.ok) return new NextResponse(movRes.error, { status: 400 });

    // Integración casino (celuapuestas): al verificar una CARGA, acreditar al
    // player con creditPlayer (lookup de targetId + DoDeposit). Si falla, NO se
    // verifica (sin reintentos automáticos). Se conserva el kill switch
    // (casino_deposit_enabled) y la idempotencia (casino_deposited_at).
    if (!esPago && !comprobante.casino_deposited_at) {
      const montoCasino = Number(efectiveMonto ?? 0);
      // El bono (fichas) se acredita al player JUNTO con el monto. El gate sigue
      // siendo montoCasino > 0: solo depositamos si hay recarga real; el bono suma.
      const bonoCasino  = Number(efectiveBono) || 0;
      const montoTotal  = montoCasino + bonoCasino;
      if (casinoDepositEnabled && montoCasino > 0) {
        // El username del player = contacts.name. El PATCH trae el comprobante con
        // select('*') (sin join), así que el nombre se busca aparte.
        const { data: ct } = await supabaseAdmin
          .from('contacts').select('name, casino_username')
          .eq('id', comprobante.contact_id).eq('tenant_id', session.tenant_id).maybeSingle();
        const username = String(ct?.casino_username ?? ct?.name ?? '').trim();
        if (!username) {
          return new NextResponse('El contacto no tiene nombre para acreditar en el casino.', { status: 400 });
        }
        const cred = await creditPlayer(username, montoTotal);
        if (!cred.success) {
          return new NextResponse(cred.error ?? 'No se pudo acreditar en el casino. La recarga NO se verificó.', { status: 400 });
        }
        updatePayload.casino_deposited_at = new Date().toISOString();
        await logActivity({
          session, action: ACTIVITY.CASINO_DEPOSIT, objectType: 'comprobante', objectId: comprobanteId,
          details: { ok: true, username, amount: montoTotal, monto: montoCasino, bono: bonoCasino },
        });
      }
    }
  }

  let { data, error } = await supabaseAdmin
    .from('comprobantes').update(updatePayload).eq('id', comprobanteId).eq('tenant_id', session.tenant_id).select('*').single();

  // Degradación elegante: si las columnas resolved_* aún no existen (migración
  // supabase-activity-log.sql sin correr), reintentamos sin ellas para no romper
  // la verificación/rechazo. El log igual queda registrado abajo.
  if (error && /resolved_by|resolved_at|column|schema cache/i.test(error.message)) {
    const fallback: Record<string, any> = { estado };
    if (updatePayload.monto !== undefined) fallback.monto = updatePayload.monto;
    if (updatePayload.casino_deposited_at !== undefined) fallback.casino_deposited_at = updatePayload.casino_deposited_at;
    if (updatePayload.casino_deposit_ref  !== undefined) fallback.casino_deposit_ref  = updatePayload.casino_deposit_ref;
    ({ data, error } = await supabaseAdmin
      .from('comprobantes').update(fallback).eq('id', comprobanteId).eq('tenant_id', session.tenant_id).select('*').single());
  }
  if (error) return new NextResponse(error.message, { status: 500 });

  // ── Reconciliar status del contacto con la regla de 3 estados ──
  // (nuevo / cliente_activo este mes / inactivo). Misma lógica que el cron.
  // El pago manual del agente puede no tener contacto → se omite.
  if (comprobante.contact_id) {
    await reconcileContactStatus(comprobante.contact_id);
  }

  // Registro de actividad (al costado; no traba la respuesta).
  await logActivity({
    session,
    action:     estado === 'verificado' ? ACTIVITY.COMPROBANTE_VERIFICADO : ACTIVITY.COMPROBANTE_RECHAZADO,
    objectType: 'comprobante',
    objectId:   comprobanteId,
    details:    { estado, monto: efectiveMonto ?? null, contact_id: comprobante.contact_id },
  });

  // Pixel de compra + aviso "Tu recarga fue confirmada": SOLO para cargas (es una
  // recarga del cliente). Los pagos son salidas hacia el cliente/agente: no
  // disparan evento de compra ni el mensaje de recarga.
  if (estado === 'verificado' && efectiveMonto && comprobante.tipo !== 'pago' && comprobante.contact_id) {
    const { data: contact, error: contactError } = await supabaseAdmin
      .from('contacts').select('phone, whatsapp_number_id').eq('id', comprobante.contact_id).eq('tenant_id', session.tenant_id).single();
    if (!contactError && contact?.phone) {
      // Fire-and-forget: Meta Pixel purchase event
      sendMetaPurchaseEvent(contact.phone, Number(efectiveMonto)).catch(() => {});

      // Auto-notificación (flag on/off + template editable). Default: activado,
      // con el texto histórico. Una sola query trae flag y template.
      const { data: settingRows } = await supabaseAdmin
        .from('settings').select('key, value')
        .eq('tenant_id', session.tenant_id)
        .in('key', [AUTO_MSG_FLAG_KEY, AUTO_MSG_TEMPLATE_KEY]);
      const settingsByKey = new Map((settingRows ?? []).map((r: any) => [r.key, r.value]));
      const autoMsg = settingsByKey.get(AUTO_MSG_FLAG_KEY) !== 'false';

      if (autoMsg) {
        const montoFmt = Number(efectiveMonto).toLocaleString('es-AR');
        const template = (settingsByKey.get(AUTO_MSG_TEMPLATE_KEY) as string | undefined)?.trim() || AUTO_MSG_DEFAULT_TEMPLATE;
        let msg = renderAutoMsg(template, montoFmt);
        // Si hubo bono, se lo sumamos al aviso (sufijo fijo, no editable por ahora).
        const bonoNotif = Number(efectiveBono) || 0;
        if (bonoNotif > 0) {
          msg += ` + $${bonoNotif.toLocaleString('es-AR')} de regalo 🎁`;
        }
        // await: en serverless, un fire-and-forget no await-eado puede no
        // completarse porque el runtime suspende la instancia al retornar.
        try {
          await sendWhatsAppText(contact.phone, msg, session.tenant_id, contact.whatsapp_number_id);
          // Registrar el aviso en el chat (mismo patrón que campañas: mensaje
          // 'human' enviado por el sistema, sin atribución a un agente).
          await insertMessage({
            contact_id: comprobante.contact_id,
            role:       'human',
            content:    msg,
            tenant_id:  session.tenant_id,
          });
        } catch {
          console.warn('[comprobantes] Auto-notificación WA falló (posible ventana 24h)');
        }
      }
    }
  }

  return NextResponse.json(data);
}

// DELETE /api/comprobantes?id=<uuid> — borra un comprobante del tenant.
// Scope estricto por tenant_id (no se puede borrar uno de otro tenant).
export async function DELETE(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const id = new URL(request.url).searchParams.get('id')?.trim();
  if (!id) return NextResponse.json({ error: 'Falta el id del comprobante.' }, { status: 400 });

  // Debe existir en este tenant (defensa server-side + para loguear el tipo).
  const { data: existing } = await supabaseAdmin
    .from('comprobantes')
    .select('id, tipo, contact_id')
    .eq('id', id)
    .eq('tenant_id', session.tenant_id)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json({ error: 'Comprobante no encontrado.' }, { status: 404 });
  }

  const { error } = await supabaseAdmin
    .from('comprobantes')
    .delete()
    .eq('id', id)
    .eq('tenant_id', session.tenant_id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await logActivity({
    session,
    action:     'comprobante_eliminado',
    objectType: 'comprobante',
    objectId:   id,
    details:    { tipo: existing.tipo ?? null, contact_id: existing.contact_id ?? null },
  });

  return NextResponse.json({ ok: true });
}
