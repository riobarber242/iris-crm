"use client";

import React, { useEffect, useState } from 'react';

type Campaign = {
  id: string;
  name: string;
  message: string;
  target_filter: string;
  status: 'borrador' | 'enviando' | 'completada';
  sent_count: number;
  created_at: string;
};

const STATUS_STYLE: Record<string, React.CSSProperties> = {
  borrador:   { background: '#F0F0F0', color: '#888' },
  enviando:   { background: '#fff8d6', color: '#b8860b', border: '1px solid #f0c040' },
  completada: { background: '#e8fff0', color: '#1a7a3a', border: '1px solid #5ad87a' },
};

const FILTERS = [
  { value: 'todos',          label: 'Todos los contactos' },
  { value: 'cliente_activo', label: 'Cliente activo' },
  { value: 'inactivo',       label: 'Inactivo' },
  { value: 'nuevo',          label: 'Nuevo' },
];

export default function CampanasClient() {
  const [campaigns,      setCampaigns]      = useState<Campaign[]>([]);
  const [showForm,       setShowForm]       = useState(false);
  const [sending,        setSending]        = useState<string | null>(null);
  const [name,           setName]           = useState('');
  const [message,        setMessage]        = useState('');
  const [filter,         setFilter]         = useState('todos');
  const [creating,       setCreating]       = useState(false);
  const [error,          setError]          = useState('');
  const [sendResult,     setSendResult]     = useState<{ campaignId: string; sent: number; total: number } | null>(null);
  const [recipientCount, setRecipientCount] = useState<number | null>(null);
  const [countLoading,   setCountLoading]   = useState(false);

  async function fetchCampaigns() {
    try {
      const res = await fetch('/api/campaigns');
      if (!res.ok) return;
      setCampaigns(await res.json());
    } catch {}
  }

  useEffect(() => {
    fetchCampaigns();
    const t = setInterval(fetchCampaigns, 10_000);
    return () => clearInterval(t);
  }, []);

  async function fetchRecipientCount(f: string) {
    setCountLoading(true);
    setRecipientCount(null);
    try {
      const param = f === 'todos' ? '?all=true' : `?status=${f}`;
      const res = await fetch(`/api/contacts${param}`);
      if (!res.ok) return;
      const data = await res.json();
      setRecipientCount(Array.isArray(data) ? data.length : null);
    } catch {}
    setCountLoading(false);
  }

  function handleFilterChange(f: string) {
    setFilter(f);
    fetchRecipientCount(f);
  }

  async function handleDelete(campaign: Campaign) {
    if (!confirm(`¿Eliminar la campaña "${campaign.name}"? Esta acción no se puede deshacer.`)) return;
    try {
      await fetch('/api/campaigns', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ campaignId: campaign.id }),
      });
      await fetchCampaigns();
    } catch {}
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !message.trim()) {
      setError('Completá el nombre y el mensaje.');
      return;
    }
    setCreating(true);
    setError('');
    try {
      const res = await fetch('/api/campaigns', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: name.trim(), message: message.trim(), target_filter: filter }),
      });
      if (!res.ok) throw new Error(await res.text());
      setName('');
      setMessage('');
      setFilter('todos');
      setShowForm(false);
      await fetchCampaigns();
    } catch (err: any) {
      setError(err.message ?? 'Error al crear la campaña.');
    }
    setCreating(false);
  }

  async function handleSend(campaign: Campaign) {
    if (!confirm(`¿Enviar "${campaign.name}" a todos los contactos con filtro "${campaign.target_filter}"? Esta acción no se puede deshacer.`)) return;
    setSending(campaign.id);
    setSendResult(null);
    try {
      const res = await fetch('/api/campaigns/send', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ campaignId: campaign.id }),
      });
      const data = await res.json();
      if (res.ok) {
        setSendResult({ campaignId: campaign.id, sent: data.sent, total: data.total });
      } else {
        alert(`Error: ${data?.error ?? res.statusText}`);
      }
    } catch {
      alert('Error de red al enviar la campaña.');
    }
    setSending(null);
    await fetchCampaigns();
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

      {/* Header + botón nueva campaña */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 900, color: '#000', margin: 0 }}>Campañas</h1>
          <p style={{ fontSize: '13px', color: '#999', margin: '4px 0 0 0' }}>
            Mensajes masivos segmentados por tipo de contacto.
          </p>
        </div>
        <button
          onClick={() => { setShowForm((v) => { if (!v) fetchRecipientCount('todos'); return !v; }); setError(''); }}
          style={{
            background: '#1a1a1a', color: '#C8FF00', fontWeight: 800, fontSize: '13px',
            border: 'none', borderRadius: '12px', padding: '10px 20px', cursor: 'pointer',
          }}
        >
          {showForm ? '✕ Cancelar' : '+ Nueva campaña'}
        </button>
      </div>

      {/* Formulario nueva campaña */}
      {showForm && (
        <form
          onSubmit={handleCreate}
          style={{
            background: '#fff', borderRadius: '16px', padding: '20px 24px',
            boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
            display: 'flex', flexDirection: 'column', gap: '14px',
          }}
        >
          <p style={{ fontSize: '15px', fontWeight: 800, color: '#000', margin: 0 }}>Nueva campaña</p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '11px', fontWeight: 700, color: '#999', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              Nombre
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ej: Promo junio 2026"
              style={{
                background: '#F5F5F5', border: 'none', borderRadius: '10px',
                padding: '10px 14px', fontSize: '14px', color: '#000', outline: 'none',
              }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '11px', fontWeight: 700, color: '#999', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              Destinatarios
            </label>
            <select
              value={filter}
              onChange={(e) => handleFilterChange(e.target.value)}
              style={{
                background: '#F5F5F5', border: 'none', borderRadius: '10px',
                padding: '10px 14px', fontSize: '14px', color: '#000', outline: 'none', cursor: 'pointer',
              }}
            >
              {FILTERS.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
            {recipientCount !== null && (
              <p style={{ fontSize: '12px', color: '#555', margin: 0, fontWeight: 600 }}>
                {countLoading ? 'Contando...' : `${recipientCount} contacto${recipientCount !== 1 ? 's' : ''} recibirán este mensaje`}
              </p>
            )}
            {countLoading && recipientCount === null && (
              <p style={{ fontSize: '12px', color: '#bbb', margin: 0 }}>Contando destinatarios...</p>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '11px', fontWeight: 700, color: '#999', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              Mensaje
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Escribí el mensaje que van a recibir..."
              rows={4}
              style={{
                background: '#F5F5F5', border: 'none', borderRadius: '10px',
                padding: '10px 14px', fontSize: '14px', color: '#000', outline: 'none',
                resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5,
              }}
            />
            <p style={{ fontSize: '11px', color: '#bbb', margin: 0 }}>
              {message.length} caracteres
            </p>
          </div>

          {error && (
            <p style={{ fontSize: '13px', color: '#E53935', fontWeight: 600, margin: 0 }}>{error}</p>
          )}

          <button
            type="submit"
            disabled={creating}
            style={{
              background: creating ? '#e0e0e0' : '#C8FF00', color: '#000',
              fontWeight: 800, fontSize: '14px', border: 'none',
              borderRadius: '12px', padding: '12px 20px', cursor: creating ? 'not-allowed' : 'pointer',
              opacity: creating ? 0.6 : 1, alignSelf: 'flex-start',
            }}
          >
            {creating ? 'Guardando...' : 'Guardar campaña'}
          </button>
        </form>
      )}

      {/* Aviso límite WhatsApp */}
      <div style={{
        background: '#fffbe6', border: '1px solid #f0c040',
        borderRadius: '12px', padding: '12px 16px',
        display: 'flex', gap: '10px', alignItems: 'flex-start',
      }}>
        <span style={{ fontSize: '16px', flexShrink: 0 }}>⚠️</span>
        <p style={{ fontSize: '13px', color: '#7a5c00', margin: 0, lineHeight: 1.6 }}>
          <strong>Límite de WhatsApp:</strong> Solo podés enviar mensajes libres a contactos que te escribieron en las últimas 24 horas.
          Para contactos inactivos es necesario usar plantillas (templates) aprobadas por Meta.
          Los envíos a contactos fuera de ventana pueden fallar silenciosamente.
        </p>
      </div>

      {/* Lista de campañas */}
      {campaigns.length === 0 && !showForm && (
        <div style={{ textAlign: 'center', padding: '48px 0', color: '#999', fontSize: '14px' }}>
          No hay campañas. Creá la primera con el botón de arriba.
        </div>
      )}

      {campaigns.map((campaign) => {
        const estilo   = STATUS_STYLE[campaign.status] ?? STATUS_STYLE.borrador;
        const isSending = sending === campaign.id;
        const result    = sendResult?.campaignId === campaign.id ? sendResult : null;

        return (
          <div
            key={campaign.id}
            style={{
              background: '#fff', borderRadius: '16px', padding: '18px 22px',
              boxShadow: '0 2px 10px rgba(0,0,0,0.07)',
              display: 'flex', flexDirection: 'column', gap: '10px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
              <div>
                <p style={{ fontSize: '16px', fontWeight: 800, color: '#000', margin: 0 }}>{campaign.name}</p>
                <p style={{ fontSize: '12px', color: '#aaa', margin: '3px 0 0 0' }}>
                  Filtro: <strong>{campaign.target_filter}</strong>
                  {' · '}
                  {new Date(campaign.created_at).toLocaleDateString('es-AR')}
                  {campaign.sent_count > 0 && ` · Enviados: ${campaign.sent_count}`}
                </p>
              </div>
              <span style={{
                ...estilo,
                fontSize: '11px', fontWeight: 800,
                letterSpacing: '0.06em', textTransform: 'uppercase',
                padding: '4px 12px', borderRadius: '20px', whiteSpace: 'nowrap',
              }}>
                {campaign.status}
              </span>
            </div>

            <p style={{
              fontSize: '13px', color: '#555', lineHeight: 1.6,
              background: '#F8F8F8', borderRadius: '10px', padding: '10px 14px', margin: 0,
            }}>
              {campaign.message}
            </p>

            {result && (
              <p style={{ fontSize: '13px', color: '#1a7a3a', fontWeight: 700, margin: 0 }}>
                ✅ Enviado a {result.sent} de {result.total} contactos.
              </p>
            )}

            {campaign.status === 'borrador' && (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button
                  onClick={() => handleSend(campaign)}
                  disabled={isSending}
                  style={{
                    background: isSending ? '#e0e0e0' : '#1a1a1a', color: isSending ? '#999' : '#C8FF00',
                    fontWeight: 800, fontSize: '13px', border: 'none',
                    borderRadius: '10px', padding: '9px 18px', cursor: isSending ? 'not-allowed' : 'pointer',
                    opacity: isSending ? 0.6 : 1,
                  }}
                >
                  {isSending ? 'Enviando...' : 'Enviar campaña'}
                </button>
                <button
                  onClick={() => handleDelete(campaign)}
                  style={{
                    background: 'transparent', color: '#E53935', fontWeight: 700, fontSize: '13px',
                    border: '1px solid #f08080', borderRadius: '10px', padding: '9px 14px', cursor: 'pointer',
                  }}
                >
                  Eliminar
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
