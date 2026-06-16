import prisma from '../utils/prisma';

/**
 * Cron a medianoche (CDMX): alinea el status MANUAL con la realidad de fechas
 * SOLO para las campañas que quedaron pegadas en "Por iniciar".
 *
 * Una campaña que se aprobó se pone en "Por iniciar" y ahí se queda si nadie la
 * mueve a mano. Si su fecha_fin ya pasó (dinámicamente "Pasada"), su status
 * manual "Por iniciar" es engañoso. Este job la pasa a "finalizada".
 *
 * IMPORTANTE: solo toca las "Por iniciar". Los estados que el usuario pone a
 * propósito (Cancelada, Rechazada, Pausada, inactiva) y los que ya avanzaron
 * (En Operacion, finalizada, etc.) NO se tocan — ni siquiera entran al filtro.
 *
 * Criterio "Pasada" idéntico a getPeriodStatus del front: hoy(00:00) > fin(23:59),
 * o sea el día DESPUÉS de fecha_fin → `DATE(fecha_fin) < hoy_CDMX`.
 */
export async function finalizarCampanasPorIniciarVencidas(): Promise<number> {
  // Fecha de "hoy" en CDMX como 'YYYY-MM-DD' (la zona del server puede diferir).
  const nowMx = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  const hoyMx = `${nowMx.getFullYear()}-${String(nowMx.getMonth() + 1).padStart(2, '0')}-${String(nowMx.getDate()).padStart(2, '0')}`;

  const result = await prisma.$executeRawUnsafe(
    `UPDATE campania
     SET status = 'finalizada'
     WHERE LOWER(TRIM(status)) = 'por iniciar'
       AND fecha_fin IS NOT NULL
       AND DATE(fecha_fin) < ?`,
    hoyMx
  );
  const n = Number(result) || 0;
  console.log(`[FinalizarCampanas] ${n} campaña(s) "Por iniciar" ya vencidas → "finalizada" (hoy CDMX ${hoyMx})`);
  return n;
}
