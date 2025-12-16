import { Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';

export class PropuestasController {
  async getAll(req: AuthRequest, res: Response): Promise<void> {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const status = req.query.status as string;
      const search = req.query.search as string;

      const where: Record<string, unknown> = {
        deleted_at: null,
      };

      if (status) {
        where.status = status;
      }

      if (search) {
        where.OR = [
          { articulo: { contains: search } },
          { descripcion: { contains: search } },
          { asignado: { contains: search } },
        ];
      }

      const [propuestas, total] = await Promise.all([
        prisma.propuesta.findMany({
          where,
          skip: (page - 1) * limit,
          take: limit,
          orderBy: { fecha: 'desc' },
        }),
        prisma.propuesta.count({ where }),
      ]);

      res.json({
        success: true,
        data: propuestas,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener propuestas';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getById(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const propuesta = await prisma.propuesta.findFirst({
        where: {
          id: parseInt(id),
          deleted_at: null,
        },
      });

      if (!propuesta) {
        res.status(404).json({
          success: false,
          error: 'Propuesta no encontrada',
        });
        return;
      }

      res.json({
        success: true,
        data: propuesta,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener propuesta';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async updateStatus(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { status, comentario_cambio_status } = req.body;

      const propuesta = await prisma.propuesta.update({
        where: { id: parseInt(id) },
        data: {
          status,
          comentario_cambio_status: comentario_cambio_status || '',
          updated_at: new Date(),
        },
      });

      res.json({
        success: true,
        data: propuesta,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al actualizar status';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getStats(_req: AuthRequest, res: Response): Promise<void> {
    try {
      // Get all status counts dynamically
      const statusCounts = await prisma.propuesta.groupBy({
        by: ['status'],
        where: { deleted_at: null },
        _count: { status: true },
      });

      const byStatus: Record<string, number> = {};
      let total = 0;
      statusCounts.forEach(item => {
        const status = item.status || 'Sin estado';
        byStatus[status] = item._count.status;
        total += item._count.status;
      });

      res.json({
        success: true,
        data: {
          total,
          byStatus,
          // Keep legacy fields for compatibility
          pendientes: byStatus['Pendiente'] || byStatus['Por aprobar'] || 0,
          aprobadas: byStatus['Aprobada'] || byStatus['Activa'] || 0,
          rechazadas: byStatus['Rechazada'] || 0,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener estadisticas';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Get comments for a propuesta
  async getComments(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const comments = await prisma.$queryRaw`
        SELECT
          h.id,
          h.detalles as comentario,
          h.fecha_hora as creado_en,
          COALESCE(u.nombre, 'Sistema') as autor_nombre
        FROM historial h
        LEFT JOIN usuario u ON u.id = h.usuario_id
        WHERE h.ref_id = ${parseInt(id)}
          AND h.tipo = 'Propuesta'
          AND h.accion = 'Comentario'
        ORDER BY h.fecha_hora DESC
      `;

      res.json({
        success: true,
        data: comments,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener comentarios';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Add comment to a propuesta
  async addComment(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { comentario } = req.body;

      await prisma.historial.create({
        data: {
          tipo: 'Propuesta',
          ref_id: parseInt(id),
          accion: 'Comentario',
          detalles: comentario,
          fecha_hora: new Date(),
        },
      });

      res.json({
        success: true,
        message: 'Comentario agregado',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al agregar comentario';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Approve propuesta - complex operation
  async approve(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { precio_simulado, asignados, id_asignados } = req.body;
      const propuestaId = parseInt(id);

      // Get propuesta with related data
      const propuesta = await prisma.propuesta.findUnique({
        where: { id: propuestaId },
      });

      if (!propuesta) {
        res.status(404).json({ success: false, error: 'Propuesta no encontrada' });
        return;
      }

      // Get solicitud data
      const solicitud = await prisma.solicitud.findUnique({
        where: { id: propuesta.solicitud_id },
      });

      // Get cotizacion
      const cotizacion = await prisma.cotizacion.findFirst({
        where: { id_propuesta: propuestaId },
      });

      // Get campania
      const campania = cotizacion ? await prisma.campania.findFirst({
        where: { cotizacion_id: cotizacion.id },
      }) : null;

      // Start transaction
      await prisma.$transaction(async (tx) => {
        // 1. Call stored procedure for reservas
        await tx.$executeRaw`CALL actualizar_reservas(${propuestaId})`;

        // 2. Update tareas status
        await tx.tareas.updateMany({
          where: { id_propuesta: String(propuestaId) },
          data: { estatus: 'Atendido' },
        });

        // 3. Update propuesta
        await tx.propuesta.update({
          where: { id: propuestaId },
          data: {
            status: 'Activa',
            precio_simulado: precio_simulado || propuesta.precio_simulado,
            asignado: asignados || propuesta.asignado,
            id_asignado: id_asignados || propuesta.id_asignado,
            updated_at: new Date(),
          },
        });

        // 4. Update cotizacion and campania if exists
        if (cotizacion) {
          await tx.cotizacion.update({
            where: { id: cotizacion.id },
            data: {
              status: 'Activa',
              precio: precio_simulado || cotizacion.precio,
            },
          });

          if (campania) {
            await tx.campania.update({
              where: { id: campania.id },
              data: { status: 'Por iniciar' },
            });
          }
        }

        // 5. Create seguimiento task
        if (solicitud && campania) {
          await tx.tareas.create({
            data: {
              tipo: 'Seguimiento Campaña',
              responsable: solicitud.nombre_usuario,
              estatus: 'Pendientes',
              descripcion: 'Ya se atendió la propuesta pero es necesario darle seguimiento',
              titulo: campania.nombre,
              id_propuesta: String(propuestaId),
              id_responsable: solicitud.usuario_id || 0,
              fecha_inicio: propuesta.fecha,
              fecha_fin: cotizacion?.fecha_fin || propuesta.fecha,
              asignado: asignados || propuesta.asignado,
              id_asignado: id_asignados || propuesta.id_asignado,
              campania_id: campania.id,
              id_solicitud: String(propuesta.solicitud_id),
            },
          });
        }

        // 6. Add historial entries
        await tx.historial.createMany({
          data: [
            {
              tipo: 'Propuesta',
              ref_id: propuestaId,
              accion: 'Finalización',
              detalles: 'Propuesta Aprobada',
              fecha_hora: new Date(),
            },
            {
              tipo: 'Campaña',
              ref_id: campania?.id || propuestaId,
              accion: 'Creación',
              detalles: 'Se ha creado la campaña',
              fecha_hora: new Date(),
            },
          ],
        });

        // 7. Create notification for solicitud creator
        if (solicitud) {
          const creador = await tx.usuario.findUnique({
            where: { id: solicitud.usuario_id || 0 },
          });

          if (creador) {
            await tx.tareas.create({
              data: {
                tipo: 'Notificación',
                responsable: creador.nombre,
                id_responsable: creador.id,
                estatus: 'Notificación nueva',
                descripcion: `Se ha aprobado la propuesta con el id: ${propuestaId}`,
                titulo: 'Propuesta aprobada',
                id_propuesta: String(propuestaId),
                asignado: creador.nombre,
                id_asignado: String(creador.id),
                fecha_inicio: propuesta.fecha,
                fecha_fin: cotizacion?.fecha_fin || propuesta.fecha,
                id_solicitud: String(propuesta.solicitud_id),
              },
            });
          }
        }
      });

      res.json({
        success: true,
        message: 'Propuesta aprobada exitosamente',
      });
    } catch (error) {
      console.error('Error approving propuesta:', error);
      const message = error instanceof Error ? error.message : 'Error al aprobar propuesta';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }
}

export const propuestasController = new PropuestasController();
