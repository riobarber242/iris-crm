'use client';

import React, { useState } from 'react';
import {
  DndContext, closestCenter, PointerSensor, KeyboardSensor,
  useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy, arrayMove, useSortable,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { DEFAULT_LAYOUT, WIDGET_GROUP, type WidgetConfig } from '@/lib/dashboard-layout';

const GROUP_LABEL: Record<string, string> = {
  hero:   'Destacado',
  metric: 'Métrica',
  chart:  'Gráfico',
};

export default function DashboardCustomizer({
  layout, onClose, onSave,
}: {
  layout: WidgetConfig[];
  onClose: () => void;
  onSave: (l: WidgetConfig[]) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState<WidgetConfig[]>(() =>
    [...layout].sort((a, b) => a.order - b.order)
  );
  const [saving, setSaving] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setDraft((items) => {
      const oldI = items.findIndex((i) => i.id === active.id);
      const newI = items.findIndex((i) => i.id === over.id);
      if (oldI === -1 || newI === -1) return items;
      return arrayMove(items, oldI, newI);
    });
  }

  function toggle(id: string) {
    setDraft((d) => d.map((w) => (w.id === id ? { ...w, visible: !w.visible } : w)));
  }
  function rename(id: string, label: string) {
    setDraft((d) => d.map((w) => (w.id === id ? { ...w, label } : w)));
  }
  function reset() {
    setDraft(DEFAULT_LAYOUT.map((w) => ({ ...w })));
  }

  async function save() {
    setSaving(true);
    // El orden final es la posición en la lista; re-normalizamos `order`.
    const normalized = draft.map((w, i) => ({ ...w, order: i }));
    try { await onSave(normalized); } finally { setSaving(false); }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: '20px', width: '100%', maxWidth: '460px',
          maxHeight: '86vh', display: 'flex', flexDirection: 'column',
          boxShadow: '0 12px 48px rgba(0,0,0,0.3)', overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ background: '#0a0a0a', padding: '18px 22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '17px', fontWeight: 900, color: '#fff' }}>Personalizar dashboard</h2>
            <p style={{ margin: '3px 0 0 0', fontSize: '12px', color: '#aaa' }}>Arrastrá para reordenar · click en el nombre para renombrar</p>
          </div>
          <button onClick={onClose} aria-label="Cerrar" style={{ background: '#1a1a1a', color: '#fff', border: 'none', borderRadius: '8px', width: '34px', height: '34px', fontSize: '16px', cursor: 'pointer' }}>✕</button>
        </div>

        {/* Lista sortable */}
        <div style={{ padding: '14px 16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={draft.map((w) => w.id)} strategy={verticalListSortingStrategy}>
              {draft.map((w) => (
                <SortableRow key={w.id} w={w} onToggle={toggle} onRename={rename} />
              ))}
            </SortableContext>
          </DndContext>
        </div>

        {/* Footer */}
        <div style={{ borderTop: '1px solid #eee', padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
          <button
            onClick={reset}
            disabled={saving}
            style={{ background: '#F0F0F0', color: '#555', border: 'none', borderRadius: '10px', padding: '10px 16px', fontWeight: 700, fontSize: '13px', cursor: 'pointer' }}
          >
            Resetear
          </button>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={onClose}
              disabled={saving}
              style={{ background: '#fff', color: '#666', border: '2px solid #eee', borderRadius: '10px', padding: '10px 16px', fontWeight: 700, fontSize: '13px', cursor: 'pointer' }}
            >
              Cancelar
            </button>
            <button
              onClick={save}
              disabled={saving}
              style={{ background: '#C8FF00', color: '#000', border: 'none', borderRadius: '10px', padding: '10px 20px', fontWeight: 800, fontSize: '13px', cursor: saving ? 'not-allowed' : 'pointer' }}
            >
              {saving ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SortableRow({
  w, onToggle, onRename,
}: {
  w: WidgetConfig;
  onToggle: (id: string) => void;
  onRename: (id: string, label: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: w.id });
  const [editing, setEditing] = useState(false);

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    display: 'flex', alignItems: 'center', gap: '10px',
    background: w.visible ? '#F7F7F7' : '#FBEAEA',
    border: '2px solid ' + (w.visible ? '#eee' : '#f3d2d2'),
    borderRadius: '12px', padding: '10px 12px',
  };

  return (
    <div ref={setNodeRef} style={style}>
      {/* Drag handle */}
      <span
        {...attributes}
        {...listeners}
        aria-label="Reordenar"
        style={{ cursor: 'grab', color: '#bbb', fontSize: '18px', lineHeight: 1, touchAction: 'none', userSelect: 'none' }}
      >
        ⠿
      </span>

      {/* Label editable */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {editing ? (
          <input
            autoFocus
            value={w.label}
            onChange={(e) => onRename(w.id, e.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setEditing(false); }}
            style={{ width: '100%', background: '#fff', border: '2px solid #C8FF00', borderRadius: '8px', padding: '5px 8px', fontSize: '14px', fontWeight: 600, color: '#111', outline: 'none' }}
          />
        ) : (
          <span
            onClick={() => setEditing(true)}
            title="Click para renombrar"
            style={{ fontSize: '14px', fontWeight: 700, color: w.visible ? '#111' : '#999', cursor: 'text', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}
          >
            {w.label}
          </span>
        )}
        <span style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#bbb' }}>
          {GROUP_LABEL[WIDGET_GROUP[w.id]]}
        </span>
      </div>

      {/* Toggle visible */}
      <button
        onClick={() => onToggle(w.id)}
        aria-label={w.visible ? 'Ocultar' : 'Mostrar'}
        title={w.visible ? 'Ocultar' : 'Mostrar'}
        style={{
          background: w.visible ? '#E8F5E9' : '#f0f0f0',
          color: w.visible ? '#1a8a1a' : '#aaa',
          border: 'none', borderRadius: '8px', padding: '6px 10px',
          fontSize: '13px', fontWeight: 700, cursor: 'pointer', flexShrink: 0,
        }}
      >
        {w.visible ? '👁 Visible' : '🚫 Oculto'}
      </button>
    </div>
  );
}
