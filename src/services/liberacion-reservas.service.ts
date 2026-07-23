// Liberación automática de reservas de inventario de propuestas.
//
// "Liberar" = quitar las reservas de inventario de los circuitos de una
// propuesta (el espacio físico vuelve a quedar disponible para otros) SIN
// cancelar/rechazar ni borrar la propuesta ni sus circuitos. La propuesta pasa
// al status 'Liberada' (no terminal, editable): el asignado puede volver a
// entrar y re-reservar según su rol.
//
// IMPORTANTE (ver server.ts): un cron viejo de limpieza de reservas fue
// DESACTIVADO por soft-deletear sin generar historial. Aquí SIEMPRE se escribe
// historial y se emiten los mismos eventos que el borrado manual (deleteReservas),
// para que sea auditable y la UI se refresque en vivo.
//
// CRITERIO 1 (30 días):
//   - Fecha de liberación = fecha de creación de la propuesta + 30 días naturales.
//   - Solo si la propuesta NO se mandó a ventas/campañas (status en
//     Abierto/Atendido/Ajuste Cto-Cliente/Ajuste Comercial; se excluyen
//     'Pase a ventas' y 'Aprobada').
//   - Solo si la propuesta "todavía no forma parte de las dos catorcenas
//     inmediatas siguientes": se PROTEGE (no se libera) si CUALQUIER circuito
//     arranca dentro de esa ventana; se libera solo cuando TODO su inventario
//     arranca después.

import prisma from '../utils/prisma';
import {
  emitToAll,
  emitToPropuesta,
  emitToPropuestas,
  emitToDashboard,
  SOCKET_EVENTS,
} from '../config/socket';

// Estatus de reserva que se consideran "ocupando" un espacio (los mismos que
// bloquean en inventario-bloqueo.service.ts). Son los que se liberan.
const ESTATUS_RESERVA_ACTIVOS = [
  'Reservado',
  'Bonificado',
  'Vendido',
  'Vendido bonificado',
  'Con Arte',
  'Sin Arte',
];

// Propuestas candidatas: aún en trabajo, NO mandadas a ventas/campañas.
const STATUS_ELEGIBLES = ['Abierto', 'Atendido', 'Ajuste Cto-Cliente', 'Ajuste Comercial'];

const DIAS_LIBERACION = 30;
const STATUS_LIBERADA = 'Liberada';

// 'YYYY-MM-DD' de hoy en zona CDMX (la zona del server puede diferir).
function hoyCDMX(): string {
  const mx = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  return `${mx.getFullYear()}-${String(mx.getMonth() + 1).padStart(2, '0')}-${String(mx.getDate()).padStart(2, '0')}`;
}

// 'YYYY-MM-DD' de una fecha @db.Date de Prisma (viene como medianoche UTC).
function dbDateToYMD(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

interface ResultadoLiberacion {
  propuestasLiberadas: number;
  reservasLiberadas: number;
  omitidasPorAps: number;
}

/**
 * Job diario: libera las reservas de inventario de las propuestas que cumplen el
 * Criterio 1 (30 días) y las pasa a status 'Liberada'. Idempotente: una propuesta
 * ya 'Liberada' o sin reservas activas no vuelve a entrar.
 *
 * DRY-RUN: si `opts.dryRun` (o el env `LIBERACION_RESERVAS_DRY_RUN=true`), solo
 * calcula y LOGUEA qué liberaría, sin tocar nada (ni soft-delete, ni status, ni
 * sockets, ni notificaciones). Pensado para validar el alcance en el PRIMER
 * arranque en producción antes de activarlo en vivo.
 */
export async function liberarReservasPropuestasVencidas(
  opts?: { dryRun?: boolean }
): Promise<ResultadoLiberacion> {
  const dryRun = opts?.dryRun ?? (process.env.LIBERACION_RESERVAS_DRY_RUN === 'true');
  const hoy = hoyCDMX();

  // Ventana = las 2 catorcenas inmediatas siguientes (la vigente/próxima + la que
  // sigue). windowEnd = fecha_fin de la 2da. Si un circuito arranca en/antes de
  // windowEnd, la propuesta está "dentro" de la ventana y se protege.
  const cats = await prisma.$queryRawUnsafe<{ fecha_fin: Date }[]>(
    `SELECT fecha_fin FROM catorcenas WHERE fecha_fin >= ? ORDER BY fecha_inicio ASC LIMIT 2`,
    hoy
  );
  if (cats.length === 0) {
    console.warn('[LiberacionReservas] No hay catorcenas futuras; no se puede calcular la ventana. Se omite la corrida.');
    return { propuestasLiberadas: 0, reservasLiberadas: 0, omitidasPorAps: 0 };
  }
  const windowEnd = dbDateToYMD(cats[cats.length - 1].fecha_fin);

  // Candidatas: status elegible, ancla del contador hace ≥30 días, TODO su
  // inventario arranca después de la ventana (NOT EXISTS circuito que arranque
  // dentro), y que tengan al menos una reserva activa que liberar.
  //
  // Ancla = COALESCE(contador_liberacion_desde, fecha): la primera vez cuenta
  // desde la creación (`fecha`); si ya se liberó antes y la retomaron (status
  // salió de 'Liberada'), cuenta desde esa transición (contador_liberacion_desde).
  const candidatas = await prisma.$queryRawUnsafe<
    { id: number; status: string; solicitud_id: number; id_asignado: string | null }[]
  >(
    `SELECT pr.id, pr.status, pr.solicitud_id, pr.id_asignado
     FROM propuesta pr
     WHERE pr.deleted_at IS NULL
       AND pr.status IN (${STATUS_ELEGIBLES.map(() => '?').join(',')})
       AND DATE(COALESCE(pr.contador_liberacion_desde, pr.fecha)) <= DATE_SUB(?, INTERVAL ${DIAS_LIBERACION} DAY)
       AND NOT EXISTS (
         SELECT 1 FROM solicitudCaras sc
         WHERE sc.idquote = CAST(pr.id AS CHAR) COLLATE utf8mb4_unicode_ci
           AND sc.inicio_periodo <= ?
       )
       AND EXISTS (
         SELECT 1 FROM reservas rv
         INNER JOIN solicitudCaras sc2 ON sc2.id = rv.solicitudCaras_id
         WHERE sc2.idquote = CAST(pr.id AS CHAR) COLLATE utf8mb4_unicode_ci
           AND rv.deleted_at IS NULL
           AND rv.estatus IN (${ESTATUS_RESERVA_ACTIVOS.map(() => '?').join(',')})
       )`,
    ...STATUS_ELEGIBLES,
    hoy,
    windowEnd,
    ...ESTATUS_RESERVA_ACTIVOS
  );

  let propuestasLiberadas = 0;
  let reservasLiberadas = 0;
  let omitidasPorAps = 0;

  for (const prop of candidatas) {
    try {
      const liberadas = await liberarUnaPropuesta(prop, dryRun);
      if (liberadas === -1) {
        omitidasPorAps++;
      } else if (liberadas > 0) {
        propuestasLiberadas++;
        reservasLiberadas += liberadas;
      }
    } catch (err) {
      console.error(`[LiberacionReservas] Error liberando propuesta #${prop.id}:`, err);
    }
  }

  const prefijo = dryRun ? '[LiberacionReservas][DRY-RUN] Liberaría' : '[LiberacionReservas] Criterio 30 días:';
  console.log(
    `${prefijo} (hoy CDMX ${hoy}, ventana hasta ${windowEnd}): ` +
    `${propuestasLiberadas} propuesta(s), ${reservasLiberadas} reserva(s); ` +
    `${omitidasPorAps} omitida(s) por tener reservas con APS.`
  );

  return { propuestasLiberadas, reservasLiberadas, omitidasPorAps };
}

/**
 * Libera una sola propuesta. Devuelve el número de reservas liberadas, o -1 si se
 * omite por tener reservas con APS (documento ya en SAP → requiere revisión manual,
 * no se auto-libera). 0 si no había nada que liberar.
 */
async function liberarUnaPropuesta(
  prop: {
    id: number;
    status: string;
    solicitud_id: number;
    id_asignado: string | null;
  },
  dryRun: boolean
): Promise<number> {
  const caras = await prisma.solicitudCaras.findMany({
    where: { idquote: String(prop.id) },
    select: { id: true, articulo: true, formato: true, inicio_periodo: true, fin_periodo: true },
  });
  const caraIds = caras.map((c) => c.id);
  if (caraIds.length === 0) return 0;

  const reservas = await prisma.reservas.findMany({
    where: {
      solicitudCaras_id: { in: caraIds },
      deleted_at: null,
      estatus: { in: ESTATUS_RESERVA_ACTIVOS },
    },
    select: { id: true, inventario_id: true, solicitudCaras_id: true, APS: true },
  });
  if (reservas.length === 0) return 0;

  // Guarda de seguridad (misma filosofía que zombi-monitor): si alguna reserva
  // tiene APS, su documento ya está en SAP; NO se auto-libera, se reporta.
  const conAps = reservas.filter((r) => r.APS != null && r.APS > 0);
  if (conAps.length > 0) {
    console.warn(
      `[LiberacionReservas] Propuesta #${prop.id} OMITIDA: ${conAps.length} reserva(s) con APS ` +
      `(${[...new Set(conAps.map((r) => r.APS))].slice(0, 10).join(', ')}) requieren revisión manual.`
    );
    return -1;
  }

  // DRY-RUN: solo reporta qué liberaría, sin tocar nada.
  if (dryRun) {
    console.log(`[LiberacionReservas][DRY-RUN]  #${prop.id} (${prop.status}) → ${reservas.length} reserva(s)`);
    return reservas.length;
  }

  const reservaIds = reservas.map((r) => r.id);
  const carasInfoMap = new Map(caras.map((c) => [c.id, c]));

  // Resolver el inventario padre de cada espacio, para el payload de emit.
  const espacios = [...new Set(reservas.map((r) => Number(r.inventario_id)).filter((e) => e > 0))];
  const invParents = espacios.length > 0
    ? await prisma.$queryRawUnsafe<{ id: number; inv_id: number | null }[]>(
        `SELECT id, inventario_id AS inv_id FROM espacio_inventario WHERE id IN (${espacios.map(() => '?').join(',')})`,
        ...espacios
      )
    : [];
  const invIdByEspacio = new Map(invParents.map((p) => [p.id, p.inv_id]));

  // Soft-delete de reservas + cambio de status + historial, en una transacción.
  await prisma.$transaction(async (tx) => {
    await tx.reservas.updateMany({
      where: { id: { in: reservaIds } },
      data: { deleted_at: new Date() },
    });

    await tx.propuesta.update({
      where: { id: prop.id },
      data: { status: STATUS_LIBERADA, updated_at: new Date() },
    });

    // accion 'Cambio de estado' (no 'Liberación de reservas') para que el filtro
    // de historial por estatus (getAll: accion='Cambio de estado' + detalles LIKE
    // '%"despues":"Liberada"%') pueda encontrar estas liberaciones por rango de
    // fechas. El detalle conserva la info de la liberación (origen/criterio/reservas).
    await tx.historial.create({
      data: {
        tipo: 'Propuesta',
        ref_id: prop.id,
        accion: 'Cambio de estado',
        fecha_hora: new Date(),
        detalles: JSON.stringify({
          usuario: 'Sistema',
          origen: 'sistema',
          criterio: '30 días',
          reservas_liberadas: reservaIds.length,
          cambios: [{ campo: 'Estado', label: 'Estado', antes: prop.status, despues: STATUS_LIBERADA }],
          circuitos: caras.map((c) => ({ articulo: c.articulo, formato: c.formato })),
        }),
      },
    });
  });

  // Emitir INVENTARIO_LIBERADO por cada espacio liberado (buscadores en vivo).
  for (const r of reservas) {
    const espacioId = Number(r.inventario_id);
    if (!espacioId) continue;
    const cara = r.solicitudCaras_id ? carasInfoMap.get(r.solicitudCaras_id) : null;
    try {
      emitToAll(SOCKET_EVENTS.INVENTARIO_LIBERADO, {
        espacioId,
        inventarioId: invIdByEspacio.get(espacioId) ?? null,
        fechaInicio: cara?.inicio_periodo?.toISOString?.() ?? null,
        fechaFin: cara?.fin_periodo?.toISOString?.() ?? null,
      });
    } catch (emitErr) {
      console.error('[LiberacionReservas] Error emitiendo INVENTARIO_LIBERADO:', emitErr);
    }
  }

  // Eventos de reserva/propuesta para refrescar la UI en vivo.
  emitToPropuesta(prop.id, SOCKET_EVENTS.RESERVA_ELIMINADA, { propuestaId: prop.id });
  emitToAll(SOCKET_EVENTS.RESERVA_ELIMINADA, { propuestaId: prop.id });
  emitToPropuesta(prop.id, SOCKET_EVENTS.PROPUESTA_STATUS_CHANGED, {
    propuestaId: prop.id,
    statusAnterior: prop.status,
    statusNuevo: STATUS_LIBERADA,
    usuario: 'Sistema',
  });
  emitToPropuestas(SOCKET_EVENTS.PROPUESTA_STATUS_CHANGED, {
    propuestaId: prop.id,
    statusAnterior: prop.status,
    statusNuevo: STATUS_LIBERADA,
    usuario: 'Sistema',
  });
  emitToDashboard(SOCKET_EVENTS.DASHBOARD_UPDATED, { tipo: 'propuesta', accion: 'liberada' });

  // Notificar a los usuarios asignados (misma mecánica que deleteReservas).
  await notificarAsignados(prop, reservaIds.length);

  console.log(`[LiberacionReservas] Propuesta #${prop.id}: ${reservaIds.length} reserva(s) liberada(s) → status '${STATUS_LIBERADA}'.`);
  return reservaIds.length;
}

async function notificarAsignados(
  prop: { id: number; solicitud_id: number; id_asignado: string | null },
  nReservas: number
): Promise<void> {
  if (!prop.id_asignado) return;
  const responsables = new Set<number>();
  for (const idStr of prop.id_asignado.split(',')) {
    const parsed = parseInt(idStr.trim(), 10);
    if (!isNaN(parsed)) responsables.add(parsed);
  }
  if (responsables.size === 0) return;

  const now = new Date();
  for (const responsableId of responsables) {
    try {
      await prisma.tareas.create({
        data: {
          titulo: 'Reservas liberadas automáticamente',
          descripcion: `Se liberaron ${nReservas} reserva(s) de inventario de la propuesta por el criterio de 30 días. La propuesta quedó en estatus '${STATUS_LIBERADA}' y puedes volver a reservar.`,
          tipo: 'Notificación',
          categoria: 'cambio_estatus',
          estatus: 'Pendiente',
          id_responsable: responsableId,
          responsable: '',
          asignado: 'Sistema',
          id_asignado: '',
          id_solicitud: prop.solicitud_id?.toString() || '',
          id_propuesta: prop.id.toString(),
          fecha_inicio: now,
          fecha_fin: now,
        },
      });
    } catch (err) {
      console.error(`[LiberacionReservas] Error notificando a usuario ${responsableId}:`, err);
    }
  }
}
