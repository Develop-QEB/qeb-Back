import prisma from '../utils/prisma';

/**
 * Ciclo de vida AUTOMÁTICO del status manual de campaña, alineado a sus fechas.
 * Dos jobs a medianoche (CDMX) que SOLO mueven los estatus automáticos; nunca
 * tocan los que el usuario pone a propósito (Cancelada, Rechazada, Pausada,
 * inactiva, En Operacion, Aprobada, etc.):
 *
 *   "Por iniciar" (futura)  →  "Inicializada" (activa)  →  "finalizada" (pasada)
 *
 * Una campaña aprobada nace en "Por iniciar" y ahí se queda si nadie la mueve.
 * Estos jobs la hacen avanzar sola conforme su periodo entra y sale de vigencia,
 * para que el status deje de ser engañoso (ej. una pasada que seguía "Por
 * iniciar"). Criterio de fechas idéntico a getPeriodStatus del front
 * (comparando contra HOY 00:00 en CDMX, no la zona del server).
 */

// Fecha de "hoy" en CDMX como 'YYYY-MM-DD' (la zona del server puede diferir).
function hoyCDMX(): string {
  const nowMx = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  return `${nowMx.getFullYear()}-${String(nowMx.getMonth() + 1).padStart(2, '0')}-${String(nowMx.getDate()).padStart(2, '0')}`;
}

/**
 * "Por iniciar" cuyo periodo YA ESTÁ CORRIENDO hoy (dinámicamente "Activa") →
 * "Inicializada". Activa = DATE(fecha_inicio) <= hoy <= DATE(fecha_fin).
 */
export async function inicializarCampanasPorIniciarActivas(): Promise<number> {
  const hoyMx = hoyCDMX();
  const result = await prisma.$executeRawUnsafe(
    `UPDATE campania
     SET status = 'Inicializada'
     WHERE LOWER(TRIM(status)) = 'por iniciar'
       AND fecha_inicio IS NOT NULL
       AND fecha_fin IS NOT NULL
       AND DATE(fecha_inicio) <= ?
       AND DATE(fecha_fin) >= ?`,
    hoyMx,
    hoyMx
  );
  const n = Number(result) || 0;
  console.log(`[InicializarCampanas] ${n} campaña(s) "Por iniciar" ya activas → "Inicializada" (hoy CDMX ${hoyMx})`);
  return n;
}

/**
 * "Por iniciar" o "Inicializada" cuyo periodo ya pasó (dinámicamente "Pasada") →
 * "finalizada". Se incluye "Inicializada" para que las que avanzó el otro job
 * no se queden pegadas al terminar. Pasada = DATE(fecha_fin) < hoy.
 *
 * IMPORTANTE: solo toca esos dos estatus automáticos. Los que el usuario pone a
 * propósito (Cancelada, Rechazada, Pausada, inactiva, En Operacion, etc.) NO
 * entran al filtro.
 */
export async function finalizarCampanasPorIniciarVencidas(): Promise<number> {
  const hoyMx = hoyCDMX();
  const result = await prisma.$executeRawUnsafe(
    `UPDATE campania
     SET status = 'finalizada'
     WHERE LOWER(TRIM(status)) IN ('por iniciar', 'inicializada')
       AND fecha_fin IS NOT NULL
       AND DATE(fecha_fin) < ?`,
    hoyMx
  );
  const n = Number(result) || 0;
  console.log(`[FinalizarCampanas] ${n} campaña(s) "Por iniciar"/"Inicializada" ya vencidas → "finalizada" (hoy CDMX ${hoyMx})`);
  return n;
}
