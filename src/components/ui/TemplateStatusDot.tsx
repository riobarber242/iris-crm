"use client";

import React from 'react';
import { templateStatus } from '@/lib/template-status';

// Punto de color con el estado de aprobación de la plantilla en Meta.
// Verde = aprobada · naranja = en revisión · rojo = rechazada/pausada · gris = sin sincronizar.
export function TemplateStatusDot({ status, showLabel = false }: { status: string | null | undefined; showLabel?: boolean }) {
  const s = templateStatus(status);
  return (
    <span
      title={s.label}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' }}
    >
      <span
        aria-hidden
        style={{
          width: '9px', height: '9px', borderRadius: '50%', background: s.color,
          flexShrink: 0, display: 'inline-block',
        }}
      />
      <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{s.label}</span>
      {showLabel && <span style={{ fontSize: '11px', fontWeight: 700, color: s.color }}>{s.label}</span>}
    </span>
  );
}
