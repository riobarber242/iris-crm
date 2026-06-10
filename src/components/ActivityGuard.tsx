'use client';

import { useEffect, useRef, useState, useCallback, type ReactNode } from 'react';

// Sistema de actividad para operadores: tras 20 min de inactividad aparece un
// popup con countdown de 60 s. Si no responde, cierra la sesión y redirige a
// /login. Sólo se monta para el rol operator (ver AdminShell).
const INACTIVITY_MS     = 20 * 60 * 1000; // 20 minutos
const COUNTDOWN_SECONDS = 60;
const IRIS = '#F97316';

export default function ActivityGuard({ children }: { children: ReactNode }) {
  const [showPopup,   setShowPopup]   = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(COUNTDOWN_SECONDS);

  const inactivityTimer = useRef<ReturnType<typeof setTimeout>  | null>(null);
  const logoutTimer     = useRef<ReturnType<typeof setTimeout>  | null>(null);
  const countdownTimer  = useRef<ReturnType<typeof setInterval> | null>(null);
  // Espejo en ref para que el listener de actividad sepa si el popup está abierto
  // sin re-suscribirse en cada render.
  const popupOpenRef    = useRef(false);

  // Cierre de sesión: custom auth del proyecto (no usa next-auth). Avisa al
  // backend y redirige a /login con el motivo para mostrar el mensaje.
  const doLogout = useCallback(async () => {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
    window.location.href = '/login?reason=inactividad';
  }, []);

  const clearCountdown = useCallback(() => {
    if (logoutTimer.current)    { clearTimeout(logoutTimer.current);    logoutTimer.current    = null; }
    if (countdownTimer.current) { clearInterval(countdownTimer.current); countdownTimer.current = null; }
  }, []);

  // (Re)arranca el timer de 20 min. Se llama al montar y con cada acción del usuario.
  const startInactivityTimer = useCallback(() => {
    if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    inactivityTimer.current = setTimeout(() => {
      popupOpenRef.current = true;
      setShowPopup(true);
      setSecondsLeft(COUNTDOWN_SECONDS);
      countdownTimer.current = setInterval(() => {
        setSecondsLeft((s) => Math.max(0, s - 1));
      }, 1000);
      logoutTimer.current = setTimeout(doLogout, COUNTDOWN_SECONDS * 1000);
    }, INACTIVITY_MS);
  }, [doLogout]);

  // "Sí, sigo activo": cierra el popup y reinicia el ciclo de 20 min.
  const stayActive = useCallback(() => {
    popupOpenRef.current = false;
    setShowPopup(false);
    clearCountdown();
    startInactivityTimer();
  }, [clearCountdown, startInactivityTimer]);

  useEffect(() => {
    startInactivityTimer();

    const onActivity = () => {
      // Mientras el popup está abierto sólo el botón resetea (no la actividad).
      if (popupOpenRef.current) return;
      startInactivityTimer();
    };

    const events = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'] as const;
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));

    return () => {
      events.forEach((e) => window.removeEventListener(e, onActivity));
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
      clearCountdown();
    };
  }, [startInactivityTimer, clearCountdown]);

  // Geometría del countdown circular.
  const SIZE = 132;
  const STROKE = 9;
  const R = (SIZE - STROKE) / 2;
  const CIRC = 2 * Math.PI * R;
  const offset = CIRC * (1 - secondsLeft / COUNTDOWN_SECONDS);

  return (
    <>
      {children}

      {showPopup && (
        <div
          // Fondo oscuro semitransparente; no se cierra al hacer click fuera.
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: '24px',
            fontFamily: "'DM Sans', system-ui, sans-serif",
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            style={{
              background: '#fff',
              borderRadius: '24px',
              padding: '36px 32px 32px',
              width: '100%',
              maxWidth: '380px',
              boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              textAlign: 'center',
            }}
          >
            <h2 style={{ fontFamily: "'DM Sans', system-ui, sans-serif", fontSize: '24px', fontWeight: 800, color: '#0a0a0a', margin: 0 }}>
              ¿Seguís activo?
            </h2>
            <p style={{ fontFamily: "'DM Sans', system-ui, sans-serif", fontSize: '14px', fontWeight: 500, color: '#666', margin: '8px 0 24px' }}>
              Tu sesión se cerrará por inactividad en {secondsLeft} segundos
            </p>

            {/* Countdown circular animado */}
            <div style={{ position: 'relative', width: SIZE, height: SIZE, marginBottom: '28px' }}>
              <svg width={SIZE} height={SIZE} style={{ transform: 'rotate(-90deg)' }}>
                <circle
                  cx={SIZE / 2} cy={SIZE / 2} r={R}
                  fill="none" stroke="#F0F0F0" strokeWidth={STROKE}
                />
                <circle
                  cx={SIZE / 2} cy={SIZE / 2} r={R}
                  fill="none" stroke={IRIS} strokeWidth={STROKE}
                  strokeLinecap="round"
                  strokeDasharray={CIRC}
                  strokeDashoffset={offset}
                  style={{ transition: 'stroke-dashoffset 1s linear' }}
                />
              </svg>
              <span style={{
                position: 'absolute', inset: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: "'DM Sans', system-ui, sans-serif",
                fontSize: '40px', fontWeight: 800, color: IRIS,
              }}>
                {secondsLeft}
              </span>
            </div>

            <button
              onClick={stayActive}
              style={{
                width: '100%',
                background: IRIS,
                color: '#fff',
                fontFamily: "'DM Sans', system-ui, sans-serif",
                fontSize: '16px',
                fontWeight: 800,
                border: 'none',
                borderRadius: '14px',
                padding: '16px',
                cursor: 'pointer',
                boxShadow: '0 6px 18px rgba(249,115,22,0.4)',
              }}
            >
              Sí, sigo activo
            </button>
          </div>
        </div>
      )}
    </>
  );
}
