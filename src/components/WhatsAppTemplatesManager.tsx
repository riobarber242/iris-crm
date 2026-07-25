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

// Máximo de botones de respuesta rápida por plantilla (límite de Meta).
const MAX_QUICK_REPLY_BUTTONS = 3;

// Editor de botones de respuesta rápida: lista dinámica de hasta 3 posiciones, con
// agregar/quitar. Los vacíos se filtran al guardar (una plantilla puede no tener
// botones). El orden importa: primero = positivo, último = negativo (lo usa el
// auto-enganche de campañas).
function QuickReplyButtonsEditor({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const set    = (i: number, v: string) => onChange(value.map((x, j) => (j === i ? v : x)));
  const add    = () => onChange([...value, '']);
  const remove = (i: number) => onChange(value.filter((_, j) => j !== i));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <label style={labelStyle}>Botones de respuesta rápida (hasta {MAX_QUICK_REPLY_BUTTONS}, opcional)</label>
      {value.map((b, i) => (
        <div key={i} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <input
            value={b}
            onChange={(e) => set(i, e.target.value)}
            placeholder={i === 0 ? 'Ej: Sí, recargar' : (i === value.length - 1 ? 'Ej: Ahora no' : `Botón ${i + 1}`)}
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            type="button"
            onClick={() => remove(i)}
            title="Quitar botón"
            style={{ ...smallBtn, background: '#fff', color: '#E53935', border: '1px solid #f08080', padding: '9px 12px' }}
          >
            ✕
          </button>
        </div>
      ))}
      {value.length < MAX_QUICK_REPLY_BUTTONS && (
        <button type="button" onClick={add} style={{ ...smallBtn, alignSelf: 'flex-start' }}>
          + Agregar botón
        </button>
      )}
    </div>
  );
}

// Gestión de plantillas de WhatsApp del tenant (tabla whatsapp_templates).
//
// Modelo INDEPENDIENTE por cuenta: cada plantilla vive en UNA WABA con su propio
// contenido y estado. La misma plantilla puede existir en varias cuentas como filas
// separadas (misma name, distinto waba_id) e independientes: editar, aprobar, prender/
// apagar o eliminar en una NO toca las demás.
//
// La pantalla se organiza por cuenta: un desplegable arriba elige la WABA y abajo se
// ven solo sus plantillas con el estado en esa cuenta. "Ver todas" muestra la matriz
// (agrupada por nombre) con el estado en cada cuenta y permite copiar a las que falten.
//
// Visible para admin y agent: para otros roles no renderiza nada (la API igual exige
// admin o agent server-side para crear/editar/borrar).
export default function WhatsAppTemplatesManager() {
  const { agent } = useAuth();
  const canManage = agent?.role === 'admin' || agent?.role === 'agent';

  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Alta (se crea en la cuenta seleccionada arriba).
  const [name, setName] = useState('');
  const [language, setLanguage] = useState('es');
  const [body, setBody] = useState('');
  const [buttons, setButtons] = useState<string[]>(['', '']);

  // Líneas del tenant → de acá salen las WABAs disponibles y sus nombres.
  const [lines, setLines] = useState<WaLine[]>([]);

  // Cuenta (WABA) elegida arriba + vista matriz.
  const [selectedWaba, setSelectedWaba] = useState<string>('');
  const [viewAll, setViewAll] = useState(false);
  const [copyingId, setCopyingId] = useState<string | null>(null); // fila con el menú "copiar a" abierto

  // Sincronización del estado de aprobación contra Meta.
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

  // Edición inline. En el modelo independiente la WABA NO se cambia acá (es la
  // identidad de la cuenta): para llevar una plantilla a otra cuenta se copia.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editLanguage, setEditLanguage] = useState('es');
  const [editBody, setEditBody] = useState('');
  const [editButtons, setEditButtons] = useState<string[]>(['', '']);

  // Envío a Meta (estado por fila).
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [submitResult, setSubmitResult] = useState<Record<string, { ok: boolean; msg: string }>>({});

  // Negocio verificado en Meta: ahora es SOLO informativo (ya no gatea el botón).
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
  // de la pantalla (1 llamada a la Graph API por WABA). Si Meta falla, el endpoint
  // igual devuelve la lista local, y como último recurso caemos al GET de siempre.
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

  // WABAs distintas del tenant (de sus líneas activas con waba_id).
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

  const multiWaba = wabaOptions.length > 1;

  // Nombre lindo de una WABA para mostrar.
  function wabaLabel(wabaId: string | null | undefined): string {
    if (!wabaId) return 'sin WABA';
    const opt = wabaOptions.find((w) => w.wabaId === wabaId);
    return opt ? opt.labels.join(' · ') : `WABA ${wabaId}`;
  }

  // Cuenta por defecto = la del número default. Fija la cuenta elegida al cargar.
  const defaultLine = lines.find((l) => l.is_default && l.active);
  useEffect(() => {
    if (selectedWaba || wabaOptions.length === 0) return;
    setSelectedWaba(defaultLine?.waba_id || wabaOptions[0].wabaId);
  }, [wabaOptions, defaultLine, selectedWaba]);

  // localStorage da el valor inmediato; el servidor es la fuente de verdad por tenant.
  useEffect(() => {
    try { setVerified(localStorage.getItem('meta_business_verified') === 'true'); } catch {}
    (async () => {
      try {
        const res = await fetch('/api/tenant-settings?key=meta_business_verified');
        if (res.ok) { const d = await res.json(); setVerified(d?.value === 'true'); }
      } catch {}
    })();
  }, []);

  function toggleVerified(v: boolean) {
    setVerified(v);
    try { localStorage.setItem('meta_business_verified', v ? 'true' : 'false'); } catch {}
    fetch('/api/tenant-settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'meta_business_verified', value: v ? 'true' : 'false' }),
    }).catch(() => {});
  }

  if (!canManage) return null;

  // Plantillas que se muestran: en vista de una cuenta, solo las de esa WABA; con un
  // solo WABA (o "Ver todas") se muestran todas.
  const shownTemplates = (!multiWaba || viewAll)
    ? templates
    : templates.filter((t) => t.waba_id === selectedWaba);

  // Cuentas a las que se puede COPIAR una plantilla: las otras WABAs donde ese mismo
  // (nombre, idioma) todavía no existe.
  function copyTargets(t: Template) {
    return wabaOptions.filter((w) =>
      w.wabaId !== t.waba_id &&
      !templates.some((x) => x.name === t.name && (x.language || '') === (t.language || '') && x.waba_id === w.wabaId),
    );
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!name.trim()) { setError('Completá el nombre.'); return; }
    if (!body.trim()) { setError('Completá el cuerpo.'); return; }
    setSaving(true);
    try {
      const res = await fetch('/api/whatsapp-templates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // Se crea en la cuenta elegida arriba. Con una sola WABA va sin waba_id y el
        // server la resuelve (número default).
        body: JSON.stringify({ name: name.trim(), language: language.trim() || 'es', body: body.trim(), buttons: buttons.map((b) => b.trim()).filter(Boolean), waba_id: (multiWaba ? selectedWaba : '') || undefined }),
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

  // Copia el contenido de una plantilla a OTRA cuenta como fila independiente (queda
  // sin enviar a Meta hasta que se la mande). No toca la original.
  async function handleCopyTo(t: Template, targetWaba: string) {
    setError('');
    try {
      const res = await fetch('/api/whatsapp-templates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: t.name, language: t.language || 'es', body: t.body, buttons: Array.isArray(t.buttons) ? t.buttons : [], waba_id: targetWaba }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        setError(d?.error ?? 'No se pudo copiar la plantilla.');
      } else {
        setCopyingId(null);
        await fetchTemplates();
      }
    } catch {
      setError('Error de red.');
    }
  }

  function startEdit(t: Template) {
    setEditingId(t.id);
    setEditName(t.name);
    setEditLanguage(t.language || 'es');
    setEditBody(t.body);
    setEditButtons(t.buttons && t.buttons.length > 0 ? t.buttons.slice(0, MAX_QUICK_REPLY_BUTTONS) : ['', '']);
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
    if (!confirm(`¿Enviar la plantilla "${t.name}" a Meta para aprobación en ${wabaLabel(t.waba_id)} (categoría ${submitCategory})?`)) return;
    setSubmitting(t.id);
    setSubmitResult((p) => { const n = { ...p }; delete n[t.id]; return n; });
    try {
      const res = await fetch('/api/whatsapp-templates/submit-to-meta', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // waba_id explícito: registra el contenido en la cuenta de ESTA fila.
        body: JSON.stringify({ templateId: t.id, category: submitCategory, wabaId: t.waba_id ?? undefined }),
      });
      const d = await res.json().catch(() => null);
      setSubmitResult((p) => ({
        ...p,
        [t.id]: res.ok
          ? { ok: true, msg: '✅ Enviada, pendiente de aprobación' }
          : { ok: false, msg: d?.error ?? 'Error al enviar a Meta' },
      }));
      if (res.ok) await fetchTemplates();
    } catch {
      setSubmitResult((p) => ({ ...p, [t.id]: { ok: false, msg: 'Error de red.' } }));
    }
    setSubmitting(null);
  }

  // Eliminar borra SOLO esta fila = esta cuenta. Si la plantilla existe en otras
  // WABAs, esas quedan intactas; si era la única, desaparece del todo.
  async function handleDelete(t: Template) {
    const otras = templates.filter((x) => x.name === t.name && (x.language || '') === (t.language || '') && x.id !== t.id).length;
    const msg = otras > 0
      ? `¿Eliminar "${t.name}" solo de ${wabaLabel(t.waba_id)}? Seguirá en las otras ${otras} cuenta(s).`
      : `¿Eliminar la plantilla "${t.name}"? Es la única cuenta donde existe, así que desaparece del todo.`;
    if (!confirm(msg)) return;
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

  // ── Card de una plantilla (una cuenta) ─────────────────────────────────────
  function TemplateCard(t: Template) {
    const isEditing = editingId === t.id;
    const targets = copyTargets(t);
    return (
      <div key={t.id} style={{ background: '#F8F8F8', borderRadius: '12px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: '200px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <TemplateStatusDot status={t.approval_status} createdAt={t.created_at} />
              <code style={{ fontSize: '13px', fontWeight: 800, color: '#000', background: '#fff', borderRadius: '6px', padding: '2px 8px' }}>{t.name}</code>
              <span style={{ fontSize: '11px', color: '#888' }}>{t.language}</span>
            </div>
            {!isEditing && (
              <>
                <p style={{ fontSize: '13px', color: '#555', margin: '8px 0 0 0', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{t.body}</p>
                {t.buttons && t.buttons.length > 0 && (
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
                    {t.buttons.map((b, i) => (<span key={i} style={buttonChip}>{b}</span>))}
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
                title="Enviar esta plantilla a Meta para aprobación en esta cuenta"
                style={{ ...smallBtn, background: '#f0fff4', color: '#1a7a3a', border: '1px solid #86efac' }}
              >
                {submitting === t.id ? 'Enviando…' : 'Enviar a Meta'}
              </button>
              {multiWaba && targets.length > 0 && (
                <button
                  onClick={() => setCopyingId(copyingId === t.id ? null : t.id)}
                  title="Copiar este contenido a otra cuenta"
                  style={{ ...smallBtn, background: '#fff', color: '#1a1a1a', border: '1px solid #ddd' }}
                >
                  Copiar a…
                </button>
              )}
              <button onClick={() => handleDelete(t)} style={{ ...smallBtn, background: '#fff', color: '#E53935', border: '1px solid #f08080' }}>Eliminar</button>
            </div>
          )}
        </div>

        {/* Menú "copiar a otra cuenta" */}
        {!isEditing && copyingId === t.id && targets.length > 0 && (
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', borderTop: '1px solid #eee', paddingTop: '10px' }}>
            <span style={{ fontSize: '12px', color: '#888', fontWeight: 700 }}>Copiar a:</span>
            {targets.map((w) => (
              <button key={w.wabaId} onClick={() => handleCopyTo(t, w.wabaId)} style={{ ...smallBtn, background: '#fff', border: '1px solid #ddd' }}>
                {w.labels.join(' · ')}
              </button>
            ))}
            <span style={{ fontSize: '11px', color: '#bbb' }}>Se crea como copia independiente, sin enviar a Meta.</span>
          </div>
        )}

        {isEditing && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', borderTop: '1px solid #eee', paddingTop: '12px' }}>
            <p style={{ fontSize: '12px', color: '#F2994A', fontWeight: 700, margin: 0 }}>
              ⚠ Editar el contenido resetea la aprobación de esta cuenta ({wabaLabel(t.waba_id)}): hay que volver a enviarla a Meta. No afecta a las copias en otras cuentas.
            </p>
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
            <QuickReplyButtonsEditor value={editButtons} onChange={setEditButtons} />
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
  }

  // ── Vista matriz ("Ver todas"): una fila por nombre, estado en cada cuenta ──
  function MatrixView() {
    // Agrupar por (nombre, idioma).
    const groups = new Map<string, { name: string; language: string; rows: Template[] }>();
    for (const t of templates) {
      const k = `${t.name}|${t.language || ''}`;
      const g = groups.get(k) ?? { name: t.name, language: t.language || '', rows: [] };
      g.rows.push(t);
      groups.set(k, g);
    }
    const list = Array.from(groups.values()).sort((a, b) => a.name.localeCompare(b.name));
    if (list.length === 0) return null;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {list.map((g) => {
          const sample = g.rows[0];
          return (
            <div key={`${g.name}|${g.language}`} style={{ background: '#F8F8F8', borderRadius: '12px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <code style={{ fontSize: '13px', fontWeight: 800, color: '#000', background: '#fff', borderRadius: '6px', padding: '2px 8px' }}>{g.name}</code>
                <span style={{ fontSize: '11px', color: '#888' }}>{g.language}</span>
              </div>
              <p style={{ fontSize: '12px', color: '#777', margin: 0, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{sample.body}</p>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                {wabaOptions.map((w) => {
                  const row = g.rows.find((r) => r.waba_id === w.wabaId);
                  return (
                    <div key={w.wabaId} style={{ display: 'flex', alignItems: 'center', gap: '6px', background: '#fff', border: '1px solid #eee', borderRadius: '10px', padding: '6px 10px' }}>
                      <span style={{ fontSize: '11px', fontWeight: 800, color: '#333' }}>{w.labels.join(' · ')}</span>
                      {row ? (
                        <>
                          <TemplateStatusDot status={row.approval_status} createdAt={row.created_at} />
                          <button
                            onClick={() => { setViewAll(false); setSelectedWaba(w.wabaId); }}
                            style={{ ...smallBtn, padding: '4px 8px', fontSize: '11px' }}
                          >
                            Ver
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => handleCopyTo(sample, w.wabaId)}
                          title="Copiar este contenido a esta cuenta"
                          style={{ ...smallBtn, padding: '4px 8px', fontSize: '11px', background: '#f0fff4', color: '#1a7a3a', border: '1px solid #86efac' }}
                        >
                          Copiar acá
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <SectionCard
      title="Plantillas de WhatsApp"
      description="Mensajes predefinidos para usar en campañas Template Meta. Cada cuenta tiene sus propias plantillas."
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

        {/* Selector de cuenta (WABA). Solo si el tenant tiene más de una. */}
        {multiWaba && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', background: '#FAFAFA', borderRadius: '10px', padding: '10px 14px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 700, color: '#333' }}>
              Cuenta:
              <select
                value={viewAll ? '' : selectedWaba}
                onChange={(e) => { setViewAll(false); setSelectedWaba(e.target.value); }}
                style={{ ...inputStyle, width: 'auto', padding: '8px 12px', cursor: 'pointer' }}
              >
                {wabaOptions.map((w) => (
                  <option key={w.wabaId} value={w.wabaId}>{w.labels.join(' · ')}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => setViewAll((v) => !v)}
              style={{ ...smallBtn, background: viewAll ? '#1a1a1a' : '#F5F5F5', color: viewAll ? '#C8FF00' : '#555' }}
            >
              {viewAll ? '← Volver a una cuenta' : '▦ Ver todas las cuentas'}
            </button>
          </div>
        )}

        {/* Estado de aprobación en Meta: se sincroniza solo al abrir la pantalla y a demanda. */}
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
            <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}><span style={{ width: 9, height: 9, borderRadius: '50%', background: '#bbb' }} /> Sin enviar</span>
          </span>
        </div>
        {syncMsg && <p style={{ fontSize: '12px', color: '#888', margin: 0 }}>{syncMsg}</p>}

        {loading && <p style={{ color: '#999', fontSize: '13px', margin: 0 }}>Cargando plantillas...</p>}

        {!loading && (viewAll ? templates.length === 0 : shownTemplates.length === 0) && (
          <p style={{ color: '#999', fontSize: '13px', margin: 0 }}>
            {multiWaba && !viewAll ? `No hay plantillas en ${wabaLabel(selectedWaba)} todavía.` : 'No hay plantillas todavía.'}
          </p>
        )}

        {/* Lista: matriz o cards de la cuenta elegida. */}
        {!loading && (viewAll && multiWaba
          ? <MatrixView />
          : shownTemplates.map((t) => <TemplateCard key={t.id} {...t} />)
        )}

        {error && <p style={{ fontSize: '13px', color: '#E53935', fontWeight: 600, margin: 0 }}>{error}</p>}

        {/* Alta: crea en la cuenta elegida arriba (no en la vista matriz). */}
        {!viewAll && (!showForm ? (
          <button
            onClick={() => { setShowForm(true); setError(''); }}
            style={{ background: '#1a1a1a', color: '#C8FF00', fontWeight: 800, fontSize: '13px', border: 'none', borderRadius: '12px', padding: '10px 20px', cursor: 'pointer', alignSelf: 'flex-start' }}
          >
            + Agregar plantilla{multiWaba ? ` en ${wabaLabel(selectedWaba)}` : ''}
          </button>
        ) : (
          <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: '12px', background: '#FAFAFA', borderRadius: '12px', padding: '16px' }}>
            <p style={{ fontSize: '14px', fontWeight: 800, color: '#000', margin: 0 }}>
              Nueva plantilla{multiWaba ? ` — ${wabaLabel(selectedWaba)}` : ''}
            </p>
            {multiWaba && (
              <p style={{ fontSize: '11px', color: '#bbb', margin: 0 }}>
                Se crea en la cuenta seleccionada arriba. Para tenerla en otra cuenta, después usá “Copiar a…”.
              </p>
            )}
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
            <QuickReplyButtonsEditor value={buttons} onChange={setButtons} />
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
        ))}
      </div>
    </SectionCard>
  );
}
