"use client";

import React, { useState } from 'react';

export default function CronRunner() {
  const [loading,  setLoading]  = useState(false);
  const [result,   setResult]   = useState<{ updated: number } | null>(null);
  const [error,    setError]    = useState('');

  async function run() {
    setLoading(true);
    setResult(null);
    setError('');
    try {
      const res = await fetch('/api/cron/clasificar');
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setResult(data);
    } catch (err: any) {
      setError(err.message ?? 'Error al ejecutar la clasificación.');
    }
    setLoading(false);
  }

  return (
    <div style={{
      background: '#fff', borderRadius: '16px', padding: '20px 24px',
      boxShadow: '0 2px 10px rgba(0,0,0,0.07)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px',
    }}>
      <div>
        <p style={{ fontSize: '15px', fontWeight: 800, color: '#000', margin: 0 }}>
          Clasificación de contactos
        </p>
        <p style={{ fontSize: '13px', color: '#999', margin: '4px 0 0 0' }}>
          Actualiza el estado (cliente activo / inactivo) según comprobantes verificados.
          {result !== null && (
            <span style={{ color: '#1a7a3a', fontWeight: 700 }}>
              {' '}✅ {result.updated} contacto{result.updated !== 1 ? 's' : ''} actualizado{result.updated !== 1 ? 's' : ''}.
            </span>
          )}
          {error && (
            <span style={{ color: '#E53935', fontWeight: 700 }}> ✗ {error}</span>
          )}
        </p>
      </div>

      <button
        onClick={run}
        disabled={loading}
        style={{
          background: loading ? '#e0e0e0' : '#1a1a1a',
          color: loading ? '#999' : '#C8FF00',
          fontWeight: 800, fontSize: '13px', border: 'none',
          borderRadius: '999px', padding: '10px 20px',
          cursor: loading ? 'not-allowed' : 'pointer',
          opacity: loading ? 0.6 : 1,
          transition: 'all 0.2s', whiteSpace: 'nowrap',
        }}
      >
        {loading ? 'Ejecutando...' : 'Ejecutar ahora'}
      </button>
    </div>
  );
}
