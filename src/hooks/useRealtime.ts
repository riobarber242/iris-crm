'use client';
import { useEffect, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';

type Sub = {
  table: string;
  event?: '*' | 'INSERT' | 'UPDATE' | 'DELETE';
};

/**
 * Subscribe to one or more Supabase tables via Realtime (postgres_changes)
 * with an optional polling interval as fallback.
 *
 * @param channelName  Unique channel identifier (prevents duplicate channels)
 * @param subs         Tables + events to listen to
 * @param callback     Function to call on any change or poll tick
 * @param intervalMs   Optional polling interval in ms (recommended: 10_000–15_000)
 */
export function useRealtime(
  channelName: string,
  subs: Sub[],
  callback: () => void,
  intervalMs?: number,
) {
  // Keep callback ref so we never need to re-subscribe on callback identity change
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    cbRef.current(); // initial fetch

    const timer = intervalMs
      ? setInterval(() => cbRef.current(), intervalMs)
      : null;

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) {
      return () => { if (timer) clearInterval(timer); };
    }

    const supabase = createClient(url, key);
    let ch = supabase.channel(channelName);
    for (const { table, event = '*' } of subs) {
      ch = ch.on(
        'postgres_changes' as any,
        { event, schema: 'public', table },
        () => cbRef.current(),
      );
    }
    ch.subscribe();

    return () => {
      if (timer) clearInterval(timer);
      try { supabase.removeChannel(ch); } catch {}
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // stable: channelName and subs don't change after mount
}
