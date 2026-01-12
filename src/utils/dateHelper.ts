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
