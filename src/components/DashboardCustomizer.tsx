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
import {
  DEFAULT_LAYOUT, CUSTOM_PREFIX, widgetGroup, isCustomWidget, type WidgetConfig,
} from '@/lib/dashboard-layout';
import { METRIC_CATALOG, PERIODS, getMetric } from '@/lib/dashboard-metrics';

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

  // Formulario de "Crear widget".
  const [creatingOpen, setCreatingOpen] = useState(false);
  const [nwTitle,  setNwTitle]  = useState('');
  const [nwMetric, setNwMetric] = useState('');
  const [nwPeriod, setNwPeriod] = useState<'hoy' | 'semana' | 'mes' | 'mes_anterior'>('mes');
  const [nwFormat, setNwFormat] = useState<'single' | 'breakdown'>('single');

  const nwMetricDef    = getMetric(nwMetric);
  const nwHasPeriod    = !!nwMetricDef?.supportsPeriod;
  const canAddWidget   = nwTitle.trim().length > 0 && !!nwMetricDef;

  function resetCreateForm() {
    setNwTitle(''); setNwMetric(''); setNwPeriod('mes'); setNwFormat('single');
    setCreatingOpen(false);
  }

  function addCustomWidget() {
    if (!canAddWidget || !nwMetricDef) return;
    const id = `${CUSTOM_PREFIX}${crypto.randomUUID()}`;
    const widget: WidgetConfig = {
      id,
      label: nwTitle.trim().slice(0, 60),
      visible: true,
      order: draft.length,
      custom: {
        metric: nwMetricDef.id,
        period: nwHasPeriod ? nwPeriod : null,
        format: nwHasPeriod ? nwFormat : 'single',
      },
    };
    setDraft((d) => [...d, widget]);
    resetCreateForm();
  }

  function removeWidget(id: string) {
    setDraft((d) => d.filter((w) => w.id !== id));
  }

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
    // Restaura los widgets fijos a su default, pero CONSERVA los widgets custom
    // creados por el agente (no se pierden al resetear).
    const customs = draft.filter(isCustomWidget);
    setDraft([...DEFAULT_LAYOUT.map((w) => ({ ...w })), ...customs]);
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

          {/* Crear widget */}
          {creatingOpen ? (
            <div style={{ background: '#F7F7F7', border: '2px solid #eee', borderRadius: '12px', padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <span style={{ fontSize: '12px', fontWeight: 800, color: '#555', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Nuevo widget</span>
              <FormField label="Título">
                <input
                  autoFocus value={nwTitle} onChange={(e) => setNwTitle(e.target.value)}
                  placeholder="Ej: Comprobantes del mes" maxLength={60}
                  style={selectStyle}
                />
              </FormField>
              <FormField label="Métrica">
                <select value={nwMetric} onChange={(e) => setNwMetric(e.target.value)} style={selectStyle}>
                  <option value="">Elegí una métrica…</option>
                  {METRIC_CATALOG.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </FormField>
              {nwHasPeriod && (
                <div style={{ display: 'flex', gap: '10px' }}>
                  <FormField label="Período">
                    <select value={nwPeriod} onChange={(e) => setNwPeriod(e.target.value as any)} style={selectStyle}>
                      {PERIODS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                    </select>
                  </FormField>
                  <FormField label="Formato">
                    <select value={nwFormat} onChange={(e) => setNwFormat(e.target.value as any)} style={selectStyle}>
                      <option value="single">Número único</option>
                      <option value="breakdown">Desglose por períodos</option>
                    </select>
                  </FormField>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <button onClick={resetCreateForm} style={{ background: '#fff', color: '#666', border: '2px solid #eee', borderRadius: '10px', padding: '8px 14px', fontWeight: 700, fontSize: '13px', cursor: 'pointer' }}>Cancelar</button>
                <button onClick={addCustomWidget} disabled={!canAddWidget} style={{ background: canAddWidget ? '#C8FF00' : '#e8e8e8', color: canAddWidget ? '#000' : '#aaa', border: 'none', borderRadius: '10px', padding: '8px 16px', fontWeight: 800, fontSize: '13px', cursor: canAddWidget ? 'pointer' : 'not-allowed' }}>Agregar</button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setCreatingOpen(true)}
              style={{ background: '#0a0a0a', color: '#C8FF00', border: 'none', borderRadius: '12px', padding: '12px', fontWeight: 800, fontSize: '14px', cursor: 'pointer' }}
            >
              + Crear widget
            </button>
          )}

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={draft.map((w) => w.id)} strategy={verticalListSortingStrategy}>
              {draft.map((w) => (
                <SortableRow key={w.id} w={w} onToggle={toggle} onRename={rename} onDelete={removeWidget} />
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
  w, onToggle, onRename, onDelete,
}: {
  w: WidgetConfig;
  onToggle: (id: string) => void;
  onRename: (id: string, label: string) => void;
  onDelete: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: w.id });
  const [editing, setEditing] = useState(false);
  const custom = isCustomWidget(w);

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
        <span style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: custom ? '#7da000' : '#bbb' }}>
          {custom ? 'Personalizado' : GROUP_LABEL[widgetGroup(w)]}
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

      {/* Borrar (solo widgets custom; los fijos no se borran, solo se ocultan) */}
      {custom && (
        <button
          onClick={() => onDelete(w.id)}
          aria-label="Eliminar widget"
          title="Eliminar widget"
          style={{
            background: '#FFE5E5', color: '#CC3333', border: 'none', borderRadius: '8px',
            padding: '6px 10px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', flexShrink: 0,
          }}
        >
          🗑
        </button>
      )}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  width: '100%', background: '#fff', border: '2px solid #eee', borderRadius: '8px',
  padding: '8px 10px', fontSize: '13px', color: '#111', outline: 'none',
};

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: 0 }}>
      <label style={{ fontSize: '11px', fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</label>
      {children}
    </div>
  );
}
