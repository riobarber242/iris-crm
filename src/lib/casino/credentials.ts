// Template editable (por tenant) del mensaje de credenciales del casino.
// Mismo espíritu que DEFAULT_OFFLINE_MSG/getOfflineMsg: hay un default y el
// tenant puede sobreescribirlo desde Configuración → Casino (settings key
// 'casino_credentials_template'). Sin saludo con nombre.
//
// Placeholders soportados:
//   {username}  → usuario creado en el casino
//   {password}  → contraseña (editable en el modal)
//   {link1}     → URL para jugadores (casino_player_url, con fallback)
//   {link2}     → URL para jugadores 2 (casino_player_url_2, OPCIONAL)
// Si no hay {link2} cargado, la línea que lo contiene se omite por completo.

export const DEFAULT_CASINO_CREDENTIALS_TEMPLATE =
  'Usuario: {username}\n' +
  'Contraseña: {password}\n' +
  '👉 {link1}\n' +
  '      {link2}\n' +
  'Ingresá y ya podés comenzar 😊';

export function renderCredentials(
  template: string | null | undefined,
  vars: { username: string; password: string; link1: string; link2?: string | null },
): string {
  const tpl = (template && template.trim()) ? template : DEFAULT_CASINO_CREDENTIALS_TEMPLATE;
  const link2 = (vars.link2 ?? '').trim();

  // Sin segundo link → se omite por completo la línea que contiene {link2}
  // (incluye la sangría/emoji que la acompañe en esa línea).
  const base = link2
    ? tpl
    : tpl.split('\n').filter((line) => !line.includes('{link2}')).join('\n');

  return base
    .replace(/\{username\}/g, vars.username)
    .replace(/\{password\}/g, vars.password)
    .replace(/\{link1\}/g, (vars.link1 ?? '').trim())
    .replace(/\{link2\}/g, link2);
}
