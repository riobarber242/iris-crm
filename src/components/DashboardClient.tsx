"use client";

import React, { useEffect, useState, useRef } from 'react';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { StatCard } from '@/components/ui/StatCard';

export default function DashboardClient() {
  const [stats, setStats] = useState<any>(null);
  const supabaseRef = useRef<SupabaseClient | null>(null);
  const channelRef = useRef<any>(null);

  async function fetchStats() {
    try {
      const res = await fetch('/api/dashboard_stats');
      if (!res.ok) return;
      const data = await res.json();
      setStats(data);
    } catch (e) {
      console.error(e);
    }
  }

  useEffect(() => {
    fetchStats();

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL as string | undefined;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string | undefined;
    if (!url || !key) return;

    supabaseRef.current = createClient(url, key);

    const channel = supabaseRef.current
      .channel('realtime-dashboard')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'contacts' }, () => fetchStats())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'comprobantes' }, () => fetchStats())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, () => fetchStats())
      // listen to new messages so dashboard updates when conversations arrive
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, () => fetchStats())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, () => fetchStats())
      .subscribe();

    channelRef.current = channel;

    return () => {
      try {
        if (channelRef.current) supabaseRef.current?.removeChannel(channelRef.current);
      } catch (e) {}
    };
  }, []);

  if (!stats) return <div>Cargando...</div>;

  return (
    <div className="space-y-8">
      <div className="grid gap-6 lg:grid-cols-4">
        <StatCard label="Contactos hoy" value={`${stats.contactsToday}`} accent="purple" />
        <StatCard label="Contactos semana" value={`${stats.contactsWeek}`} accent="gold" />
        <StatCard label="Contactos mes" value={`${stats.contactsMonth}`} accent="pink" />
        <StatCard label="Comprobantes pendientes" value={`${stats.comprobantesPending}`} accent="green" />
      </div>

      <div className="grid gap-6 lg:grid-cols-4">
        <StatCard label="VIP" value={`${stats.vipLeads}`} accent="gold" />
        <StatCard label="Activo" value={`${stats.activeLeads}`} accent="green" />
        <StatCard label="Frío" value={`${stats.coldLeads}`} accent="pink" />
        <StatCard label="Monto verificado" value={`$${Number(stats.verifiedAmount ?? 0).toFixed(0)}`} accent="purple" />
      </div>
    </div>
  );
}
