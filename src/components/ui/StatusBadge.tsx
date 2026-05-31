type StatusBadgeProps = {
  status: 'nuevo' | 'en_proceso' | 'activo' | 'bloqueado' | 'pendiente' | 'verificado' | 'rechazado';
};

const statusStyles: Record<string, string> = {
  nuevo: 'bg-[#151515] text-[#888888] border border-white/10',
  en_proceso: 'bg-[#151515] text-[#C6FF00] border border-[#C6FF00]/20',
  activo: 'bg-[#151515] text-[#C6FF00] border border-[#C6FF00]/20',
  bloqueado: 'bg-[#3a1515] text-[#ff6e6e] border border-[#ff6e6e]/20',
  pendiente: 'bg-[#C6FF00] text-black border border-[#C6FF00]',
  verificado: 'bg-[#C6FF00]/20 text-[#C6FF00] border border-[#C6FF00]/30',
  rechazado: 'bg-transparent text-[#C6FF00] border border-[#C6FF00] ',
};

export function StatusBadge({ status }: StatusBadgeProps) {
  return <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusStyles[status]}`}>{status.replace('_', ' ')}</span>;
}
