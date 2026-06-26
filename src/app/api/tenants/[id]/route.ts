import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { requireAdmin } from '@/lib/current-agent';
import { hashPassword } from '@/lib/auth';

const TENANT_FIELDS =
  'id, name, whatsapp_phone_id, whatsapp_access_token, whatsapp_waba_id, whatsapp_display_number, created_at, ' +
  'plan, status, monthly_amount, trial_ends_at, paid_until, skin, notes';

const MAX_PROMPT = 4000;

// Valores permitidos para los selectores de membresía (defensa server-side: el
// front solo ofrece estos, pero validamos igual).
const PLANS   = ['trial', 'basic', 'premium'];
const STATUSES = ['active', 'suspended', 'cancelled'];
const SKINS   = ['casino', 'loteria', 'barberia'];

// PATCH /api/tenants/[id] — editar tenant (admin)
// Campos editables (todos opcionales; solo se tocan los que vienen en el body):
//   name, whatsapp_phone_id, whatsapp_access_token, waba_id, numero_visible
//     → columnas escalares en `tenants`
//   system_prompt → upsert en `settings` (key='system_prompt', por tenant)
//   nueva_password → re-hash (scrypt) del agente rol='agent' de este tenant
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Requiere rol admin' }, { status: 403 });
  }

  const { id } = await params;
  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  // ── 1. Columnas escalares de tenants ──────────────────────────────────────
  const updates: Record<string, any> = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return NextResponse.json({ error: 'El nombre no puede quedar vacío' }, { status: 400 });
    updates.name = name;
  }
  if (body.whatsapp_phone_id !== undefined)     updates.whatsapp_phone_id      = String(body.whatsapp_phone_id).trim() || null;
  if (body.whatsapp_access_token !== undefined) updates.whatsapp_access_token  = String(body.whatsapp_access_token).trim() || null;
  if (body.waba_id !== undefined)               updates.whatsapp_waba_id       = String(body.waba_id).trim() || null;
  if (body.numero_visible !== undefined)        updates.whatsapp_display_number = String(body.numero_visible).trim() || null;

  // ── Campos de membresía (panel de admin) ──────────────────────────────────
  if (body.plan !== undefined) {
    const plan = String(body.plan).trim();
    if (!PLANS.includes(plan)) return NextResponse.json({ error: `Plan inválido (esperado: ${PLANS.join(', ')})` }, { status: 400 });
    updates.plan = plan;
  }
  if (body.status !== undefined) {
    const status = String(body.status).trim();
    if (!STATUSES.includes(status)) return NextResponse.json({ error: `Estado inválido (esperado: ${STATUSES.join(', ')})` }, { status: 400 });
    updates.status = status;
  }
  if (body.skin !== undefined) {
    const skin = String(body.skin).trim();
    if (!SKINS.includes(skin)) return NextResponse.json({ error: `Skin inválido (esperado: ${SKINS.join(', ')})` }, { status: 400 });
    updates.skin = skin;
  }
  if (body.monthly_amount !== undefined) {
    const amount = Math.trunc(Number(body.monthly_amount));
    if (!Number.isFinite(amount) || amount < 0) return NextResponse.json({ error: 'El monto mensual debe ser un entero ≥ 0' }, { status: 400 });
    updates.monthly_amount = amount;
  }
  if (body.paid_until !== undefined) {
    const raw = String(body.paid_until).trim();
    if (!raw) {
      updates.paid_until = null;
    } else if (Number.isNaN(Date.parse(raw))) {
      return NextResponse.json({ error: 'Fecha de "paga hasta" inválida' }, { status: 400 });
    } else {
      updates.paid_until = raw;
    }
  }
  if (body.notes !== undefined) {
    updates.notes = String(body.notes).trim() || null;
  }

  // ── 2. system_prompt (tabla settings, por tenant) ─────────────────────────
  const hasSystemPrompt = body.system_prompt !== undefined;
  let systemPrompt = '';
  if (hasSystemPrompt) {
    systemPrompt = String(body.system_prompt);
    if (systemPrompt.length > MAX_PROMPT) {
      return NextResponse.json({ error: `El system prompt no puede superar ${MAX_PROMPT} caracteres` }, { status: 400 });
    }
  }

  // ── 3. nueva_password (re-hash del agente del tenant) ─────────────────────
  const hasNewPassword = body.nueva_password !== undefined && String(body.nueva_password).length > 0;
  if (hasNewPassword && String(body.nueva_password).length < 6) {
    return NextResponse.json({ error: 'La contraseña debe tener al menos 6 caracteres' }, { status: 400 });
  }

  if (Object.keys(updates).length === 0 && !hasSystemPrompt && !hasNewPassword) {
    return NextResponse.json({ error: 'Nada para actualizar' }, { status: 400 });
  }

  // Aplica el update de columnas (si hay). Si no, igual validamos que el tenant exista.
  if (Object.keys(updates).length > 0) {
    const { error } = await supabaseAdmin.from('tenants').update(updates).eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // system_prompt: upsert sobre el índice único (key, tenant_id).
  if (hasSystemPrompt) {
    const { error } = await supabaseAdmin
      .from('settings')
      .upsert({ tenant_id: id, key: 'system_prompt', value: systemPrompt }, { onConflict: 'key,tenant_id' });
    if (error) return NextResponse.json({ error: `No se pudo guardar el system prompt: ${error.message}` }, { status: 400 });
  }

  // nueva_password: actualiza el agente rol='agent' de este tenant.
  if (hasNewPassword) {
    const { data: agentRow, error: findErr } = await supabaseAdmin
      .from('agents')
      .select('id')
      .eq('tenant_id', id)
      .eq('role', 'agent')
      .limit(1)
      .maybeSingle();
    if (findErr) return NextResponse.json({ error: findErr.message }, { status: 400 });
    if (!agentRow) return NextResponse.json({ error: 'Este agente no tiene un usuario de acceso para resetear' }, { status: 400 });

    const { error: pwErr } = await supabaseAdmin
      .from('agents')
      .update({ password_hash: hashPassword(String(body.nueva_password)) })
      .eq('id', agentRow.id);
    if (pwErr) return NextResponse.json({ error: pwErr.message }, { status: 400 });
  }

  // Devolvemos el tenant fresco (con las columnas que el modal necesita).
  const { data, error: readErr } = await supabaseAdmin
    .from('tenants')
    .select(TENANT_FIELDS)
    .eq('id', id)
    .single();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 400 });
  return NextResponse.json(data);
}
