import { Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';

export class CampanasController {
  async getAll(req: AuthRequest, res: Response): Promise<void> {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const status = req.query.status as string;

      const where: Record<string, unknown> = {};

      if (status) {
        where.status = status;
      }

      const [campanas, total] = await Promise.all([
        prisma.campania.findMany({
          where,
          skip: (page - 1) * limit,
          take: limit,
          orderBy: { fecha_inicio: 'desc' },
        }),
        prisma.campania.count({ where }),
      ]);

      res.json({
        success: true,
        data: campanas,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener campanas';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getById(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const campana = await prisma.campania.findUnique({
        where: { id: parseInt(id) },
      });

      if (!campana) {
        res.status(404).json({
          success: false,
          error: 'Campana no encontrada',
        });
        return;
      }

      res.json({
        success: true,
        data: campana,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener campana';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async updateStatus(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { status } = req.body;

      const campana = await prisma.campania.update({
        where: { id: parseInt(id) },
        data: { status },
      });

      res.json({
        success: true,
        data: campana,
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
      const [total, activas, inactivas] = await Promise.all([
        prisma.campania.count(),
        prisma.campania.count({ where: { status: 'activa' } }),
        prisma.campania.count({ where: { status: 'inactiva' } }),
      ]);

      res.json({
        success: true,
        data: {
          total,
          activas,
          inactivas,
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

export const campanasController = new CampanasController();
