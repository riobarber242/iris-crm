import { supabaseAdmin } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { irisSystemPrompt } from '@/lib/system-prompt';

// ─────────────────────────────────────────────────────────────────────────────
// Alta de un agente nuevo (tenant + usuario agente + system_prompt + operadores).
//
// Esta lógica está DELIBERADAMENTE separada del punto de entrada (la API route
// del wizard admin). `createAgentOnboarding` no sabe nada de cookies, sesiones
// ni de la UI: recibe datos planos y crea todo. Así, el día que exista un alta
// self-service pública, se reutiliza esta misma función desde otra route sin
// reescribir nada.
//
// Atomicidad: el proyecto no tiene RPC/exec_sql, así que la transacción se
// emula a nivel app. Si algo falla DESPUÉS de crear el tenant, borramos el
// tenant y el `ON DELETE CASCADE` (agents.tenant_id y settings.tenant_id) limpia
// el usuario, los operadores y el system_prompt. No queda nada a medias.
// ─────────────────────────────────────────────────────────────────────────────

export type OnboardingOperatorInput = {
  username: string;
  password: string;
  name?: string;
};

export type OnboardingInput = {
  business:  { name: string; email?: string | null };
  agent:     { username: string; password: string };
  systemPrompt?: string | null;
  whatsapp?: { phoneId?: string | null; wabaId?: string | null; displayNumber?: string | null; accessToken?: string | null };
  operators?: OnboardingOperatorInput[];
};

export type CreatedCredential = {
  id:       string;
  username: string;
  password: string; // texto plano — se devuelve UNA vez para mostrar/copiar
  role:     'agent' | 'operator';
  name:     string;
};

export type OnboardingResult = {
  tenant:    { id: string; name: string };
  agent:     CreatedCredential;
  operators: CreatedCredential[];
  warnings:  string[];
};

// Error de negocio (validación / unicidad). El campo `field` permite a la UI
// resaltar el paso/input culpable. Se distingue de errores inesperados.
export class OnboardingError extends Error {
  field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = 'OnboardingError';
    this.field = field;
  }
}

function normUsername(u: string): string {
  return String(u ?? '').trim().toLowerCase();
}

// PostgREST devuelve estos errores cuando la columna no existe todavía (la
// migración supabase-onboarding-wizard.sql no se corrió). Lo detectamos para
// degradar con elegancia en vez de romper el alta entera.
function isMissingWhatsappColumnError(error: any): boolean {
  if (!error) return false;
  const code = String(error.code ?? '');
  const msg  = String(error.message ?? '');
  if (code === '42703' || code === 'PGRST204') {
    return /whatsapp_waba_id|whatsapp_display_number|schema cache|column/i.test(msg);
  }
  return false;
}

// Valida la forma del input y normaliza. Lanza OnboardingError con el primer
// problema encontrado (mensaje claro + campo).
export function validateOnboarding(input: OnboardingInput): {
  businessName: string;
  businessEmail: string | null;
  agentUsername: string;
  agentPassword: string;
  systemPrompt: string;
  whatsapp: { phoneId: string | null; wabaId: string | null; displayNumber: string | null; accessToken: string | null };
  operators: { username: string; password: string; name: string }[];
} {
  const businessName = String(input.business?.name ?? '').trim();
  if (!businessName) throw new OnboardingError('Falta el nombre del negocio', 'business.name');

  const businessEmail = String(input.business?.email ?? '').trim() || null;
  if (businessEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(businessEmail)) {
    throw new OnboardingError('El email de contacto no es válido', 'business.email');
  }

  const agentUsername = normUsername(input.agent?.username ?? '');
  if (!agentUsername) throw new OnboardingError('Falta el usuario del agente', 'agent.username');

  const agentPassword = String(input.agent?.password ?? '');
  if (agentPassword.length < 6) {
    throw new OnboardingError('La contraseña del agente debe tener al menos 6 caracteres', 'agent.password');
  }

  const systemPrompt = (input.systemPrompt != null ? String(input.systemPrompt) : '').trim() || irisSystemPrompt;

  const whatsapp = {
    phoneId:       String(input.whatsapp?.phoneId ?? '').trim() || null,
    wabaId:        String(input.whatsapp?.wabaId ?? '').trim() || null,
    displayNumber: String(input.whatsapp?.displayNumber ?? '').trim() || null,
    accessToken:   String(input.whatsapp?.accessToken ?? '').trim() || null,
  };

  const operators: { username: string; password: string; name: string }[] = [];
  for (const [i, op] of (input.operators ?? []).entries()) {
    const username = normUsername(op?.username ?? '');
    const password = String(op?.password ?? '');
    // Operador completamente vacío → lo ignoramos (el wizard puede dejar filas).
    if (!username && !password && !String(op?.name ?? '').trim()) continue;
    if (!username) throw new OnboardingError(`El operador #${i + 1} no tiene usuario`, `operators.${i}.username`);
    if (password.length < 6) {
      throw new OnboardingError(`La contraseña del operador "${username}" debe tener al menos 6 caracteres`, `operators.${i}.password`);
    }
    operators.push({ username, password, name: String(op?.name ?? '').trim() || username });
  }

  // Usuarios duplicados DENTRO del propio payload (agente vs operadores, o
  // operadores entre sí) — la DB lo rechazaría igual, pero mejor un error claro.
  const allUsernames = [agentUsername, ...operators.map(o => o.username)];
  const dup = allUsernames.find((u, idx) => allUsernames.indexOf(u) !== idx);
  if (dup) throw new OnboardingError(`El usuario "${dup}" está repetido en el formulario`, 'duplicate');

  return { businessName, businessEmail, agentUsername, agentPassword, systemPrompt, whatsapp, operators };
}

// Chequea contra la DB que ni los usernames ni el email choquen con agentes
// existentes (de cualquier tenant: el username es único global). Lanza
// OnboardingError si hay colisión, antes de crear nada.
async function assertCredentialsAvailable(usernames: string[], email: string | null): Promise<void> {
  const { data: existingUsers, error } = await supabaseAdmin
    .from('agents')
    .select('username')
    .in('username', usernames);
  if (error) throw new Error(`No se pudo verificar usuarios: ${error.message}`);
  if (existingUsers && existingUsers.length > 0) {
    const taken = existingUsers[0].username;
    throw new OnboardingError(`El usuario "${taken}" ya existe`, 'username');
  }

  if (email) {
    const { data: existingEmail, error: emailErr } = await supabaseAdmin
      .from('agents')
      .select('id')
      .eq('email', email)
      .limit(1)
      .maybeSingle();
    if (emailErr) throw new Error(`No se pudo verificar el email: ${emailErr.message}`);
    if (existingEmail) throw new OnboardingError(`El email "${email}" ya está en uso`, 'business.email');
  }
}

export async function createAgentOnboarding(input: OnboardingInput): Promise<OnboardingResult> {
  const v = validateOnboarding(input);
  const warnings: string[] = [];

  await assertCredentialsAvailable([v.agentUsername, ...v.operators.map(o => o.username)], v.businessEmail);

  // ── 1. Tenant ──────────────────────────────────────────────────────────────
  // Intentamos con las columnas de WhatsApp; si la migración no corrió, las
  // omitimos y avisamos (degradación elegante, sin romper el alta).
  const tenantBase: Record<string, any> = { name: v.businessName };
  if (v.whatsapp.phoneId)     tenantBase.whatsapp_phone_id     = v.whatsapp.phoneId;
  // whatsapp_access_token existe desde la migración inicial (no degrada).
  if (v.whatsapp.accessToken) tenantBase.whatsapp_access_token = v.whatsapp.accessToken;
  const tenantFull: Record<string, any> = { ...tenantBase };
  if (v.whatsapp.wabaId)        tenantFull.whatsapp_waba_id        = v.whatsapp.wabaId;
  if (v.whatsapp.displayNumber) tenantFull.whatsapp_display_number = v.whatsapp.displayNumber;

  let res = await supabaseAdmin.from('tenants').insert(tenantFull).select('id, name').single();
  if (res.error && isMissingWhatsappColumnError(res.error) && (v.whatsapp.wabaId || v.whatsapp.displayNumber)) {
    // Reintento sin las columnas nuevas.
    res = await supabaseAdmin.from('tenants').insert(tenantBase).select('id, name').single();
    warnings.push('No se guardaron WABA ID ni número visible: faltan columnas en la base. Corré supabase-onboarding-wizard.sql en Supabase y cargalos después editando el agente.');
  }
  if (res.error || !res.data) throw new Error(`No se pudo crear el tenant: ${res.error?.message ?? 'desconocido'}`);
  const tenant: { id: string; name: string } = res.data;

  // A partir de acá, cualquier fallo hace rollback borrando el tenant (cascade).
  try {
    // ── 2. Usuario agente ─────────────────────────────────────────────────────
    const { data: agentRow, error: agentErr } = await supabaseAdmin
      .from('agents')
      .insert({
        username:      v.agentUsername,
        name:          v.businessName,
        email:         v.businessEmail,
        password_hash: hashPassword(v.agentPassword),
        role:          'agent',
        active:        true,
        tenant_id:     tenant.id,
      })
      .select('id, username, name')
      .single();
    if (agentErr || !agentRow) {
      const msg = agentErr?.code === '23505' ? `El usuario "${v.agentUsername}" ya existe` : agentErr?.message;
      throw new OnboardingError(msg ?? 'No se pudo crear el usuario agente', 'agent.username');
    }

    // ── 3. system_prompt en settings ──────────────────────────────────────────
    const { error: settingsErr } = await supabaseAdmin
      .from('settings')
      .insert({ key: 'system_prompt', value: v.systemPrompt, tenant_id: tenant.id });
    if (settingsErr) throw new Error(`No se pudo guardar el system prompt: ${settingsErr.message}`);

    // ── 4. Operadores (batch: todos o ninguno) ────────────────────────────────
    const createdOperators: CreatedCredential[] = [];
    if (v.operators.length > 0) {
      const { data: opRows, error: opErr } = await supabaseAdmin
        .from('agents')
        .insert(v.operators.map(o => ({
          username:      o.username,
          name:          o.name,
          password_hash: hashPassword(o.password),
          role:          'operator',
          active:        true,
          tenant_id:     tenant.id,
        })))
        .select('id, username, name');
      if (opErr || !opRows) {
        const msg = opErr?.code === '23505' ? 'Uno de los usuarios de operador ya existe' : opErr?.message;
        throw new OnboardingError(msg ?? 'No se pudieron crear los operadores', 'operators');
      }
      // Re-asociamos cada fila creada con su contraseña en texto plano.
      for (const o of v.operators) {
        const row = opRows.find((r: { id: string; username: string; name: string }) => r.username === o.username);
        if (row) createdOperators.push({ id: row.id, username: row.username, name: row.name, role: 'operator', password: o.password });
      }
    }

    return {
      tenant:  { id: tenant.id, name: tenant.name },
      agent:   { id: agentRow.id, username: agentRow.username, name: agentRow.name, role: 'agent', password: v.agentPassword },
      operators: createdOperators,
      warnings,
    };
  } catch (err) {
    // Rollback: borrar el tenant arrastra (cascade) usuario, operadores y settings.
    await supabaseAdmin.from('tenants').delete().eq('id', tenant.id);
    throw err;
  }
}
