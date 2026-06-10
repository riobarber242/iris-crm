'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState('');
  const [notice,   setNotice]   = useState('');
  const [loading,  setLoading]  = useState(false);
  const router = useRouter();

  // Mensaje de sesión cerrada por inactividad (?reason=inactividad).
  useEffect(() => {
    const reason = new URLSearchParams(window.location.search).get('reason');
    if (reason === 'inactividad') setNotice('Sesión cerrada por inactividad');
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username: username.trim(), password }),
      });
      if (res.ok) {
        const d = await res.json().catch(() => ({}));
        // Los operators no tienen dashboard → van directo a Conversaciones.
        router.push(d.role === 'operator' ? '/conversations' : '/dashboard');
        router.refresh();
      } else {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? 'No se pudo iniciar sesión');
        setLoading(false);
      }
    } catch {
      setError('Error de red. Probá de nuevo.');
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh', background: '#F5F5F5',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px',
    }}>
      <form
        onSubmit={submit}
        style={{
          background: '#FFFFFF', borderRadius: '22px', padding: '36px 32px',
          width: '100%', maxWidth: '380px',
          boxShadow: '0 8px 40px rgba(0,0,0,0.12)',
          display: 'flex', flexDirection: 'column', gap: '18px',
        }}
      >
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: '4px' }}>
          <span style={{
            fontSize: '40px', fontWeight: 900, color: '#000', letterSpacing: '-1px',
          }}>
            IRIS
          </span>
          <p style={{ fontSize: '13px', color: '#999', margin: '4px 0 0 0' }}>Iniciá sesión para continuar</p>
        </div>

        {notice && (
          <div style={{
            background: '#FFF3E0', color: '#E65100', borderRadius: '10px',
            padding: '10px 14px', fontSize: '13px', fontWeight: 600, textAlign: 'center',
          }}>
            {notice}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label style={{ fontSize: '12px', fontWeight: 700, color: '#666', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Usuario</label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
            placeholder="usuario"
            style={inputStyle}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label style={{ fontSize: '12px', fontWeight: 700, color: '#666', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Contraseña</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            placeholder="••••••••"
            style={inputStyle}
          />
        </div>

        {error && (
          <div style={{
            background: '#FFE5E5', color: '#CC3333', borderRadius: '10px',
            padding: '10px 14px', fontSize: '13px', fontWeight: 600,
          }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          style={{
            background: loading ? '#e0e0e0' : '#C8FF00',
            color: '#000', fontWeight: 800, fontSize: '15px',
            border: 'none', borderRadius: '12px', padding: '14px',
            cursor: loading ? 'not-allowed' : 'pointer',
            boxShadow: loading ? 'none' : '0 4px 14px rgba(200,255,0,0.4)',
            marginTop: '4px',
          }}
        >
          {loading ? 'Ingresando…' : 'Ingresar'}
        </button>
      </form>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: '#F5F5F5', border: '2px solid #eee', borderRadius: '12px',
  padding: '12px 14px', fontSize: '15px', color: '#1a1a1a', outline: 'none',
};
