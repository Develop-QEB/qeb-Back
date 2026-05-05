// Detector de "reservas zombi": registros activos (deleted_at IS NULL) que apuntan
// a entidades padre que ya no existen.
//
// TIPOS:
//   1. reservas.inventario_id → espacio_inventario inexistente
//   2. reservas.solicitudCaras_id → solicitudCaras inexistente
//
// COMPORTAMIENTO:
//   - Sin APS: auto soft-delete (sin riesgo, no afecta SAP).
//   - Con APS: solo loggea — borrarlas en QEB sin coordinar con SAP genera desfase
//     contable. Se reportan para revisión manual del equipo de SAP/contabilidad.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface ZombiReport {
  tipo1: { sin_aps: number; con_aps: number; aps_pendientes: number[] };
  tipo2: { sin_aps: number; con_aps: number; aps_pendientes: number[] };
  totalLimpiadas: number;
}

export async function detectarYLimpiarZombis(opts: { autoClean?: boolean } = {}): Promise<ZombiReport> {
  const autoClean = opts.autoClean !== false; // default true

  // TIPO 1: reservas → espacio_inventario inexistente
  const tipo1Rows = await prisma.$queryRawUnsafe<{ id: number; APS: number | null }[]>(`
    SELECT r.id, r.APS
    FROM reservas r
    WHERE r.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM espacio_inventario ei WHERE ei.id = r.inventario_id)
  `);
  const t1SinAps = tipo1Rows.filter(r => r.APS == null || r.APS === 0).map(r => r.id);
  const t1ConAps = tipo1Rows.filter(r => r.APS != null && r.APS > 0);

  // TIPO 2: reservas → solicitudCaras inexistente
  const tipo2Rows = await prisma.$queryRawUnsafe<{ id: number; APS: number | null }[]>(`
    SELECT r.id, r.APS
    FROM reservas r
    WHERE r.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM solicitudCaras sc WHERE sc.id = r.solicitudCaras_id)
  `);
  const t2SinAps = tipo2Rows.filter(r => r.APS == null || r.APS === 0).map(r => r.id);
  const t2ConAps = tipo2Rows.filter(r => r.APS != null && r.APS > 0);

  let totalLimpiadas = 0;
  if (autoClean) {
    const idsLimpiar = [...t1SinAps, ...t2SinAps];
    if (idsLimpiar.length > 0) {
      const res = await prisma.reservas.updateMany({
        where: { id: { in: idsLimpiar } },
        data: { deleted_at: new Date() },
      });
      totalLimpiadas = res.count;
    }
  }

  const apsT1 = [...new Set(t1ConAps.map(r => r.APS as number))].sort((a, b) => a - b);
  const apsT2 = [...new Set(t2ConAps.map(r => r.APS as number))].sort((a, b) => a - b);

  // Logging
  console.log(`[ZombiMonitor] Tipo 1 (sin espacio_inventario): ${t1SinAps.length} sin APS, ${t1ConAps.length} con APS`);
  console.log(`[ZombiMonitor] Tipo 2 (sin solicitudCaras): ${t2SinAps.length} sin APS, ${t2ConAps.length} con APS`);
  if (autoClean && totalLimpiadas > 0) {
    console.log(`[ZombiMonitor] Soft-deletadas ${totalLimpiadas} reservas zombi sin APS`);
  }
  if (apsT1.length > 0 || apsT2.length > 0) {
    console.warn(`[ZombiMonitor] ALERTA: ${t1ConAps.length + t2ConAps.length} reservas zombi CON APS requieren revisión manual`);
    if (apsT1.length > 0) console.warn(`[ZombiMonitor]   APS Tipo 1 (sample): ${apsT1.slice(0, 10).join(', ')}${apsT1.length > 10 ? `...+${apsT1.length - 10}` : ''}`);
    if (apsT2.length > 0) console.warn(`[ZombiMonitor]   APS Tipo 2 (sample): ${apsT2.slice(0, 10).join(', ')}${apsT2.length > 10 ? `...+${apsT2.length - 10}` : ''}`);
  }

  return {
    tipo1: { sin_aps: t1SinAps.length, con_aps: t1ConAps.length, aps_pendientes: apsT1 },
    tipo2: { sin_aps: t2SinAps.length, con_aps: t2ConAps.length, aps_pendientes: apsT2 },
    totalLimpiadas,
  };
}
