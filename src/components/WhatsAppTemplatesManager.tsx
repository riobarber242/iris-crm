"use client";

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { SectionCard } from '@/components/ui/SectionCard';
import { TemplateStatusDot } from '@/components/ui/TemplateStatusDot';

type Template = {
  id: string;
  name: string;
  language: string;
  body: string;
  buttons?: string[];
  created_at: string;
  // WABA dueña de la plantilla (null = legacy, anterior a la migración por WABA)
  // y estado de aprobación que reporta Meta.
  waba_id?: string | null;
  approval_status?: string | null;
  status_synced_at?: string | null;
};

// Línea de WhatsApp del tenant, para saber a qué WABA pertenece cada plantilla.
type WaLine = { id: string; label: string | null; waba_id: string | null; active: boolean; is_default: boolean };

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
  // WABA con la que se da de alta. Solo se elige si el tenant tiene líneas en más
  // de una WABA; con una sola, el server la resuelve solo (número default).
  const [newWaba, setNewWaba] = useState('');

  // Líneas del tenant → de acá salen las WABAs disponibles y sus nombres.
  const [lines, setLines] = useState<WaLine[]>([]);

  // Sincronización del estado de aprobación contra Meta.
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

  // Edición inline
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editLanguage, setEditLanguage] = useState('es');
  const [editBody, setEditBody] = useState('');
  const [editButtons, setEditButtons] = useState<string[]>(['', '']);
  // WABA de la plantilla en edición. Editable para poder corregir una mal asignada
  // (si no, quedaría invisible en campañas y solo se arreglaría por SQL).
  const [editWaba, setEditWaba] = useState('');

  // Envío a Meta (estado por fila).
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [submitResult, setSubmitResult] = useState<Record<string, { ok: boolean; msg: string }>>({});

  // Negocio verificado en Meta: ahora es SOLO informativo (ya no gatea el botón).
  // Se persiste en localStorage + settings por tenant para recordarlo.
  const [verified, setVerified] = useState(false);

  // Categoría con la que se manda la plantilla a Meta al pedir aprobación.
  const [submitCategory, setSubmitCategory] = useState('MARKETING');

  async function fetchTemplates() {
    try {
      const res = await fetch('/api/whatsapp-templates');
      if (res.ok) setTemplates(await res.json());
    } catch {}
    finally { setLoading(false); }
  }

  // Sincroniza contra Meta y deja la lista ya actualizada. Es la carga por defecto
  // de la pantalla (1 llamada a la Graph API por WABA): así el punto de estado está
  // fresco sin que nadie tenga que apretar nada. Si Meta falla, el endpoint igual
  // devuelve la lista local, y como último recurso caemos al GET de siempre.
  async function syncTemplates(manual = false) {
    setSyncing(true);
    if (manual) setSyncMsg('');
    try {
      const res = await fetch('/api/whatsapp-templates/sync', { method: 'POST' });
      const d = await res.json().catch(() => null);
      if (res.ok && d) {
        setTemplates(Array.isArray(d.templates) ? d.templates : []);
        const errs: string[] = Array.isArray(d.errors) ? d.errors : [];
        setSyncMsg(errs.length > 0
          ? `No se pudo leer el estado desde Meta: ${errs[0]}`
          : manual ? `Estado actualizado (${d.wabas} WABA${d.wabas === 1 ? '' : 's'}).` : '');
      } else {
        await fetchTemplates();
      }
    } catch {
      await fetchTemplates();
    } finally {
      setSyncing(false);
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!canManage) return;
    syncTemplates();
    fetch('/api/whatsapp-numbers')
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setLines(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, [canManage]);

  // WABAs distintas del tenant (de sus líneas activas con waba_id). Con una sola,
  // el selector de WABA no hace falta: el alta la resuelve el server.
  const wabaOptions = React.useMemo(() => {
    const map = new Map<string, string[]>();
    for (const l of lines) {
      if (!l.active || !l.waba_id) continue;
      const labels = map.get(l.waba_id) ?? [];
      labels.push(l.label ?? l.id);
      map.set(l.waba_id, labels);
    }
    return Array.from(map, ([wabaId, labels]) => ({ wabaId, labels }));
  }, [lines]);

  // Nombre lindo de una WABA para mostrar en la fila de la plantilla.
  function wabaLabel(wabaId: string | null | undefined): string {
    if (!wabaId) return 'sin WABA';
    const opt = wabaOptions.find((w) => w.wabaId === wabaId);
    return opt ? opt.labels.join(' · ') : `WABA ${wabaId}`;
  }

  // Etiqueta de la opción por defecto del selector de WABA: nombra la WABA del
  // número default (la que resolveWaba usa cuando no se elige nada) para que no
  // quede ambiguo a qué cuenta va la plantilla. Fallback al texto genérico si no
  // hay número default activo con waba_id.
  const defaultLine = lines.find((l) => l.is_default && l.active);
  const defaultWabaOptionLabel = defaultLine?.waba_id
    ? `Cuenta principal — ${wabaLabel(defaultLine.waba_id)}`
    : 'Cuenta principal (número default)';

  // localStorage da el valor inmediato (sin parpadeo); el servidor es la fuente
  // de verdad por tenant y su valor SIEMPRE gana (sube o baja el checkbox).
  useEffect(() => {
    try { setVerified(localStorage.getItem('meta_business_verified') === 'true'); } catch {}
    (async () => {
      try {
        const res = await fetch('/api/tenant-settings?key=meta_business_verified');
        if (res.ok) {
          const d = await res.json();
          setVerified(d?.value === 'true');
        }
      } catch {}
    })();
  }, []);

  function toggleVerified(v: boolean) {
    setVerified(v);
    // Solo informativo: se guarda en localStorage + servidor, sin afectar el botón.
    try { localStorage.setItem('meta_business_verified', v ? 'true' : 'false'); } catch {}
    fetch('/api/tenant-settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'meta_business_verified', value: v ? 'true' : 'false' }),
    }).catch(() => {});
  }

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
        // waba_id: la WABA donde va a vivir la plantilla. Si el tenant tiene una
        // sola, no se manda y el server usa la del número default.
        body: JSON.stringify({ name: name.trim(), language: language.trim() || 'es', body: body.trim(), buttons: buttons.map((b) => b.trim()).filter(Boolean), waba_id: newWaba || undefined }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        setError(d?.error ?? 'Error al crear la plantilla.');
      } else {
        setName(''); setLanguage('es'); setBody(''); setButtons(['', '']); setNewWaba('');
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
    setEditWaba(t.waba_id ?? '');
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
        body: JSON.stringify({ id: t.id, name: editName.trim(), language: editLanguage.trim() || 'es', body: editBody.trim(), buttons: editButtons.map((b) => b.trim()).filter(Boolean), waba_id: editWaba }),
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
    if (!confirm(`¿Enviar la plantilla "${t.name}" a Meta para aprobación (categoría ${submitCategory})?`)) return;
    setSubmitting(t.id);
    setSubmitResult((p) => { const n = { ...p }; delete n[t.id]; return n; });
    try {
      const res = await fetch('/api/whatsapp-templates/submit-to-meta', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId: t.id, category: submitCategory }),
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

        <p style={{ fontSize: '13px', color: '#555', background: '#FFFBEA', border: '1px solid #FCE8A6', borderRadius: '10px', padding: '10px 14px', margin: 0, lineHeight: 1.5 }}>
          💡 Sin verificación de negocio en Meta podés iniciar hasta 250 conversaciones nuevas por número en una ventana móvil de 24 horas. Desde octubre de 2025 ese cupo se comparte entre todos los números del mismo Business Manager (no se suma por número). Una vez que verifiques tu negocio en Meta Business Manager ese límite desaparece.
        </p>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', fontWeight: 600, color: '#333', background: '#FAFAFA', borderRadius: '10px', padding: '10px 14px' }}>
            <input type="checkbox" checked={verified} onChange={(e) => toggleVerified(e.target.checked)} />
            Mi negocio está verificado en Meta Business Manager
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 600, color: '#333' }}>
            Categoría al enviar a Meta:
            <select value={submitCategory} onChange={(e) => setSubmitCategory(e.target.value)} style={{ ...inputStyle, width: 'auto', padding: '8px 12px' }}>
              <option value="MARKETING">MARKETING</option>
              <option value="UTILITY">UTILITY</option>
              <option value="AUTHENTICATION">AUTHENTICATION</option>
            </select>
          </label>
        </div>

        {/* Estado de aprobación en Meta: se sincroniza solo al abrir la pantalla y a
            demanda con el botón. Sin aprobar, una plantilla NO se puede usar en
            campañas (Meta la rechaza en silencio). */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => syncTemplates(true)}
            disabled={syncing}
            style={{ ...smallBtn, cursor: syncing ? 'default' : 'pointer', opacity: syncing ? 0.6 : 1 }}
          >
            {syncing ? 'Sincronizando…' : '↻ Sincronizar estado con Meta'}
          </button>
          <span style={{ display: 'flex', alignItems: 'center', gap: '14px', fontSize: '11px', color: '#888', flexWrap: 'wrap' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}><span style={{ width: 9, height: 9, borderRadius: '50%', background: '#1a7a3a' }} /> Aprobada</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}><span style={{ width: 9, height: 9, borderRadius: '50%', background: '#F2994A' }} /> En revisión</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}><span style={{ width: 9, height: 9, borderRadius: '50%', background: '#E53935' }} /> Rechazada</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}><span style={{ width: 9, height: 9, borderRadius: '50%', background: '#bbb' }} /> Sin sincronizar</span>
          </span>
        </div>
        {syncMsg && <p style={{ fontSize: '12px', color: '#888', margin: 0 }}>{syncMsg}</p>}

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
                    <TemplateStatusDot status={t.approval_status} />
                    <code style={{ fontSize: '13px', fontWeight: 800, color: '#000', background: '#fff', borderRadius: '6px', padding: '2px 8px' }}>{t.name}</code>
                    <span style={{ fontSize: '11px', color: '#888' }}>{t.language}</span>
                    {/* La WABA solo aporta información si el tenant tiene más de una. */}
                    {wabaOptions.length > 1 && (
                      <span style={{ fontSize: '11px', color: '#aaa' }}>· {wabaLabel(t.waba_id)}</span>
                    )}
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
                    <button
                      onClick={() => handleSubmitToMeta(t)}
                      disabled={submitting === t.id}
                      title="Enviar esta plantilla a Meta para aprobación"
                      style={{
                        ...smallBtn,
                        background: '#f0fff4', color: '#1a7a3a', border: '1px solid #86efac',
                      }}
                    >
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

                  {wabaOptions.length > 1 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <label style={labelStyle}>Cuenta de WhatsApp (WABA)</label>
                      <select value={editWaba} onChange={(e) => setEditWaba(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
                        <option value="">{defaultWabaOptionLabel}</option>
                        {wabaOptions.map((w) => (
                          <option key={w.wabaId} value={w.wabaId}>{w.labels.join(' · ')}</option>
                        ))}
                      </select>
                    </div>
                  )}
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

            {/* Con más de una WABA hay que decir en cuál se registra: una plantilla
                aprobada en la WABA A no existe en la B. Con una sola, se resuelve solo. */}
            {wabaOptions.length > 1 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={labelStyle}>Cuenta de WhatsApp (WABA)</label>
                <select value={newWaba} onChange={(e) => setNewWaba(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
                  <option value="">{defaultWabaOptionLabel}</option>
                  {wabaOptions.map((w) => (
                    <option key={w.wabaId} value={w.wabaId}>{w.labels.join(' · ')}</option>
                  ))}
                </select>
                <p style={{ fontSize: '11px', color: '#bbb', margin: 0 }}>
                  La plantilla queda asociada a esta cuenta y solo se va a poder usar en campañas con sus líneas.
                </p>
              </div>
            )}
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
