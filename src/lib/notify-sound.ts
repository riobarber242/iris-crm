'use client';

// Dos sonidos sintetizados (sin archivos de audio) para avisar pendientes nuevos.
//  · naranja → un beep suave.
//  · rojo    → doble beep más agudo y urgente.
// Usa WebAudio; best-effort (puede estar bloqueado hasta que haya interacción
// del usuario, según la política de autoplay del navegador).

function tone(ctx: AudioContext, freq: number, start: number, dur: number, vol = 0.22) {
  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type            = 'sine';
  osc.frequency.value = freq;
  const t0 = ctx.currentTime + start;
  gain.gain.setValueAtTime(vol, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.start(t0);
  osc.stop(t0 + dur);
}

export function playPendingSound(kind: 'orange' | 'red') {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    if (kind === 'red') {
      tone(ctx, 1046, 0,    0.16); // C6
      tone(ctx, 1318, 0.20, 0.30); // E6 — segundo beep, más urgente
    } else {
      tone(ctx, 740, 0, 0.32);     // F#5 — un beep suave
    }
  } catch {}
}
