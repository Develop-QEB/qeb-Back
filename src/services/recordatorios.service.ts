import prisma from '../utils/prisma';
import { emitToHistorial, emitToAll, SOCKET_EVENTS } from '../config/socket';
import { correoPermitido } from '../utils/correoPrefs';
import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_PORT === '465',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: { rejectUnauthorized: false },
});

async function enviarCorreoRecordatorio(
  destinatarioEmail: string,
  destinatarioNombre: string,
  asunto: string,
  notaOriginal: string,
  fechaEntrega: Date,
  tareaId: number,
): Promise<void> {
  const fechaStr = fechaEntrega.toLocaleDateString('es-MX', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
  });
  const frontUrl = process.env.FRONTEND_URL?.split(',')[0]?.trim() || 'https://app.qeb.mx';
  const linkTarea = `${frontUrl}/notificaciones?tarea=${tareaId}`;

  const htmlBody = `
  <!DOCTYPE html>
  <html>
  <body style="margin:0;padding:0;font-family:Arial,sans-serif;background-color:#f3f4f6;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;padding:24px 0;">
      <tr>
        <td align="center">
          <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.1);">
            <tr>
              <td style="background:linear-gradient(135deg,#7c3aed 0%,#a855f7 100%);padding:32px 40px;color:#ffffff;">
                <h1 style="margin:0;font-size:22px;font-weight:600;">Recordatorio QEB</h1>
                <p style="margin:8px 0 0 0;color:#e9d5ff;font-size:14px;">${asunto}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:32px 40px;color:#374151;">
                <p style="margin:0 0 16px 0;font-size:16px;">Hola <strong>${destinatarioNombre}</strong>,</p>
                <p style="margin:0 0 16px 0;font-size:15px;line-height:1.5;">Tienes una actividad programada para el <strong>${fechaStr}</strong>:</p>
                <div style="background:#f9fafb;border-left:4px solid #7c3aed;padding:16px 20px;border-radius:4px;margin:0 0 24px 0;">
                  <p style="margin:0;font-size:14px;color:#4b5563;font-style:italic;">${notaOriginal || 'Sin descripcion'}</p>
                </div>
                <p style="margin:0 0 16px 0;font-size:14px;">Hemos creado una tarea en el sistema para que puedas hacer seguimiento.</p>
                <table cellpadding="0" cellspacing="0" style="margin:24px 0;">
                  <tr>
                    <td style="border-radius:6px;background:#7c3aed;">
                      <a href="${linkTarea}" style="display:inline-block;padding:12px 24px;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;">Abrir tarea</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="background-color:#1f2937;padding:24px 40px;text-align:center;">
                <p style="color:#9ca3af;font-size:12px;margin:0;">Mensaje automatico del sistema QEB.</p>
                <p style="color:#6b7280;font-size:11px;margin:8px 0 0 0;">&copy; ${new Date().getFullYear()} QEB OOH Management</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>`;

  await transporter.sendMail({
    from: `"QEB Sistema" <${process.env.SMTP_USER}>`,
    to: destinatarioEmail,
    subject: `Recordatorio: ${asunto}`,
    html: htmlBody,
  });
}

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

        // Datos del usuario para nombre y correo
        const usuario = await prisma.usuario.findUnique({
          where: { id: usuarioId },
          select: { id: true, nombre: true, correo_electronico: true },
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
            categoria: 'recordatorio',
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

        // Emitir socket. Antes se emitía a `user:${id}` (room que nadie usa, por
        // eso el popup de recordatorio nunca llegaba). Ahora broadcast con
        // `destinatarios`; el frontend filtra por el usuario actual.
        emitToAll(SOCKET_EVENTS.NOTIFICACION_NUEVA, {
          tipo: 'Recordatorio',
          clase: 'notificacion',
          categoria: 'recordatorio',
          titulo: tarea.titulo,
          descripcion: tarea.descripcion,
          tarea_id: tarea.id,
          historial_id: histId,
          fecha_entrega: fechaEntrega.toISOString(),
          destinatarios: [usuarioId],
        });
        emitToHistorial(SOCKET_EVENTS.HISTORIAL_NUEVA, {
          id: histId,
          tipo: row.tipo,
          fecha_entrega: fechaEntregaStr,
          recordatorio_enviado: true,
        });

        // Enviar correo de recordatorio (best-effort; no rompemos el flujo si falla)
        if (usuario.correo_electronico && await correoPermitido(usuarioId, 'notificacion', 'recordatorio')) {
          try {
            const asunto = `${row.tipo}${row.ref_id ? ` #${row.ref_id}` : ''} - ${fechaEntregaStr}`;
            await enviarCorreoRecordatorio(
              usuario.correo_electronico,
              usuario.nombre,
              asunto,
              notaOriginal,
              fechaEntrega,
              tarea.id,
            );
            console.log(`[Recordatorios] Email enviado a ${usuario.correo_electronico}`);
          } catch (emailErr) {
            console.error(`[Recordatorios] Error enviando email a ${usuario.correo_electronico}:`, emailErr);
          }
        }

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
