"use client";

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { SectionCard } from '@/components/ui/SectionCard';

type Template = {
  id: string;
  name: string;
  language: string;
  body: string;
  buttons?: string[];
  created_at: string;
};

const inputStyle: React.CSSProperties = {
  background: '#F5F5F5', border: 'none', borderRadius: '10px',
  padding: '10px 14px', fontSize: '14px', color: '#000', outline: 'none', width: '100%',
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  fontSize: '11px', fontWeight: 700, color: '#999',
  textTransform: 'uppercase', letterSpacing: '0.08em',
};

const smallBtn: React.CSSProperties = {
  background: '#F5F5F5', color: '#555', fontWeight: 700, fontSize: '12px',
  border: 'none', borderRadius: '8px', padding: '7px 12px', cursor: 'pointer', whiteSpace: 'nowrap',
};

const buttonChip: React.CSSProperties = {
  background: '#fff', color: '#1a1a1a', fontSize: '12px', fontWeight: 700,
  border: '1px solid #ddd', borderRadius: '8px', padding: '5px 12px',
};

// Gestión de plantillas de WhatsApp del tenant (tabla whatsapp_templates).
// Visible para admin y agent: para otros roles no renderiza nada (la API igual
// exige admin o agent server-side para crear/editar/borrar).
export default function WhatsAppTemplatesManager() {
  const { agent } = useAuth();
  const canManage = agent?.role === 'admin' || agent?.role === 'agent';

  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Alta
  const [name, setName] = useState('');
  const [language, setLanguage] = useState('es');
  const [body, setBody] = useState('');
  const [buttons, setButtons] = useState<string[]>(['', '']);

  // Edición inline
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editLanguage, setEditLanguage] = useState('es');
  const [editBody, setEditBody] = useState('');
  const [editButtons, setEditButtons] = useState<string[]>(['', '']);

  // Envío a Meta (estado por fila).
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [submitResult, setSubmitResult] = useState<Record<string, { ok: boolean; msg: string }>>({});

  async function fetchTemplates() {
    try {
      const res = await fetch('/api/whatsapp-templates');
      if (res.ok) setTemplates(await res.json());
    } catch {}
    finally { setLoading(false); }
  }

  useEffect(() => {
    if (canManage) fetchTemplates();
  }, [canManage]);

  if (!canManage) return null;

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!name.trim()) { setError('Completá el nombre.'); return; }
    if (!body.trim()) { setError('Completá el cuerpo.'); return; }
    setSaving(true);
    try {
      const res = await fetch('/api/whatsapp-templates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), language: language.trim() || 'es', body: body.trim(), buttons: buttons.map((b) => b.trim()).filter(Boolean) }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        setError(d?.error ?? 'Error al crear la plantilla.');
      } else {
        setName(''); setLanguage('es'); setBody(''); setButtons(['', '']);
        setShowForm(false);
        await fetchTemplates();
      }
    } catch {
      setError('Error de red.');
    }
    setSaving(false);
  }

  function startEdit(t: Template) {
    setEditingId(t.id);
    setEditName(t.name);
    setEditLanguage(t.language || 'es');
    setEditBody(t.body);
    setEditButtons([t.buttons?.[0] ?? '', t.buttons?.[1] ?? '']);
    setError('');
  }

  async function handleSaveEdit(t: Template) {
    setError('');
    if (!editName.trim()) { setError('El nombre no puede quedar vacío.'); return; }
    if (!editBody.trim()) { setError('El cuerpo no puede quedar vacío.'); return; }
    setSaving(true);
    try {
      const res = await fetch('/api/whatsapp-templates', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: t.id, name: editName.trim(), language: editLanguage.trim() || 'es', body: editBody.trim(), buttons: editButtons.map((b) => b.trim()).filter(Boolean) }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        setError(d?.error ?? 'Error al guardar la plantilla.');
      } else {
        setEditingId(null);
        await fetchTemplates();
      }
    } catch {
      setError('Error de red.');
    }
    setSaving(false);
  }

  async function handleSubmitToMeta(t: Template) {
    if (!confirm(`¿Enviar la plantilla "${t.name}" a Meta para aprobación?`)) return;
    setSubmitting(t.id);
    setSubmitResult((p) => { const n = { ...p }; delete n[t.id]; return n; });
    try {
      const res = await fetch('/api/whatsapp-templates/submit-to-meta', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId: t.id }),
      });
      const d = await res.json().catch(() => null);
      setSubmitResult((p) => ({
        ...p,
        [t.id]: res.ok
          ? { ok: true, msg: '✅ Enviada, pendiente de aprobación' }
          : { ok: false, msg: d?.error ?? 'Error al enviar a Meta' },
      }));
    } catch {
      setSubmitResult((p) => ({ ...p, [t.id]: { ok: false, msg: 'Error de red.' } }));
    }
    setSubmitting(null);
  }

  async function handleDelete(t: Template) {
    if (!confirm(`¿Eliminar la plantilla "${t.name}"?`)) return;
    setError('');
    try {
      const res = await fetch('/api/whatsapp-templates', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: t.id }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        setError(d?.error ?? 'Error al eliminar la plantilla.');
      } else {
        await fetchTemplates();
      }
    } catch {
      setError('Error de red.');
    }
  }

  return (
    <SectionCard
      title="Plantillas de WhatsApp"
      description="Mensajes predefinidos para usar en campañas Template Meta. Cada plantilla es propia de tu cuenta."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>

        {loading && <p style={{ color: '#999', fontSize: '13px', margin: 0 }}>Cargando plantillas...</p>}

        {!loading && templates.length === 0 && (
          <p style={{ color: '#999', fontSize: '13px', margin: 0 }}>No hay plantillas todavía.</p>
        )}

        {templates.map((t) => {
          const isEditing = editingId === t.id;
          return (
            <div key={t.id} style={{ background: '#F8F8F8', borderRadius: '12px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: '200px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <code style={{ fontSize: '13px', fontWeight: 800, color: '#000', background: '#fff', borderRadius: '6px', padding: '2px 8px' }}>{t.name}</code>
                    <span style={{ fontSize: '11px', color: '#888' }}>{t.language}</span>
                  </div>
                  {!isEditing && (
                    <>
                      <p style={{ fontSize: '13px', color: '#555', margin: '8px 0 0 0', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{t.body}</p>
                      {t.buttons && t.buttons.length > 0 && (
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
                          {t.buttons.map((b, i) => (
                            <span key={i} style={buttonChip}>{b}</span>
                          ))}
                        </div>
                      )}
                      {submitResult[t.id] && (
                        <p style={{ fontSize: '12px', fontWeight: 700, margin: '8px 0 0 0', color: submitResult[t.id].ok ? '#1a7a3a' : '#E53935' }}>
                          {submitResult[t.id].msg}
                        </p>
                      )}
                    </>
                  )}
                </div>

                {!isEditing && (
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    <button onClick={() => startEdit(t)} style={smallBtn}>Editar</button>
                    <button onClick={() => handleSubmitToMeta(t)} disabled={submitting === t.id} style={{ ...smallBtn, background: '#f0fff4', color: '#1a7a3a', border: '1px solid #86efac' }}>
                      {submitting === t.id ? 'Enviando…' : 'Enviar a Meta'}
                    </button>
                    <button onClick={() => handleDelete(t)} style={{ ...smallBtn, background: '#fff', color: '#E53935', border: '1px solid #f08080' }}>Eliminar</button>
                  </div>
                )}
              </div>

              {isEditing && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', borderTop: '1px solid #eee', paddingTop: '12px' }}>
                  <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 2, minWidth: '180px' }}>
                      <label style={labelStyle}>Nombre</label>
                      <input value={editName} onChange={(e) => setEditName(e.target.value)} style={inputStyle} />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minWidth: '100px' }}>
                      <label style={labelStyle}>Idioma</label>
                      <input value={editLanguage} onChange={(e) => setEditLanguage(e.target.value)} placeholder="es" style={inputStyle} />
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <label style={labelStyle}>Cuerpo</label>
                    <textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} rows={4} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} />
                  </div>
                  <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minWidth: '140px' }}>
                      <label style={labelStyle}>Botón 1</label>
                      <input value={editButtons[0]} onChange={(e) => setEditButtons([e.target.value, editButtons[1]])} placeholder="Ej: Sí, recargar" style={inputStyle} />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minWidth: '140px' }}>
                      <label style={labelStyle}>Botón 2</label>
                      <input value={editButtons[1]} onChange={(e) => setEditButtons([editButtons[0], e.target.value])} placeholder="Ej: Ahora no" style={inputStyle} />
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      onClick={() => handleSaveEdit(t)}
                      disabled={saving}
                      style={{ background: saving ? '#e0e0e0' : '#C8FF00', color: '#000', fontWeight: 800, fontSize: '13px', border: 'none', borderRadius: '10px', padding: '10px 18px', cursor: saving ? 'not-allowed' : 'pointer' }}
                    >
                      {saving ? 'Guardando...' : 'Guardar cambios'}
                    </button>
                    <button type="button" onClick={() => setEditingId(null)} style={{ ...smallBtn, padding: '10px 14px' }}>Cancelar</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {error && <p style={{ fontSize: '13px', color: '#E53935', fontWeight: 600, margin: 0 }}>{error}</p>}

        {!showForm ? (
          <button
            onClick={() => { setShowForm(true); setError(''); }}
            style={{ background: '#1a1a1a', color: '#C8FF00', fontWeight: 800, fontSize: '13px', border: 'none', borderRadius: '12px', padding: '10px 20px', cursor: 'pointer', alignSelf: 'flex-start' }}
          >
            + Agregar plantilla
          </button>
        ) : (
          <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: '12px', background: '#FAFAFA', borderRadius: '12px', padding: '16px' }}>
            <p style={{ fontSize: '14px', fontWeight: 800, color: '#000', margin: 0 }}>Nueva plantilla</p>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 2, minWidth: '180px' }}>
                <label style={labelStyle}>Nombre</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej: reactivacion_bono" style={inputStyle} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minWidth: '100px' }}>
                <label style={labelStyle}>Idioma</label>
                <input value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="es" style={inputStyle} />
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={labelStyle}>Cuerpo</label>
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder="Texto de la plantilla. Usá {{1}}, {{2}} para variables." style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} />
            </div>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minWidth: '140px' }}>
                <label style={labelStyle}>Botón 1</label>
                <input value={buttons[0]} onChange={(e) => setButtons([e.target.value, buttons[1]])} placeholder="Ej: Sí, recargar" style={inputStyle} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minWidth: '140px' }}>
                <label style={labelStyle}>Botón 2</label>
                <input value={buttons[1]} onChange={(e) => setButtons([buttons[0], e.target.value])} placeholder="Ej: Ahora no" style={inputStyle} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="submit"
                disabled={saving}
                style={{ background: saving ? '#e0e0e0' : '#C8FF00', color: '#000', fontWeight: 800, fontSize: '13px', border: 'none', borderRadius: '10px', padding: '10px 18px', cursor: saving ? 'not-allowed' : 'pointer' }}
              >
                {saving ? 'Guardando...' : 'Guardar plantilla'}
              </button>
              <button type="button" onClick={() => { setShowForm(false); setError(''); }} style={{ ...smallBtn, padding: '10px 14px' }}>Cancelar</button>
            </div>
          </form>
        )}
      </div>
    </SectionCard>
  );
}
