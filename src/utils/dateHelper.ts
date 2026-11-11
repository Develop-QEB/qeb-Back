/**
 * Obtiene la fecha actual ajustada a la zona horaria de México (America/Mexico_City)
 * Usa Date.UTC para que la fecha se almacene en MySQL sin conversión de timezone
 */
export function getMexicoDate(): Date {
  const now = new Date();

  // Obtener componentes de fecha/hora en zona horaria de México
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(now);
  const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value || '0');

  // Usar Date.UTC para crear la fecha como si fuera UTC
  // Así cuando Prisma la envíe a MySQL, se guardará con los valores exactos de México
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')));
}

/**
 * Normaliza una hora a formato "HH:MM" (24h). Acepta "H:MM", "HH:MM",
 * "HH:MM:SS" y recorta a HH:MM. Devuelve null si no es una hora válida
 * (hora 0-23, minuto 0-59). Se usa para el horario de circuitos DIGITALES
 * (feature "Horario inicio/fin - Digital"); el resto de tipos guarda null.
 */
export function normalizaHoraHHMM(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
