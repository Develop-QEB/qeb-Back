import { Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';

export class PropuestasController {
  async getAll(req: AuthRequest, res: Response): Promise<void> {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const status = req.query.status as string;

      const where: Record<string, unknown> = {
        deleted_at: null,
      };

      if (status) {
        where.status = status;
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
      const [total, pendientes, aprobadas, rechazadas] = await Promise.all([
        prisma.propuesta.count({ where: { deleted_at: null } }),
        prisma.propuesta.count({ where: { status: 'Pendiente', deleted_at: null } }),
        prisma.propuesta.count({ where: { status: 'Aprobada', deleted_at: null } }),
        prisma.propuesta.count({ where: { status: 'Rechazada', deleted_at: null } }),
      ]);

      res.json({
        success: true,
        data: {
          total,
          pendientes,
          aprobadas,
          rechazadas,
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
}

export const propuestasController = new PropuestasController();
