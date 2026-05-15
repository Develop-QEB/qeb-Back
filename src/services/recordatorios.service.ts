import prisma from '../utils/prisma';
import { emitToHistorial, getIO, SOCKET_EVENTS } from '../config/socket';

/**
 * Procesa los recordatorios pendientes del modulo historial.
 * Para cada entrada de historial con fecha_entrega + recordar_dias_antes que ya
 * haya alcanzado su umbral de aviso y aun no haya sido notificada:
 *   1. Crea una tarea de tipo "Recordatorio" para el creador (historial.usuario_id).
 *   2. Marca historial.recordatorio_enviado_at = NOW() y tarea_recordatorio_id.
 *   3. Emite socket para refresh en vivo del badge / lista.
 *
 * Idempotente: si recordatorio_enviado_at ya esta seteado, no se vuelve a procesar.
 */
export async function enviarRecordatoriosPendientes(): Promise<{
  procesados: number;
  errores: number;
}> {
  let procesados = 0;
  let errores = 0;

  try {
    // Buscar entradas listas para notificar
    const pendientes: any[] = await prisma.$queryRawUnsafe(`
      SELECT id, tipo, ref_id, accion, fecha_entrega, recordar_dias_antes,
             usuario_id, detalles
      FROM historial
      WHERE fecha_entrega IS NOT NULL
        AND recordatorio_enviado_at IS NULL
        AND usuario_id IS NOT NULL
        AND DATE_SUB(fecha_entrega, INTERVAL COALESCE(recordar_dias_antes, 0) DAY) <= NOW()
      ORDER BY fecha_entrega ASC
      LIMIT 500
    `);

    if (!pendientes.length) {
      console.log('[Recordatorios] Sin pendientes por procesar.');
      return { procesados, errores };
    }

    console.log(`[Recordatorios] ${pendientes.length} pendientes por procesar.`);

    for (const row of pendientes) {
      try {
        const usuarioId = Number(row.usuario_id);
        const histId = typeof row.id === 'bigint' ? Number(row.id) : Number(row.id);
        const fechaEntrega = row.fecha_entrega instanceof Date
          ? row.fecha_entrega
          : new Date(row.fecha_entrega);

        // Datos del usuario para nombre
        const usuario = await prisma.usuario.findUnique({
          where: { id: usuarioId },
          select: { id: true, nombre: true },
        });
        if (!usuario) {
          console.warn(`[Recordatorios] Usuario ${usuarioId} no encontrado para historial #${histId}, skip.`);
          continue;
        }

        // Texto de la accion / nota original (extraido del detalles)
        const notaOriginal = String(row.detalles || '').replace(/^[^:]+:\s*/, '');
        const fechaEntregaStr = fechaEntrega.toLocaleDateString('es-MX', {
          day: '2-digit', month: '2-digit', year: 'numeric',
        });

        // Crear la tarea en sistema
        const tarea = await prisma.tareas.create({
          data: {
            tipo: 'Recordatorio',
            titulo: `Recordatorio: ${row.tipo} #${row.ref_id || ''}`.trim(),
            descripcion: notaOriginal || 'Recordatorio programado',
            contenido: JSON.stringify({
              historial_id: histId,
              tipo_origen: row.tipo,
              ref_id: row.ref_id,
              fecha_entrega: fechaEntrega.toISOString(),
              recordar_dias_antes: row.recordar_dias_antes,
            }),
            estatus: 'Pendiente',
            id_responsable: usuarioId,
            responsable: usuario.nombre,
            id_asignado: String(usuarioId),
            asignado: usuario.nombre,
            id_solicitud: '',
            id_propuesta: String(row.ref_id || ''),
            fecha_inicio: new Date(),
            fecha_fin: fechaEntrega,
          },
        });

        // Marcar historial como notificado
        await prisma.historial.update({
          where: { id: BigInt(histId) },
          data: {
            recordatorio_enviado_at: new Date(),
            tarea_recordatorio_id: tarea.id,
          },
        });

        // Emitir socket
        const io = getIO();
        if (io) {
          io.to(`user:${usuarioId}`).emit(SOCKET_EVENTS.NOTIFICACION_NUEVA, {
            tipo: 'Recordatorio',
            titulo: tarea.titulo,
            descripcion: tarea.descripcion,
            tarea_id: tarea.id,
            historial_id: histId,
            fecha_entrega: fechaEntrega.toISOString(),
          });
        }
        emitToHistorial(SOCKET_EVENTS.HISTORIAL_NUEVA, {
          id: histId,
          tipo: row.tipo,
          fecha_entrega: fechaEntregaStr,
          recordatorio_enviado: true,
        });

        procesados++;
        console.log(`[Recordatorios] historial #${histId} -> tarea #${tarea.id} para usuario ${usuario.nombre}`);
      } catch (e) {
        errores++;
        console.error(`[Recordatorios] Error procesando historial #${row.id}:`, e);
      }
    }
  } catch (e) {
    console.error('[Recordatorios] Error global:', e);
  }

  console.log(`[Recordatorios] Procesados=${procesados} Errores=${errores}`);
  return { procesados, errores };
}
