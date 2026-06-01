import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

// Returns two pending-attention counts:
// newPending      (orange): no casino_username, bot finished, last msg inbound
// recurringPending (red):   has casino_username, last msg inbound
export async function GET() {
  try {
    const ART_OFFSET_MS = 3 * 60 * 60 * 1000;
    const utcNow     = new Date();
    const argNow     = new Date(utcNow.getTime() - ART_OFFSET_MS);
    const todayStart = new Date(Date.UTC(
      argNow.getUTCFullYear(), argNow.getUTCMonth(), argNow.getUTCDate(), 3, 0, 0, 0,
    ));

    // 1. All contacts with relevant fields including last_read_at
    const { data: contacts, error: cErr } = await supabaseAdmin
      .from('contacts')
      .select('id, casino_username, status, conversation_state, last_read_at');
    if (cErr) return new NextResponse(cErr.message, { status: 500 });

    const contactMap = new Map<string, any>(
      (contacts ?? []).map((c: any) => [c.id, c]),
    );

    // 2. Today's messages — latest per contact (descending), with created_at
    const { data: msgs, error: mErr } = await supabaseAdmin
      .from('messages')
      .select('contact_id, role, created_at')
      .gte('created_at', todayStart.toISOString())
      .order('created_at', { ascending: false });
    if (mErr) return new NextResponse(mErr.message, { status: 500 });

    // Build last-message map per contact (role + created_at)
    const lastMsg = new Map<string, { role: string; created_at: string }>();
    for (const m of (msgs ?? [])) {
      if (!lastMsg.has(m.contact_id)) lastMsg.set(m.contact_id, { role: m.role, created_at: m.created_at });
    }

    // 3. Classify — skip contacts already read after the last message
    let newPending       = 0;
    let recurringPending = 0;

    for (const [cId, msg] of lastMsg.entries()) {
      if (msg.role !== 'user') continue; // last message is outbound → no badge

      const c = contactMap.get(cId);
      if (!c) continue;

      // Skip if operator already opened after this message
      if (c.last_read_at && new Date(c.last_read_at) >= new Date(msg.created_at)) continue;

      if (c.casino_username) {
        recurringPending++; // 🔴 recurring user waiting for manual reply
      } else {
        const botDone = c.conversation_state === 'done'
                     || c.conversation_state === 'en_proceso'
                     || c.status === 'en_proceso';
        if (botDone) newPending++; // 🟠 new user, bot finished, operator's turn
      }
    }

    return NextResponse.json({
      total:            newPending + recurringPending,
      newPending,
      recurringPending,
    });
  } catch (err: any) {
    return new NextResponse(String(err?.message ?? err), { status: 500 });
  }
}
