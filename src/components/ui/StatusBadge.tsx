type StatusBadgeProps = {
  status: 'nuevo' | 'en_proceso' | 'activo' | 'bloqueado' | 'pendiente' | 'verificado' | 'rechazado';
};

const statusStyles: Record<string, string> = {
  nuevo: 'bg-[#2d2d4c] text-iris-text-muted',
  en_proceso: 'bg-[#3d294f] text-iris-purple',
  activo: 'bg-[#083d17] text-iris-green',
  bloqueado: 'bg-[#3a1515] text-[#ff6e6e]',
  pendiente: 'bg-[#3f2929] text-iris-gold',
  verificado: 'bg-[#14321f] text-iris-green',
  rechazado: 'bg-[#401a2f] text-iris-pink',
};

export function StatusBadge({ status }: StatusBadgeProps) {
  return <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusStyles[status]}`}>{status.replace('_', ' ')}</span>;
}
