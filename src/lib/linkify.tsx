import React from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Detecta URLs dentro de un texto y las devuelve como nodos React clickeables.
//
// SEGURIDAD: NO usa dangerouslySetInnerHTML. React escapa el texto y acá se
// controla el href, así que no hay vector de XSS. Defensa extra: solo se linkea
// http/https (un `www.` se prefija con https://); cualquier otro esquema
// (javascript:, data:, …) jamás llega a un href — queda como texto plano.
// ─────────────────────────────────────────────────────────────────────────────

// http(s)://… o www.… hasta el primer espacio o '<'. La poda de puntuación
// final (., ), etc.) la hace trimTrailing — el regex captura de más a propósito.
const URL_RE = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi;

// Recorta puntuación de cierre pegada al final de una URL para que no entre en el
// link: "mirá (https://x.com)." → el link es https://x.com y ")." queda como
// texto. Balancea paréntesis (una URL de Wikipedia con ')' legítimo se respeta).
function trimTrailing(url: string): { url: string; tail: string } {
  let tail = '';
  while (url.length > 0) {
    const last = url[url.length - 1];
    if (`.,;:!?"'`.includes(last)) {
      tail = last + tail;
      url = url.slice(0, -1);
      continue;
    }
    if (last === ')') {
      const opens = (url.match(/\(/g) ?? []).length;
      const closes = (url.match(/\)/g) ?? []).length;
      if (closes > opens) { tail = last + tail; url = url.slice(0, -1); continue; }
    }
    break;
  }
  return { url, tail };
}

const linkStyle: React.CSSProperties = {
  color: 'inherit',
  textDecoration: 'underline',
  wordBreak: 'break-all',
};

// Convierte un texto plano en una lista de nodos React, con las URLs como <a>.
// Si no hay ninguna URL, devuelve el texto tal cual.
export function linkify(text: string): React.ReactNode {
  if (!text) return text;

  const out: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  URL_RE.lastIndex = 0;

  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    const raw = m[0];
    const start = m.index;
    const { url: clean, tail } = trimTrailing(raw);
    const href = clean.startsWith('www.') ? `https://${clean}` : clean;

    // Paranoia: solo http/https terminan en un href. Cualquier otra cosa se deja
    // como texto (no se avanza lastIndex, lo emite el slice de la próxima vuelta).
    if (!/^https?:\/\//i.test(href)) continue;

    if (start > lastIndex) out.push(text.slice(lastIndex, start));
    out.push(
      <a
        key={key++}
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        style={linkStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {clean}
      </a>,
    );
    if (tail) out.push(tail);
    lastIndex = start + raw.length;
  }

  if (lastIndex < text.length) out.push(text.slice(lastIndex));
  return out.length > 0 ? out : text;
}
