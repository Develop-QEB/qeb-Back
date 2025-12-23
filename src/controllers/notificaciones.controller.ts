import { Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';

export class NotificacionesController {
  async getAll(req: AuthRequest, res: Response): Promise<void> {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      const tipo = req.query.tipo as string;
      const estatus = req.query.estatus as string;
      const leida = req.query.leida as string;
      const search = req.query.search as string;
      const groupBy = req.query.groupBy as string;
      const orderBy = req.query.orderBy as string || 'fecha_fin';
      const orderDir = req.query.orderDir as string || 'asc';
      const userId = req.user?.userId;

      const where: Record<string, unknown> = {};

      // Filtrar por usuario responsable o asignado
      if (userId) {
        where.OR = [
          { id_responsable: userId },
          { id_asignado: { contains: String(userId) } },
        ];
      }

      if (tipo) {
        where.tipo = tipo;
      }

      if (estatus) {
        where.estatus = estatus;
      }

      if (leida !== undefined && leida !== '') {
        // 'leida' = estatus 'Atendido'
        if (leida === 'true') {
          where.estatus = 'Atendido';
        } else {
          where.estatus = { not: 'Atendido' };
        }
      }

      if (search) {
        where.AND = [
          {
            OR: [
              { titulo: { contains: search } },
              { descripcion: { contains: search } },
              { contenido: { contains: search } },
              { responsable: { contains: search } },
              { asignado: { contains: search } },
            ],
          },
        ];
      }

      // Determinar ordenamiento
      const orderByClause: Record<string, string> = {};
      if (orderBy === 'fecha_fin') {
        orderByClause.fecha_fin = orderDir;
      } else if (orderBy === 'fecha_inicio') {
        orderByClause.fecha_inicio = orderDir;
      } else if (orderBy === 'titulo') {
        orderByClause.titulo = orderDir;
      } else if (orderBy === 'estatus') {
        orderByClause.estatus = orderDir;
      } else {
        orderByClause.fecha_fin = 'asc';
      }

      const [tareas, total] = await Promise.all([
        prisma.tareas.findMany({
          where,
          skip: (page - 1) * limit,
          take: limit,
          orderBy: orderByClause,
        }),
        prisma.tareas.count({ where }),
      ]);

      // Mapear tareas al formato de notificaciones con todos los campos
      const notificaciones = tareas.map(tarea => ({
        id: tarea.id,
        usuario_id: tarea.id_responsable,
        titulo: tarea.titulo || 'Sin título',
        mensaje: tarea.descripcion || tarea.contenido || '',
        tipo: tarea.tipo || 'info',
        leida: tarea.estatus === 'Atendido',
        referencia_tipo: tarea.id_solicitud ? 'solicitud' : tarea.id_propuesta ? 'propuesta' : tarea.campania_id ? 'campana' : null,
        referencia_id: tarea.id_solicitud ? parseInt(tarea.id_solicitud) : tarea.id_propuesta ? parseInt(tarea.id_propuesta) : tarea.campania_id,
        fecha_creacion: tarea.fecha_inicio,
        fecha_inicio: tarea.fecha_inicio,
        fecha_fin: tarea.fecha_fin,
        responsable: tarea.responsable,
        id_responsable: tarea.id_responsable,
        asignado: tarea.asignado,
        estatus: tarea.estatus,
        descripcion: tarea.descripcion,
        contenido: tarea.contenido,
        archivo: tarea.archivo,
        evidencia: tarea.evidencia,
        campania_id: tarea.campania_id,
        id_solicitud: tarea.id_solicitud,
        id_propuesta: tarea.id_propuesta,
        nombre_proveedores: tarea.nombre_proveedores,
        listado_inventario: tarea.listado_inventario,
        id_asignado: tarea.id_asignado,
        ids_reservas: tarea.ids_reservas,
      }));

      res.json({
        success: true,
        data: notificaciones,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener notificaciones';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getById(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const tarea = await prisma.tareas.findUnique({
        where: { id: parseInt(id) },
      });

      if (!tarea) {
        res.status(404).json({
          success: false,
          error: 'Notificación no encontrada',
        });
        return;
      }

      // Obtener comentarios de la tabla comentarios usando solicitud_id
      let comentarios: { id: number; autor_id: number; contenido: string; fecha: Date; solicitud_id: number }[] = [];
      if (tarea.id_solicitud) {
        const solicitudId = parseInt(tarea.id_solicitud);
        const rawComentarios = await prisma.comentarios.findMany({
          where: { solicitud_id: solicitudId },
          orderBy: { creado_en: 'desc' },
        });
        comentarios = rawComentarios.map(c => ({
          id: c.id,
          autor_id: c.autor_id,
          contenido: c.comentario,
          fecha: c.creado_en,
          solicitud_id: c.solicitud_id,
        }));
      }

      const notificacion = {
        id: tarea.id,
        usuario_id: tarea.id_responsable,
        titulo: tarea.titulo || 'Sin título',
        mensaje: tarea.descripcion || tarea.contenido || '',
        tipo: tarea.tipo || 'info',
        leida: tarea.estatus === 'Atendido',
        referencia_tipo: tarea.id_solicitud ? 'solicitud' : tarea.id_propuesta ? 'propuesta' : tarea.campania_id ? 'campana' : null,
        referencia_id: tarea.id_solicitud ? parseInt(tarea.id_solicitud) : tarea.id_propuesta ? parseInt(tarea.id_propuesta) : tarea.campania_id,
        fecha_creacion: tarea.fecha_inicio,
        fecha_inicio: tarea.fecha_inicio,
        fecha_fin: tarea.fecha_fin,
        responsable: tarea.responsable,
        id_responsable: tarea.id_responsable,
        asignado: tarea.asignado,
        estatus: tarea.estatus,
        descripcion: tarea.descripcion,
        contenido: tarea.contenido,
        archivo: tarea.archivo,
        evidencia: tarea.evidencia,
        campania_id: tarea.campania_id,
        id_solicitud: tarea.id_solicitud,
        id_propuesta: tarea.id_propuesta,
        nombre_proveedores: tarea.nombre_proveedores,
        listado_inventario: tarea.listado_inventario,
        id_asignado: tarea.id_asignado,
        ids_reservas: tarea.ids_reservas,
        comentarios,
      };

      res.json({
        success: true,
        data: notificacion,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener notificación';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      const userName = 'Usuario';
      const {
        titulo,
        descripcion,
        tipo,
        fecha_fin,
        asignado,
        id_asignado,
        id_solicitud,
        id_propuesta,
        campania_id,
      } = req.body;

      const tarea = await prisma.tareas.create({
        data: {
          titulo: titulo || 'Nueva tarea',
          descripcion,
          tipo: tipo || 'Tarea',
          estatus: 'Activo',
          fecha_inicio: new Date(),
          fecha_fin: fecha_fin ? new Date(fecha_fin) : new Date(),
          id_responsable: userId || 0,
          responsable: userName,
          asignado: asignado || userName,
          id_asignado: id_asignado || String(userId),
          id_solicitud: id_solicitud || '',
          id_propuesta,
          campania_id,
        },
      });

      res.status(201).json({
        success: true,
        data: {
          id: tarea.id,
          titulo: tarea.titulo,
          descripcion: tarea.descripcion,
          tipo: tarea.tipo,
          estatus: tarea.estatus,
          fecha_creacion: tarea.fecha_inicio,
          fecha_fin: tarea.fecha_fin,
          responsable: tarea.responsable,
          asignado: tarea.asignado,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al crear tarea';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async update(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const {
        titulo,
        descripcion,
        tipo,
        estatus,
        fecha_fin,
        asignado,
        id_asignado,
        archivo,
        evidencia,
      } = req.body;

      const updateData: Record<string, unknown> = {};
      if (titulo !== undefined) updateData.titulo = titulo;
      if (descripcion !== undefined) updateData.descripcion = descripcion;
      if (tipo !== undefined) updateData.tipo = tipo;
      if (estatus !== undefined) updateData.estatus = estatus;
      if (fecha_fin !== undefined) updateData.fecha_fin = new Date(fecha_fin);
      if (asignado !== undefined) updateData.asignado = asignado;
      if (id_asignado !== undefined) updateData.id_asignado = id_asignado;
      if (archivo !== undefined) updateData.archivo = archivo;
      if (evidencia !== undefined) updateData.evidencia = evidencia;

      const tarea = await prisma.tareas.update({
        where: { id: parseInt(id) },
        data: updateData,
      });

      res.json({
        success: true,
        data: {
          id: tarea.id,
          titulo: tarea.titulo,
          descripcion: tarea.descripcion,
          tipo: tarea.tipo,
          estatus: tarea.estatus,
          fecha_creacion: tarea.fecha_inicio,
          fecha_fin: tarea.fecha_fin,
          responsable: tarea.responsable,
          asignado: tarea.asignado,
          leida: tarea.estatus === 'Atendido',
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al actualizar tarea';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async marcarLeida(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const tarea = await prisma.tareas.update({
        where: { id: parseInt(id) },
        data: { estatus: 'Atendido' },
      });

      const notificacion = {
        id: tarea.id,
        usuario_id: tarea.id_responsable,
        titulo: tarea.titulo || 'Sin título',
        mensaje: tarea.descripcion || tarea.contenido || '',
        tipo: tarea.tipo || 'info',
        leida: true,
        referencia_tipo: tarea.id_solicitud ? 'solicitud' : tarea.id_propuesta ? 'propuesta' : tarea.campania_id ? 'campana' : null,
        referencia_id: tarea.id_solicitud ? parseInt(tarea.id_solicitud) : tarea.id_propuesta ? parseInt(tarea.id_propuesta) : tarea.campania_id,
        fecha_creacion: tarea.fecha_inicio,
        estatus: tarea.estatus,
      };

      res.json({
        success: true,
        data: notificacion,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al marcar como leída';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async marcarTodasLeidas(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;

      const where: Record<string, unknown> = {
        estatus: { not: 'Atendido' },
      };

      if (userId) {
        where.OR = [
          { id_responsable: userId },
          { id_asignado: { contains: String(userId) } },
        ];
      }

      await prisma.tareas.updateMany({
        where,
        data: { estatus: 'Atendido' },
      });

      res.json({
        success: true,
        message: 'Todas las notificaciones marcadas como atendidas',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al marcar todas como atendidas';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async delete(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      await prisma.tareas.delete({
        where: { id: parseInt(id) },
      });

      res.json({
        success: true,
        message: 'Notificación eliminada',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al eliminar notificación';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getStats(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;

      const where: Record<string, unknown> = {};
      if (userId) {
        where.OR = [
          { id_responsable: userId },
          { id_asignado: { contains: String(userId) } },
        ];
      }

      const [total, activas, porTipo, porEstatus] = await Promise.all([
        prisma.tareas.count({ where }),
        prisma.tareas.count({ where: { ...where, estatus: { not: 'Atendido' } } }),
        prisma.tareas.groupBy({
          by: ['tipo'],
          where,
          _count: { tipo: true },
        }),
        prisma.tareas.groupBy({
          by: ['estatus'],
          where,
          _count: { estatus: true },
        }),
      ]);

      const por_tipo: Record<string, number> = {};
      porTipo.forEach(t => {
        const tipo = t.tipo || 'Sin tipo';
        por_tipo[tipo] = t._count.tipo;
      });

      const por_estatus: Record<string, number> = {};
      porEstatus.forEach(e => {
        const estatus = e.estatus || 'Sin estatus';
        por_estatus[estatus] = e._count.estatus;
      });

      res.json({
        success: true,
        data: {
          total,
          no_leidas: activas,
          activas,
          atendidas: total - activas,
          por_tipo,
          por_estatus,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener estadísticas';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async addComment(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { contenido } = req.body;
      const userId = req.user?.userId || 0;

      // Obtener la tarea para conseguir su solicitud_id
      const tarea = await prisma.tareas.findUnique({
        where: { id: parseInt(id) },
      });

      if (!tarea) {
        res.status(404).json({
          success: false,
          error: 'Tarea no encontrada',
        });
        return;
      }

      const solicitudId = tarea.id_solicitud ? parseInt(tarea.id_solicitud) : 0;

      const comentario = await prisma.comentarios.create({
        data: {
          autor_id: userId,
          comentario: contenido,
          creado_en: new Date(),
          solicitud_id: solicitudId,
          campania_id: tarea.campania_id || 0,
        },
      });

      res.status(201).json({
        success: true,
        data: {
          id: comentario.id,
          autor_id: comentario.autor_id,
          contenido: comentario.comentario,
          fecha: comentario.creado_en,
          solicitud_id: comentario.solicitud_id,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al agregar comentario';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getComments(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      // Obtener la tarea para conseguir su solicitud_id
      const tarea = await prisma.tareas.findUnique({
        where: { id: parseInt(id) },
      });

      if (!tarea || !tarea.id_solicitud) {
        res.json({
          success: true,
          data: [],
        });
        return;
      }

      const solicitudId = parseInt(tarea.id_solicitud);

      const comentarios = await prisma.comentarios.findMany({
        where: { solicitud_id: solicitudId },
        orderBy: { creado_en: 'desc' },
      });

      // Mapear a formato esperado
      const mappedComentarios = comentarios.map(c => ({
        id: c.id,
        autor_id: c.autor_id,
        contenido: c.comentario,
        fecha: c.creado_en,
        solicitud_id: c.solicitud_id,
      }));

      res.json({
        success: true,
        data: mappedComentarios,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener comentarios';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }
}

export const notificacionesController = new NotificacionesController();
