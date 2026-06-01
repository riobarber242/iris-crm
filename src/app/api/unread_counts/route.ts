import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

// Returns the count of unique contacts that sent a message today
// and haven't received a reply yet (last message from that contact is role='user').
// Used by the sidebar badge in AdminShell.
export async function GET() {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Get all messages from today, ordered desc so first occurrence per contact = latest
    const { data, error } = await supabaseAdmin
      .from('messages')
      .select('contact_id, role')
      .gte('created_at', todayStart.toISOString())
      .order('created_at', { ascending: false });

    if (error) return new NextResponse(error.message, { status: 500 });

    // Find the latest message role per contact
    const latestRole = new Map<string, string>();
    for (const msg of (data ?? [])) {
      if (!latestRole.has(msg.contact_id)) {
        latestRole.set(msg.contact_id, msg.role);
      }
    }

    // Count contacts where the last message is from the user (needs response)
    let total = 0;
    for (const role of latestRole.values()) {
      if (role === 'user') total++;
    }

    return NextResponse.json({ total });
  } catch (err: any) {
    return new NextResponse(String(err?.message ?? err), { status: 500 });
  }
}
