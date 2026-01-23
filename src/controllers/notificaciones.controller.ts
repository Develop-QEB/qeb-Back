import { Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';
import {
  aprobarCaras,
  rechazarSolicitud,
  obtenerResumenAutorizacion
} from '../services/autorizacion.service';
import { emitToAll, SOCKET_EVENTS } from '../config/socket';

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
      const orderBy = req.query.orderBy as string || 'fecha_inicio';
      const orderDir = req.query.orderDir as string || 'desc';
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
        orderByClause.fecha_inicio = 'desc';
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
      let comentarios: { id: number; autor_id: number; autor_nombre: string; autor_foto: string | null; contenido: string; fecha: Date; solicitud_id: number }[] = [];
      if (tarea.id_solicitud) {
        const solicitudId = parseInt(tarea.id_solicitud);
        const rawComentarios = await prisma.comentarios.findMany({
          where: { solicitud_id: solicitudId },
          orderBy: { creado_en: 'desc' },
        });

        // Obtener los nombres y fotos de los autores
        const autorIds = [...new Set(rawComentarios.map(c => c.autor_id))];
        const usuarios = await prisma.usuario.findMany({
          where: { id: { in: autorIds } },
          select: { id: true, nombre: true, foto_perfil: true },
        });
        const usuarioMap = new Map(usuarios.map(u => [u.id, { nombre: u.nombre, foto_perfil: u.foto_perfil }]));

        comentarios = rawComentarios.map(c => ({
          id: c.id,
          autor_id: c.autor_id,
          autor_nombre: usuarioMap.get(c.autor_id)?.nombre || 'Usuario',
          autor_foto: usuarioMap.get(c.autor_id)?.foto_perfil || null,
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

      // Emitir evento WebSocket para actualizar notificaciones en tiempo real
      emitToAll(SOCKET_EVENTS.NOTIFICACION_NUEVA, {
        tareaId: tarea.id,
        tipo: tarea.tipo,
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

      // Emitir evento WebSocket para actualizar contador
      emitToAll(SOCKET_EVENTS.NOTIFICACION_LEIDA, { tareaId: tarea.id });

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

      // Emitir evento WebSocket para actualizar contador
      emitToAll(SOCKET_EVENTS.NOTIFICACION_LEIDA, { all: true, userId });

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
          origen: 'tarea',
        },
      });

      // Crear notificaciones para todos los involucrados (excepto el autor)
      const userName = req.user?.nombre || 'Usuario';
      const tituloTarea = tarea.titulo || 'Tarea';
      const tituloNotificacion = `Nuevo comentario en tarea: ${tituloTarea}`;
      const descripcionNotificacion = `${userName} comentó: ${contenido.substring(0, 100)}${contenido.length > 100 ? '...' : ''}`;

      // Obtener solicitud relacionada para el creador
      const solicitudData = solicitudId > 0
        ? await prisma.solicitud.findUnique({ where: { id: solicitudId } })
        : null;

      // Recopilar todos los involucrados (sin duplicados, excluyendo al autor)
      const involucrados = new Set<number>();

      // Agregar responsable de la tarea
      if (tarea.id_responsable && tarea.id_responsable !== userId) {
        involucrados.add(tarea.id_responsable);
      }

      // Agregar asignados de la tarea
      if (tarea.id_asignado) {
        tarea.id_asignado.split(',').forEach(id => {
          const parsed = parseInt(id.trim());
          if (!isNaN(parsed) && parsed !== userId) {
            involucrados.add(parsed);
          }
        });
      }

      // Agregar creador de la solicitud
      if (solicitudData?.usuario_id && solicitudData.usuario_id !== userId) {
        involucrados.add(solicitudData.usuario_id);
      }

      // Crear una notificación para cada involucrado
      const now = new Date();
      const fechaFin = new Date(now.getTime() + 24 * 60 * 60 * 1000); // +1 día

      for (const responsableId of involucrados) {
        await prisma.tareas.create({
          data: {
            titulo: tituloNotificacion,
            descripcion: descripcionNotificacion,
            tipo: 'Notificación',
            estatus: 'Pendiente',
            id_responsable: responsableId,
            id_solicitud: solicitudId.toString(),
            id_propuesta: tarea.id_propuesta || '',
            campania_id: tarea.campania_id || null,
            fecha_inicio: now,
            fecha_fin: fechaFin,
            responsable: '',
            asignado: userName,
            id_asignado: userId.toString(),
          },
        });
      }

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

      // Obtener los nombres y fotos de los autores
      const autorIds = [...new Set(comentarios.map(c => c.autor_id))];
      const usuarios = await prisma.usuario.findMany({
        where: { id: { in: autorIds } },
        select: { id: true, nombre: true, foto_perfil: true },
      });
      const usuarioMap = new Map(usuarios.map(u => [u.id, { nombre: u.nombre, foto_perfil: u.foto_perfil }]));

      // Mapear a formato esperado con nombre y foto del autor
      const mappedComentarios = comentarios.map(c => ({
        id: c.id,
        autor_id: c.autor_id,
        autor_nombre: usuarioMap.get(c.autor_id)?.nombre || 'Usuario',
        autor_foto: usuarioMap.get(c.autor_id)?.foto_perfil || null,
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

  // ==================== ENDPOINTS DE AUTORIZACIÓN ====================

  /**
   * Obtiene el resumen de autorización de una solicitud
   */
  async getResumenAutorizacion(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { idquote } = req.params;

      if (!idquote) {
        res.status(400).json({
          success: false,
          error: 'Se requiere el idquote de la solicitud',
        });
        return;
      }

      const resumen = await obtenerResumenAutorizacion(idquote);

      res.json({
        success: true,
        data: resumen,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener resumen de autorización';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  /**
   * Aprueba las caras pendientes de autorización para DG o DCM
   */
  async aprobarAutorizacion(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { idquote, tipo } = req.params;
      const userId = req.user?.userId;
      const userName = req.user?.nombre || 'Usuario';

      if (!idquote || !tipo) {
        res.status(400).json({
          success: false,
          error: 'Se requiere idquote y tipo de autorización (dg o dcm)',
        });
        return;
      }

      if (tipo !== 'dg' && tipo !== 'dcm') {
        res.status(400).json({
          success: false,
          error: 'El tipo de autorización debe ser "dg" o "dcm"',
        });
        return;
      }

      // Verificar que el usuario tiene permiso para aprobar
      const usuario = await prisma.usuario.findUnique({
        where: { id: userId },
        select: { puesto: true },
      });

      if (!usuario) {
        res.status(403).json({
          success: false,
          error: 'Usuario no encontrado',
        });
        return;
      }

      const puestoUpper = (usuario.puesto || '').toUpperCase();
      const tipoUpper = tipo.toUpperCase();

      if (!puestoUpper.includes(tipoUpper)) {
        res.status(403).json({
          success: false,
          error: `No tienes permiso para aprobar autorizaciones de ${tipoUpper}`,
        });
        return;
      }

      const result = await aprobarCaras(idquote, tipo, userId || 0, userName);

      // Emit socket event for real-time updates
      const propuestaId = parseInt(idquote);
      if (!isNaN(propuestaId)) {
        emitToAll(SOCKET_EVENTS.AUTORIZACION_APROBADA, { propuestaId, idquote });
      }

      res.json({
        success: true,
        message: `${result.carasAprobadas} cara(s) aprobada(s) exitosamente`,
        data: result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al aprobar autorización';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  /**
   * Rechaza toda la solicitud
   */
  async rechazarAutorizacion(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { idquote } = req.params;
      const { comentario } = req.body;
      const userId = req.user?.userId;
      const userName = req.user?.nombre || 'Usuario';

      if (!idquote) {
        res.status(400).json({
          success: false,
          error: 'Se requiere el idquote de la solicitud',
        });
        return;
      }

      if (!comentario || comentario.trim() === '') {
        res.status(400).json({
          success: false,
          error: 'Se requiere un comentario/motivo de rechazo',
        });
        return;
      }

      // Verificar que el usuario tiene permiso para rechazar (DG o DCM)
      const usuario = await prisma.usuario.findUnique({
        where: { id: userId },
        select: { puesto: true },
      });

      if (!usuario) {
        res.status(403).json({
          success: false,
          error: 'Usuario no encontrado',
        });
        return;
      }

      const puestoUpper = (usuario.puesto || '').toUpperCase();
      if (!puestoUpper.includes('DG') && !puestoUpper.includes('DCM')) {
        res.status(403).json({
          success: false,
          error: 'No tienes permiso para rechazar solicitudes',
        });
        return;
      }

      // El idquote es en realidad el propuesta_id como string
      const propuestaId = parseInt(idquote);
      if (isNaN(propuestaId)) {
        res.status(400).json({
          success: false,
          error: 'idquote inválido',
        });
        return;
      }

      // Obtener la propuesta para conseguir el solicitud_id
      const propuesta = await prisma.propuesta.findUnique({
        where: { id: propuestaId },
        select: { solicitud_id: true },
      });

      if (!propuesta) {
        res.status(404).json({
          success: false,
          error: 'Propuesta no encontrada',
        });
        return;
      }

      await rechazarSolicitud(idquote, propuesta.solicitud_id, userId || 0, userName, comentario);

      // Emit socket event for real-time updates
      const propuestaId = parseInt(idquote);
      if (!isNaN(propuestaId)) {
        emitToAll(SOCKET_EVENTS.AUTORIZACION_RECHAZADA, { propuestaId, idquote });
      }

      res.json({
        success: true,
        message: 'Solicitud rechazada exitosamente',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al rechazar solicitud';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  /**
   * Obtiene las caras de una solicitud con su estado de autorización
   */
  async getCarasAutorizacion(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { idquote } = req.params;

      if (!idquote) {
        res.status(400).json({
          success: false,
          error: 'Se requiere el idquote de la solicitud',
        });
        return;
      }

      // Get solicitud info for cliente and campaña
      const solicitudInfo = await prisma.propuestas.findFirst({
        where: { idquote },
        select: {
          cliente_nombre: true,
          cotizacion: {
            select: {
              nombre_campania: true,
            },
          },
        },
      });

      const caras = await prisma.solicitudCaras.findMany({
        where: { idquote },
        select: {
          id: true,
          idquote: true,
          ciudad: true,
          formato: true,
          tipo: true,
          caras: true,
          bonificacion: true,
          costo: true,
          tarifa_publica: true,
          estado_autorizacion: true,
          articulo: true,
          inicio_periodo: true,
        },
      });

      // Get catorcena info based on the first cara's periodo
      let catorcenaInfo: string | null = null;
      if (caras.length > 0 && caras[0].inicio_periodo) {
        const fecha = new Date(caras[0].inicio_periodo);
        const catorcena = await prisma.catorcenas.findFirst({
          where: {
            fecha_inicio: { lte: fecha },
            fecha_fin: { gte: fecha },
          },
        });
        if (catorcena) {
          catorcenaInfo = `Cat ${catorcena.numero_catorcena} - ${catorcena.a_o}`;
        }
      }

      // Calcular tarifa efectiva para cada cara e incluir cliente/campaña/catorcena
      const carasConTarifa = caras.map(cara => {
        const totalCaras = (cara.caras || 0) + (Number(cara.bonificacion) || 0);
        const tarifaEfectiva = totalCaras > 0 ? (Number(cara.costo) || 0) / totalCaras : 0;
        return {
          ...cara,
          total_caras: totalCaras,
          tarifa_efectiva: tarifaEfectiva,
          cliente: solicitudInfo?.cliente_nombre || null,
          campana: solicitudInfo?.cotizacion?.nombre_campania || null,
          catorcena: catorcenaInfo,
        };
      });

      res.json({
        success: true,
        data: carasConTarifa,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener caras de autorización';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }
}

export const notificacionesController = new NotificacionesController();
