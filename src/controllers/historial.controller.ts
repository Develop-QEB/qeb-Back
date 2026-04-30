import { Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';
import { serializeBigInt } from '../utils/serialization';
import { emitToHistorial, SOCKET_EVENTS } from '../config/socket';

export class HistorialController {
  async getAll(req: AuthRequest, res: Response): Promise<void> {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      const tipo = req.query.tipo as string;
      const search = req.query.search as string;
      const fechaDesde = req.query.fechaDesde as string;
      const fechaHasta = req.query.fechaHasta as string;
      const accion = req.query.accion as string;
      const usuario = req.query.usuario as string;

      const userRole = req.user?.rol;
      const userName = req.user?.nombre;
      const isAdmin = userRole === 'Administrador' || userRole === 'DEV';

      const where: Record<string, unknown> = {};
      const andConditions: Record<string, unknown>[] = [];

      if (tipo) {
        if (tipo.endsWith('*')) {
          where.tipo = { startsWith: tipo.slice(0, -1) };
        } else if (tipo.endsWith('_')) {
          where.tipo = { startsWith: tipo };
        } else {
          where.tipo = tipo;
        }
      }

      if (accion) {
        where.accion = { contains: accion };
      }

      if (fechaDesde || fechaHasta) {
        const fechaFilter: Record<string, Date> = {};
        if (fechaDesde) fechaFilter.gte = new Date(fechaDesde);
        if (fechaHasta) {
          const hasta = new Date(fechaHasta);
          hasta.setHours(23, 59, 59, 999);
          fechaFilter.lte = hasta;
        }
        where.fecha_hora = fechaFilter;
      }

      if (search) {
        andConditions.push({
          OR: [
            { accion: { contains: search } },
            { detalles: { contains: search } },
            { tipo: { contains: search } },
          ],
        });
      }

      if (usuario) {
        andConditions.push({
          OR: [
            { detalles: { contains: usuario } },
            { accion: { contains: usuario } },
          ],
        });
      }

      if (!isAdmin && userName) {
        andConditions.push({
          OR: [
            { accion: { contains: userName } },
            { detalles: { contains: userName } },
          ],
        });
      }

      if (andConditions.length > 0) {
        where.AND = andConditions;
      }

      const skip = (page - 1) * limit;

      const [data, total] = await Promise.all([
        prisma.historial.findMany({
          where,
          orderBy: { fecha_hora: 'desc' },
          skip,
          take: limit,
        }),
        prisma.historial.count({ where }),
      ]);

      res.json(serializeBigInt({
        success: true,
        data,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      }));
    } catch (error) {
      console.error('Error en historial getAll:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener historial';
      res.status(500).json({ success: false, error: message });
    }
  }

  async getTipos(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const tipos = await prisma.historial.findMany({
        select: { tipo: true },
        distinct: ['tipo'],
        orderBy: { tipo: 'asc' },
      });
      res.json({ success: true, data: tipos.map(t => t.tipo) });
    } catch (error) {
      console.error('Error en historial getTipos:', error);
      res.status(500).json({ success: false, error: 'Error al obtener tipos' });
    }
  }

  async getAcciones(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const acciones = await prisma.historial.findMany({
        select: { accion: true },
        distinct: ['accion'],
      });

      const patterns: [RegExp, string, string][] = [
        [/solicitó autorización/, 'Solicitud de autorización', 'solicitó autorización'],
        [/agregó circuito/, 'Agregó circuito', 'agregó circuito'],
        [/modificó.*campo/, 'Modificación de campos', 'modificó'],
        [/actualizó/, 'Actualización (usuario)', 'actualizó'],
        [/editó/, 'Edición (usuario)', 'editó'],
      ];

      const categories = new Map<string, string>();
      for (const { accion } of acciones) {
        const match = patterns.find(([re]) => re.test(accion));
        if (match) {
          if (!categories.has(match[2])) categories.set(match[2], match[1]);
        } else {
          if (!categories.has(accion)) categories.set(accion, accion);
        }
      }

      const result = Array.from(categories.entries())
        .map(([value, label]) => ({ label, value }))
        .sort((a, b) => a.label.localeCompare(b.label, 'es'));

      res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error en historial getAcciones:', error);
      res.status(500).json({ success: false, error: 'Error al obtener acciones' });
    }
  }

  async getUsuarios(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const usuarios = await prisma.usuario.findMany({
        where: { deleted_at: null },
        select: { id: true, nombre: true },
        orderBy: { nombre: 'asc' },
      });
      res.json({ success: true, data: usuarios });
    } catch (error) {
      console.error('Error en historial getUsuarios:', error);
      res.status(500).json({ success: false, error: 'Error al obtener usuarios' });
    }
  }

  async addNota(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { ref_id, tipo, nota } = req.body;
      const userName = req.user?.nombre || 'Usuario';

      if (!nota || !tipo) {
        res.status(400).json({ success: false, error: 'nota y tipo son requeridos' });
        return;
      }

      const entry = await prisma.historial.create({
        data: {
          tipo,
          ref_id: ref_id || 0,
          accion: 'Acción registrada',
          detalles: `${userName}: ${nota}`,
        },
      });

      const serialized = serializeBigInt(entry);
      emitToHistorial(SOCKET_EVENTS.HISTORIAL_NUEVA, serialized);
      res.json({ success: true, data: serialized });
    } catch (error) {
      console.error('Error en historial addNota:', error);
      const message = error instanceof Error ? error.message : 'Error al agregar nota';
      res.status(500).json({ success: false, error: message });
    }
  }
}

export const historialController = new HistorialController();
