import { Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';

export class SolicitudesController {
  async getAll(req: AuthRequest, res: Response): Promise<void> {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const status = req.query.status as string;
      const search = req.query.search as string;
      const yearInicio = req.query.yearInicio as string;
      const yearFin = req.query.yearFin as string;
      const catorcenaInicio = req.query.catorcenaInicio as string;
      const catorcenaFin = req.query.catorcenaFin as string;
      const sortBy = req.query.sortBy as string;
      const sortOrder = (req.query.sortOrder as string) || 'desc';
      const groupBy = req.query.groupBy as string;

      const where: Record<string, unknown> = {
        deleted_at: null,
      };

      if (status) {
        where.status = status;
      }

      // Search filter
      if (search) {
        where.OR = [
          { razon_social: { contains: search } },
          { descripcion: { contains: search } },
          { marca_nombre: { contains: search } },
          { asignado: { contains: search } },
          { cuic: { contains: search } },
        ];
      }

      // Year range and catorcena filter
      if (yearInicio && yearFin && catorcenaInicio && catorcenaFin) {
        // Get catorcena dates for start
        const catorcenasInicioData = await prisma.catorcenas.findFirst({
          where: {
            a_o: parseInt(yearInicio),
            numero_catorcena: parseInt(catorcenaInicio),
          },
        });
        // Get catorcena dates for end
        const catorcenasFinData = await prisma.catorcenas.findFirst({
          where: {
            a_o: parseInt(yearFin),
            numero_catorcena: parseInt(catorcenaFin),
          },
        });

        if (catorcenasInicioData && catorcenasFinData) {
          where.fecha = {
            gte: catorcenasInicioData.fecha_inicio,
            lte: catorcenasFinData.fecha_fin,
          };
        }
      } else if (yearInicio && yearFin) {
        // Filter by year range only
        where.fecha = {
          gte: new Date(`${yearInicio}-01-01`),
          lte: new Date(`${yearFin}-12-31`),
        };
      } else if (yearInicio) {
        // Filter by single year
        where.fecha = {
          gte: new Date(`${yearInicio}-01-01`),
          lte: new Date(`${yearInicio}-12-31`),
        };
      }

      // Build orderBy
      let orderBy: Record<string, string> = { fecha: 'desc' };
      if (sortBy) {
        orderBy = { [sortBy]: sortOrder };
      }

      const [solicitudes, total] = await Promise.all([
        prisma.solicitud.findMany({
          where,
          skip: (page - 1) * limit,
          take: limit,
          orderBy,
        }),
        prisma.solicitud.count({ where }),
      ]);

      // Group data if requested
      let groupedData = null;
      if (groupBy && ['status', 'marca_nombre', 'asignado', 'razon_social'].includes(groupBy)) {
        const grouped = await prisma.solicitud.groupBy({
          by: [groupBy as 'status' | 'marca_nombre' | 'asignado' | 'razon_social'],
          where,
          _count: true,
        });
        groupedData = grouped;
      }

      res.json({
        success: true,
        data: solicitudes,
        groupedData,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener solicitudes';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getById(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const solicitud = await prisma.solicitud.findFirst({
        where: {
          id: parseInt(id),
          deleted_at: null,
        },
      });

      if (!solicitud) {
        res.status(404).json({
          success: false,
          error: 'Solicitud no encontrada',
        });
        return;
      }

      res.json({
        success: true,
        data: solicitud,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener solicitud';
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

      const solicitud = await prisma.solicitud.update({
        where: { id: parseInt(id) },
        data: { status },
      });

      res.json({
        success: true,
        data: solicitud,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al actualizar status';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async delete(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      await prisma.solicitud.update({
        where: { id: parseInt(id) },
        data: { deleted_at: new Date() },
      });

      res.json({
        success: true,
        message: 'Solicitud eliminada correctamente',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al eliminar solicitud';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getStats(req: AuthRequest, res: Response): Promise<void> {
    try {
      const yearInicio = req.query.yearInicio as string;
      const yearFin = req.query.yearFin as string;
      const catorcenaInicio = req.query.catorcenaInicio as string;
      const catorcenaFin = req.query.catorcenaFin as string;

      const where: Record<string, unknown> = { deleted_at: null };

      // Apply date filters
      if (yearInicio && yearFin && catorcenaInicio && catorcenaFin) {
        const catorcenasInicio = await prisma.catorcenas.findFirst({
          where: {
            a_o: parseInt(yearInicio),
            numero_catorcena: parseInt(catorcenaInicio),
          },
        });
        const catorcenasFin = await prisma.catorcenas.findFirst({
          where: {
            a_o: parseInt(yearFin),
            numero_catorcena: parseInt(catorcenaFin),
          },
        });

        if (catorcenasInicio && catorcenasFin) {
          where.fecha = {
            gte: catorcenasInicio.fecha_inicio,
            lte: catorcenasFin.fecha_fin,
          };
        }
      } else if (yearInicio && yearFin) {
        where.fecha = {
          gte: new Date(`${yearInicio}-01-01`),
          lte: new Date(`${yearFin}-12-31`),
        };
      }

      // Get all distinct status values
      const statusGroups = await prisma.solicitud.groupBy({
        by: ['status'],
        where,
        _count: true,
      });

      const total = statusGroups.reduce((acc, s) => acc + s._count, 0);
      const byStatus: Record<string, number> = {};
      statusGroups.forEach(s => {
        byStatus[s.status] = s._count;
      });

      res.json({
        success: true,
        data: {
          total,
          byStatus,
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

  async getCatorcenas(req: AuthRequest, res: Response): Promise<void> {
    try {
      const year = req.query.year as string;

      const where: Record<string, unknown> = {};
      if (year) {
        where.a_o = parseInt(year);
      }

      const catorcenas = await prisma.catorcenas.findMany({
        where,
        orderBy: [{ a_o: 'desc' }, { numero_catorcena: 'asc' }],
      });

      // Get distinct years
      const years = await prisma.catorcenas.findMany({
        select: { a_o: true },
        distinct: ['a_o'],
        orderBy: { a_o: 'desc' },
      });

      res.json({
        success: true,
        data: catorcenas,
        years: years.map(y => y.a_o),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener catorcenas';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async exportAll(req: AuthRequest, res: Response): Promise<void> {
    try {
      const status = req.query.status as string;
      const search = req.query.search as string;
      const yearInicio = req.query.yearInicio as string;
      const yearFin = req.query.yearFin as string;
      const catorcenaInicio = req.query.catorcenaInicio as string;
      const catorcenaFin = req.query.catorcenaFin as string;

      const where: Record<string, unknown> = {
        deleted_at: null,
      };

      if (status) {
        where.status = status;
      }

      if (search) {
        where.OR = [
          { razon_social: { contains: search } },
          { descripcion: { contains: search } },
          { marca_nombre: { contains: search } },
          { asignado: { contains: search } },
          { cuic: { contains: search } },
        ];
      }

      if (yearInicio && yearFin && catorcenaInicio && catorcenaFin) {
        const catorcenasInicioData = await prisma.catorcenas.findFirst({
          where: {
            a_o: parseInt(yearInicio),
            numero_catorcena: parseInt(catorcenaInicio),
          },
        });
        const catorcenasFinData = await prisma.catorcenas.findFirst({
          where: {
            a_o: parseInt(yearFin),
            numero_catorcena: parseInt(catorcenaFin),
          },
        });

        if (catorcenasInicioData && catorcenasFinData) {
          where.fecha = {
            gte: catorcenasInicioData.fecha_inicio,
            lte: catorcenasFinData.fecha_fin,
          };
        }
      } else if (yearInicio && yearFin) {
        where.fecha = {
          gte: new Date(`${yearInicio}-01-01`),
          lte: new Date(`${yearFin}-12-31`),
        };
      } else if (yearInicio) {
        where.fecha = {
          gte: new Date(`${yearInicio}-01-01`),
          lte: new Date(`${yearInicio}-12-31`),
        };
      }

      const solicitudes = await prisma.solicitud.findMany({
        where,
        orderBy: { fecha: 'desc' },
      });

      res.json({
        success: true,
        data: solicitudes,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al exportar solicitudes';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }
}

export const solicitudesController = new SolicitudesController();
