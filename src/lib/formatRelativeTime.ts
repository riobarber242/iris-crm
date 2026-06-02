const DAYS_ES   = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export function formatRelativeTime(dateStr: string): string {
  const now  = new Date();
  const date = new Date(dateStr);
  const diffMs  = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);

  if (diffMin < 1)  return 'ahora';
  if (diffMin < 60) return `hace ${diffMin} min`;

  const hh = date.getHours().toString().padStart(2, '0');
  const mm  = date.getMinutes().toString().padStart(2, '0');
  const timeStr = `${hh}:${mm}`;

  const todayStart     = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(todayStart.getDate() - 1);
  const weekStart      = new Date(todayStart); weekStart.setDate(todayStart.getDate() - 6);

  if (date >= todayStart)     return timeStr;
  if (date >= yesterdayStart) return `ayer ${timeStr}`;
  if (date >= weekStart)      return `${DAYS_ES[date.getDay()]} ${timeStr}`;

  const sameYear = date.getFullYear() === now.getFullYear();
  return sameYear
    ? `${date.getDate()} ${MONTHS_ES[date.getMonth()]}`
    : `${date.getDate()} ${MONTHS_ES[date.getMonth()]} ${date.getFullYear()}`;
}
