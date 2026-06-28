type StatusBadgeProps = {
  status: 'nuevo' | 'en_proceso' | 'activo' | 'bloqueado' | 'pendiente' | 'verificado' | 'rechazado';
};

const statusStyles: Record<string, React.CSSProperties> = {
  nuevo:      { background: 'var(--status-nuevo)',  color: '#000' },
  en_proceso: { background: '#C8FF00',              color: '#000' },
  activo:     { background: 'var(--status-activo)', color: '#000' },
  bloqueado:  { background: '#FFE5E5',              color: '#CC3333' },
  pendiente:  { background: '#FFF8DC',              color: '#886600' },
  verificado: { background: '#C8FF00',              color: '#000' },
  rechazado:  { background: '#FFE5E5',              color: '#CC3333' },
};

const statusLabels: Record<string, string> = {
  nuevo: 'Nuevo',
  en_proceso: 'En proceso',
  activo: 'Activo',
  bloqueado: 'Bloqueado',
  pendiente: 'Pendiente',
  verificado: 'Verificado',
  rechazado: 'Rechazado',
};

import React from 'react';

export function StatusBadge({ status }: StatusBadgeProps) {
  const style = statusStyles[status] ?? { background: '#F0F0F0', color: '#888' };
  return (
    <span
      style={{
        ...style,
        borderRadius: '999px',
        padding: '4px 12px',
        fontSize: '11px',
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        display: 'inline-block',
      }}
    >
      {statusLabels[status] ?? status}
    </span>
  );
}
