'use client';

import { useEffect, useState } from 'react';

type QuickReply = { id: string; title: string; content: string };

export default function QuickRepliesManager() {
  // Colapsada por defecto: con muchas plantillas cargadas la sección empujaba todo
  // lo demás de Configuración fuera de la pantalla. El contador en el botón dice
  // cuántas hay sin necesidad de abrirla.
  const [abierto, setAbierto] = useState(false);
  const [replies, setReplies] = useState<QuickReply[]>([]);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');

  async function load() {
    const res = await fetch('/api/quick-replies');
    if (res.ok) setReplies(await res.json());
  }

  useEffect(() => { load(); }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !content.trim() || saving) return;
    setSaving(true);
    const res = await fetch('/api/quick-replies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content }),
    });
    if (res.ok) {
      setTitle('');
      setContent('');
      await load();
    }
    setSaving(false);
  }

  function startEdit(r: QuickReply) {
    setEditingId(r.id);
    setEditTitle(r.title);
    setEditContent(r.content);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditTitle(null);
    setEditContent('');
  }

  async function handleUpdate(id: string) {
    if (!editTitle?.trim() || !editContent.trim()) return;
    const res = await fetch('/api/quick-replies', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, title: editTitle, content: editContent }),
    });
    if (res.ok) {
      cancelEdit();
      await load();
    }
  }

  async function handleDelete(id: string) {
    await fetch('/api/quick-replies', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    setReplies((r) => r.filter((x) => x.id !== id));
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Desplegar / ocultar. Mismo estilo que el botón colapsable de los motivos
          de fallo en Campañas. */}
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        aria-expanded={abierto}
        style={{
          alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: '8px',
          background: 'transparent', border: '1px solid #dcdcd6', borderRadius: '10px',
          padding: '8px 13px', fontSize: '13px', fontWeight: 700, color: '#333',
          cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        <span style={{ fontSize: '15px' }}>⚡</span>
        {abierto ? 'Ocultar las respuestas rápidas' : 'Ver las respuestas rápidas'}
        <span style={{ background: '#F0F0EA', color: '#666', borderRadius: '20px', padding: '1px 8px', fontSize: '11px', fontWeight: 800 }}>
          {replies.length}
        </span>
        <span style={{ fontSize: '10px', color: '#888' }}>{abierto ? '▴' : '▾'}</span>
      </button>

      {abierto && (
        <>
      {/* Existing replies */}
      {replies.length === 0 && (
        <p style={{ fontSize: '14px', color: '#999', margin: 0 }}>
          No hay respuestas rápidas. Creá la primera abajo.
        </p>
      )}
      {replies.map((r) => (
        <div
          key={r.id}
          style={{
            background: '#F5F5F5',
            borderRadius: '14px',
            padding: '14px 18px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: '12px',
          }}
        >
          {editingId === r.id ? (
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <input
                value={editTitle ?? ''}
                onChange={(e) => setEditTitle(e.target.value)}
                placeholder="Título"
                style={{ background: '#fff', border: 'none', borderRadius: '12px', padding: '12px 16px', fontSize: '14px', color: '#1a1a1a', outline: 'none' }}
              />
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                placeholder="Mensaje..."
                rows={3}
                style={{ background: '#fff', border: 'none', borderRadius: '12px', padding: '12px 16px', fontSize: '14px', color: '#1a1a1a', outline: 'none', resize: 'vertical', fontFamily: 'inherit' }}
              />
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => handleUpdate(r.id)}
                  disabled={!editTitle?.trim() || !editContent.trim()}
                  style={{
                    background: !editTitle?.trim() || !editContent.trim() ? '#e0e0e0' : '#C8FF00',
                    color: '#000',
                    fontWeight: 700,
                    fontSize: '14px',
                    border: 'none',
                    borderRadius: '12px',
                    padding: '10px 18px',
                    cursor: !editTitle?.trim() || !editContent.trim() ? 'not-allowed' : 'pointer',
                  }}
                >
                  Guardar
                </button>
                <button
                  onClick={cancelEdit}
                  style={{ background: '#fff', color: '#1a1a1a', fontWeight: 700, fontSize: '14px', border: 'none', borderRadius: '12px', padding: '10px 18px', cursor: 'pointer' }}
                >
                  Cancelar
                </button>
              </div>
            </div>
          ) : (
            <>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#999', margin: '0 0 4px 0' }}>
                  {r.title}
                </p>
                <p style={{ fontSize: '14px', color: '#1a1a1a', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {r.content}
                </p>
              </div>
              <button
                onClick={() => startEdit(r)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: '16px', lineHeight: 1, padding: '2px', flexShrink: 0 }}
                title="Editar"
              >
                ✏️
              </button>
              <button
                onClick={() => handleDelete(r.id)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: '18px', lineHeight: 1, padding: '2px', flexShrink: 0 }}
                title="Eliminar"
              >
                ×
              </button>
            </>
          )}
        </div>
      ))}

      {/* Create form */}
      <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: '10px', borderTop: '1px solid #eee', paddingTop: '16px' }}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder='Título (ej: "Saludo inicial")'
          style={{ background: '#F5F5F5', border: 'none', borderRadius: '12px', padding: '12px 16px', fontSize: '14px', color: '#1a1a1a', outline: 'none' }}
        />
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Mensaje..."
          rows={3}
          style={{ background: '#F5F5F5', border: 'none', borderRadius: '12px', padding: '12px 16px', fontSize: '14px', color: '#1a1a1a', outline: 'none', resize: 'vertical', fontFamily: 'inherit' }}
        />
        <button
          type="submit"
          disabled={saving || !title.trim() || !content.trim()}
          style={{
            background: saving || !title.trim() || !content.trim() ? '#e0e0e0' : '#C8FF00',
            color: '#000',
            fontWeight: 700,
            fontSize: '14px',
            border: 'none',
            borderRadius: '12px',
            padding: '12px 20px',
            cursor: saving || !title.trim() || !content.trim() ? 'not-allowed' : 'pointer',
            alignSelf: 'flex-start',
          }}
        >
          {saving ? 'Guardando...' : '+ Agregar respuesta rápida'}
        </button>
      </form>
        </>
      )}
    </div>
  );
}
