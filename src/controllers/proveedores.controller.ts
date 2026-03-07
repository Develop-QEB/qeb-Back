import { Response } from 'express';
import { validationResult } from 'express-validator';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';
import { emitToProveedores, emitToDashboard, SOCKET_EVENTS } from '../config/socket';

export class ProveedoresController {
  async getAll(req: AuthRequest, res: Response): Promise<void> {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const search = req.query.search as string;
      const estado = req.query.estado as string;

      const where: Record<string, unknown> = {
        deleted_at: null,
      };

      if (search) {
        where.OR = [
          { nombre: { contains: search } },
          { ciudad: { contains: search } },
          { contacto_principal: { contains: search } },
        ];
      }

      if (estado === 'activo' || estado === 'inactivo') {
        where.estado = estado;
      }

      const [proveedores, total] = await Promise.all([
        prisma.proveedores.findMany({
          where,
          skip: (page - 1) * limit,
          take: limit,
          orderBy: { nombre: 'asc' },
        }),
        prisma.proveedores.count({ where }),
      ]);

      res.json({
        success: true,
        data: proveedores,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener proveedores';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getById(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const proveedor = await prisma.proveedores.findFirst({
        where: {
          id: parseInt(id),
          deleted_at: null,
        },
      });

      if (!proveedor) {
        res.status(404).json({
          success: false,
          error: 'Proveedor no encontrado',
        });
        return;
      }

      res.json({
        success: true,
        data: proveedor,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener proveedor';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          error: 'Datos de entrada invalidos',
          details: errors.array(),
        });
        return;
      }

      const {
        nombre,
        direccion,
        ciudad,
        codigo_postal,
        telefono,
        email,
        sitio_web,
        contacto_principal,
        categoria,
        notas,
      } = req.body;

      const proveedor = await prisma.proveedores.create({
        data: {
          nombre,
          direccion,
          ciudad,
          codigo_postal,
          telefono,
          email,
          sitio_web,
          contacto_principal,
          categoria,
          notas,
          fecha_alta: new Date(),
          estado: 'activo',
        },
      });

      res.status(201).json({
        success: true,
        data: proveedor,
      });

      // Emitir evento WebSocket
      const userName = req.user?.nombre || 'Usuario';
      emitToProveedores(SOCKET_EVENTS.PROVEEDOR_CREADO, {
        proveedor,
        usuario: userName,
      });
      emitToDashboard(SOCKET_EVENTS.DASHBOARD_UPDATED, { tipo: 'proveedor', accion: 'creado' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al crear proveedor';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async update(req: AuthRequest, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          error: 'Datos de entrada invalidos',
          details: errors.array(),
        });
        return;
      }

      const { id } = req.params;
      const {
        nombre,
        direccion,
        ciudad,
        codigo_postal,
        telefono,
        email,
        sitio_web,
        contacto_principal,
        categoria,
        notas,
        estado,
      } = req.body;

      const existing = await prisma.proveedores.findFirst({
        where: {
          id: parseInt(id),
          deleted_at: null,
        },
      });

      if (!existing) {
        res.status(404).json({
          success: false,
          error: 'Proveedor no encontrado',
        });
        return;
      }

      const proveedor = await prisma.proveedores.update({
        where: { id: parseInt(id) },
        data: {
          nombre,
          direccion,
          ciudad,
          codigo_postal,
          telefono,
          email,
          sitio_web,
          contacto_principal,
          categoria,
          notas,
          estado,
        },
      });

      res.json({
        success: true,
        data: proveedor,
      });

      // Emitir evento WebSocket
      const userName = req.user?.nombre || 'Usuario';
      emitToProveedores(SOCKET_EVENTS.PROVEEDOR_ACTUALIZADO, {
        proveedor,
        usuario: userName,
      });
      emitToDashboard(SOCKET_EVENTS.DASHBOARD_UPDATED, { tipo: 'proveedor', accion: 'actualizado' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al actualizar proveedor';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getHistory(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const proveedor = await prisma.proveedores.findFirst({
        where: {
          id: parseInt(id),
          deleted_at: null,
        },
      });

      if (!proveedor) {
        res.status(404).json({
          success: false,
          error: 'Proveedor no encontrado',
        });
        return;
      }

      // Get tareas associated with this proveedor
      const tareas = await prisma.tareas.findMany({
        where: {
          proveedores_id: parseInt(id),
        },
        orderBy: { fecha_inicio: 'desc' },
      });

      // Get campaign info for each tarea
      const tareasWithCampaign = await Promise.all(
        tareas.map(async (tarea) => {
          let campania = null;
          if (tarea.campania_id) {
            campania = await prisma.campania.findUnique({
              where: { id: tarea.campania_id },
            });
          }
          return {
            ...tarea,
            campania,
          };
        })
      );

      res.json({
        success: true,
        data: {
          proveedor,
          tareas: tareasWithCampaign,
          totalTareas: tareas.length,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener historial';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async delete(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const existing = await prisma.proveedores.findFirst({
        where: {
          id: parseInt(id),
          deleted_at: null,
        },
      });

      if (!existing) {
        res.status(404).json({
          success: false,
          error: 'Proveedor no encontrado',
        });
        return;
      }

      await prisma.proveedores.update({
        where: { id: parseInt(id) },
        data: { deleted_at: new Date() },
      });

      res.json({
        success: true,
        message: 'Proveedor eliminado correctamente',
      });

      // Emitir evento WebSocket
      const userName = req.user?.nombre || 'Usuario';
      emitToProveedores(SOCKET_EVENTS.PROVEEDOR_ELIMINADO, {
        proveedorId: parseInt(id),
        usuario: userName,
      });
      emitToDashboard(SOCKET_EVENTS.DASHBOARD_UPDATED, { tipo: 'proveedor', accion: 'eliminado' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al eliminar proveedor';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }
}

export const proveedoresController = new ProveedoresController();
