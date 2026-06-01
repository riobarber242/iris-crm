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

    // 1. All contacts with relevant fields
    const { data: contacts, error: cErr } = await supabaseAdmin
      .from('contacts')
      .select('id, casino_username, status, conversation_state');
    if (cErr) return new NextResponse(cErr.message, { status: 500 });

    const contactMap = new Map<string, any>(
      (contacts ?? []).map((c: any) => [c.id, c]),
    );

    // 2. Today's messages — latest per contact (descending)
    const { data: msgs, error: mErr } = await supabaseAdmin
      .from('messages')
      .select('contact_id, role')
      .gte('created_at', todayStart.toISOString())
      .order('created_at', { ascending: false });
    if (mErr) return new NextResponse(mErr.message, { status: 500 });

    // Build last-role map per contact
    const lastRole = new Map<string, string>();
    for (const m of (msgs ?? [])) {
      if (!lastRole.has(m.contact_id)) lastRole.set(m.contact_id, m.role);
    }

    // 3. Classify
    let newPending       = 0;
    let recurringPending = 0;

    for (const [cId, role] of lastRole.entries()) {
      if (role !== 'user') continue; // last message is outbound → no badge

      const c = contactMap.get(cId);
      if (!c) continue;

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
