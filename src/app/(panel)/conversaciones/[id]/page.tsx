export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import ChatWindow from '@/components/ChatWindow';
import ContactHeader from '@/components/ContactHeader';
import { formatRelativeTime } from '@/lib/formatRelativeTime';

async function fetchContact(id: string) {
  const { data, error } = await supabaseAdmin
    .from('contacts')
    .select('id, name, phone, status, blocked, casino_username, conversation_state, notes, provincia, assigned_agent_id, tenant_id, last_seen_by, last_seen_at, messages(content, created_at, role)')
    .eq('id', id)
    .single();

  if (error) return null;
  return data;
}

async function fetchRecargasResumen(contactId: string) {
  const { data } = await supabaseAdmin
    .from('comprobantes')
    .select('monto')
    .eq('contact_id', contactId)
    .eq('estado', 'verificado');

  const items = data ?? [];
  return {
    count:      items.length,
    montoTotal: items.reduce((s: number, r: any) => s + Number(r.monto ?? 0), 0),
  };
}

export default async function ConversationPage({ params }: any) {
  const id = params.id as string;

  const session = await getSessionAgent();
  const contact = await fetchContact(id);

  // Acceso por TENANT: admin, agente y operador pueden abrir cualquier
  // conversación de su tenant (la asignación es solo una etiqueta, no restringe).
  if (!session || !contact || contact.tenant_id !== session.tenant_id) {
    return (
      <div style={{ padding: '32px', textAlign: 'center', color: '#999' }}>
        {contact ? 'No tenés acceso a esta conversación.' : 'Contacto no encontrado.'}
      </div>
    );
  }

  // "Visto por X": resolvemos el nombre del operador que vio ESTA conversación
  // por última vez ANTES de esta apertura (fetchContact ya corrió arriba, así
  // que `last_seen_by` todavía refleja la visita previa). Tenant-scoped.
  let vistoPor: string | null = null;
  if (contact.last_seen_by && contact.last_seen_at) {
    const { data: seenAgent } = await supabaseAdmin
      .from('agents')
      .select('name')
      .eq('id', contact.last_seen_by)
      .eq('tenant_id', session.tenant_id)
      .maybeSingle();
    if (seenAgent?.name) vistoPor = seenAgent.name;
  }

  // Mark as read server-side so badge clears on next poll. De paso registramos
  // el "visto" (quién/ cuándo) y filtramos por tenant_id (además del id).
  // human_taken=true: abrir la conversación = "ya la agarró un humano"; de acá en
  // más cualquier mensaje nuevo entrante se muestra en 🔴 (nunca vuelve a 🟠).
  const nowIso = new Date().toISOString();
  await supabaseAdmin
    .from('contacts')
    .update({ last_read_at: nowIso, last_seen_by: session.sub, last_seen_at: nowIso, human_taken: true })
    .eq('id', id)
    .eq('tenant_id', session.tenant_id);

  const recargas = await fetchRecargasResumen(id);

  // ¿El casino está activado para este tenant? Gatea el botón "Crear usuario
  // casino" en el header (mismo flag que usa /api/casino/balance).
  const { data: casinoFlag } = await supabaseAdmin
    .from('settings').select('value')
    .eq('key', 'casino_deposit_enabled').eq('tenant_id', session.tenant_id).maybeSingle();
  const casinoDepositEnabled = casinoFlag?.value === 'true';

  return (
    <div className="chat-page-fill">

      {/* Back button */}
      <div style={{ flexShrink: 0 }}>
        <Link
          href="/conversaciones"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '14px',
            fontWeight: 600,
            color: '#555',
            textDecoration: 'none',
            background: '#fff',
            border: '1px solid #e0e0e0',
            borderRadius: '10px',
            padding: '4px 14px',
          }}
        >
          ← Conversaciones
        </Link>
      </div>

      {vistoPor && contact.last_seen_at && (
        <div style={{ flexShrink: 0, fontSize: '12px', color: '#999', padding: '2px 4px' }}>
          👁 Visto por {vistoPor} · {formatRelativeTime(contact.last_seen_at)}
        </div>
      )}

      <div style={{ flexShrink: 0 }}>
        <ContactHeader
          contactId={contact.id}
          phone={contact.phone}
          contactName={contact.name ?? null}
          casinoDepositEnabled={casinoDepositEnabled}
          initialCasinoUsername={contact.casino_username}
          initialBlocked={contact.blocked ?? false}
          initialStatus={contact.status ?? 'nuevo'}
          conversationState={contact.conversation_state ?? null}
          initialNotes={contact.notes ?? ''}
          initialProvincia={contact.provincia ?? null}
          initialAssignedAgentId={contact.assigned_agent_id ?? null}
          recargasCount={recargas.count}
          recargasMonto={recargas.montoTotal}
        />
      </div>

      {/* Ocupa el resto de la altura; ChatWindow scrollea adentro. */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <ChatWindow
          contactId={contact.id}
          casinoDepositEnabled={casinoDepositEnabled}
          casinoUsername={contact.casino_username}
          contactName={contact.name ?? null}
        />
      </div>

    </div>
  );
}
