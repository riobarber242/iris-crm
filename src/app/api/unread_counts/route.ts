import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

// Counts contacts that have user messages AFTER their last_read_at.
// Mirrors exactly what ConversationsClient shows as green badges.
// Contacts where last_read_at = null are treated as "no badge" (same as client).
export async function GET() {
  try {
    const ART_OFFSET_MS = 3 * 60 * 60 * 1000;
    const utcNow  = new Date();
    const argNow  = new Date(utcNow.getTime() - ART_OFFSET_MS);
    const todayStart = new Date(Date.UTC(
      argNow.getUTCFullYear(), argNow.getUTCMonth(), argNow.getUTCDate(), 3, 0, 0, 0,
    ));

    // 1. All contacts that have a last_read_at (excludes never-opened ones)
    const { data: contacts, error: cErr } = await supabaseAdmin
      .from('contacts')
      .select('id, last_read_at')
      .not('last_read_at', 'is', null);

    if (cErr) return new NextResponse(cErr.message, { status: 500 });

    // Build a map: contactId → last_read_at date
    const lastReadMap = new Map<string, Date>(
      (contacts ?? []).map((c: any) => [c.id, new Date(c.last_read_at)]),
    );

    if (lastReadMap.size === 0) return NextResponse.json({ total: 0 });

    // 2. User messages from today for those contacts
    const { data: msgs, error: mErr } = await supabaseAdmin
      .from('messages')
      .select('contact_id, created_at')
      .eq('role', 'user')
      .gte('created_at', todayStart.toISOString())
      .in('contact_id', [...lastReadMap.keys()]);

    if (mErr) return new NextResponse(mErr.message, { status: 500 });

    // 3. Count contacts with at least one user message AFTER their last_read_at
    const unreadContacts = new Set<string>();
    for (const msg of (msgs ?? [])) {
      const lr = lastReadMap.get(msg.contact_id);
      if (lr && new Date(msg.created_at) > lr) {
        unreadContacts.add(msg.contact_id);
      }
    }

    return NextResponse.json({ total: unreadContacts.size });
  } catch (err: any) {
    return new NextResponse(String(err?.message ?? err), { status: 500 });
  }
}
