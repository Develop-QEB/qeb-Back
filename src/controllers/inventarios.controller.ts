import { Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';

export class InventariosController {
  async getAll(req: AuthRequest, res: Response): Promise<void> {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      const search = req.query.search as string;
      const tipo = req.query.tipo as string;
      const estatus = req.query.estatus as string;
      const plaza = req.query.plaza as string;

      const where: Record<string, unknown> = {};

      if (search) {
        where.OR = [
          { codigo_unico: { contains: search } },
          { ubicacion: { contains: search } },
          { municipio: { contains: search } },
        ];
      }

      if (tipo) {
        where.tipo_de_mueble = tipo;
      }

      if (estatus) {
        where.estatus = estatus;
      }

      if (plaza) {
        where.plaza = plaza;
      }

      const [inventarios, total] = await Promise.all([
        prisma.inventarios.findMany({
          where,
          skip: (page - 1) * limit,
          take: limit,
          orderBy: { codigo_unico: 'asc' },
        }),
        prisma.inventarios.count({ where }),
      ]);

      res.json({
        success: true,
        data: inventarios,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener inventarios';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getForMap(req: AuthRequest, res: Response): Promise<void> {
    try {
      const tipo = req.query.tipo as string;
      const estatus = req.query.estatus as string;
      const plaza = req.query.plaza as string;

      const where: Record<string, unknown> = {
        latitud: { not: 0 },
        longitud: { not: 0 },
      };

      if (tipo) {
        where.tipo_de_mueble = tipo;
      }

      if (estatus) {
        where.estatus = estatus;
      }

      if (plaza) {
        where.plaza = plaza;
      }

      const inventarios = await prisma.inventarios.findMany({
        where,
        select: {
          id: true,
          codigo_unico: true,
          ubicacion: true,
          tipo_de_mueble: true,
          tipo_de_cara: true,
          cara: true,
          latitud: true,
          longitud: true,
          plaza: true,
          estado: true,
          municipio: true,
          estatus: true,
          tarifa_publica: true,
          tradicional_digital: true,
          ancho: true,
          alto: true,
        },
      });

      res.json({
        success: true,
        data: inventarios,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener inventarios';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getById(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const inventario = await prisma.inventarios.findUnique({
        where: { id: parseInt(id) },
      });

      if (!inventario) {
        res.status(404).json({
          success: false,
          error: 'Inventario no encontrado',
        });
        return;
      }

      res.json({
        success: true,
        data: inventario,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener inventario';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getStats(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const [total, disponibles, ocupados, mantenimiento, byTipo, byPlaza] = await Promise.all([
        prisma.inventarios.count(),
        prisma.inventarios.count({ where: { estatus: 'Disponible' } }),
        prisma.inventarios.count({ where: { estatus: 'Ocupado' } }),
        prisma.inventarios.count({ where: { estatus: 'Mantenimiento' } }),
        prisma.inventarios.groupBy({
          by: ['tipo_de_mueble'],
          _count: { id: true },
        }),
        prisma.inventarios.groupBy({
          by: ['plaza'],
          _count: { id: true },
        }),
      ]);

      res.json({
        success: true,
        data: {
          total,
          disponibles,
          ocupados,
          mantenimiento,
          porTipo: byTipo
            .filter((item) => item.tipo_de_mueble)
            .map((item) => ({
              tipo: item.tipo_de_mueble,
              cantidad: item._count.id,
            })),
          porPlaza: byPlaza
            .filter((item) => item.plaza)
            .map((item) => ({
              plaza: item.plaza,
              cantidad: item._count.id,
            })),
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

  async getTipos(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const tipos = await prisma.inventarios.findMany({
        select: { tipo_de_mueble: true },
        distinct: ['tipo_de_mueble'],
      });

      res.json({
        success: true,
        data: tipos.map((t) => t.tipo_de_mueble).filter(Boolean),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener tipos';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getPlazas(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const plazas = await prisma.inventarios.findMany({
        select: { plaza: true },
        distinct: ['plaza'],
      });

      res.json({
        success: true,
        data: plazas.map((p) => p.plaza).filter(Boolean),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener plazas';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getEstatus(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const estatusList = await prisma.inventarios.findMany({
        select: { estatus: true },
        distinct: ['estatus'],
      });

      res.json({
        success: true,
        data: estatusList.map((e) => e.estatus).filter(Boolean),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener estatus';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }
}

export const inventariosController = new InventariosController();
