import { Response } from 'express';
import prisma from '../utils/prisma';
import { Prisma } from '@prisma/client';
import { AuthRequest } from '../types';
import {
  aprobarCaras,
  rechazarSolicitud,
  obtenerResumenAutorizacion,
  depurarTareasAutorizacionResueltas,
} from '../services/autorizacion.service';
import { emitToAll, SOCKET_EVENTS } from '../config/socket';
import nodemailer from 'nodemailer';

// Exact token match for comma-separated id_asignado field (avoids substring false positives)
function idAsignadoMatch(userId: number | string): Record<string, unknown>[] {
  const id = String(userId);
  return [
    { id_asignado: id },                        // exact: "123"
    { id_asignado: { startsWith: `${id},` } },  // start: "123,..."
    { id_asignado: { endsWith: `,${id}` } },    // end: "...,123"
    { id_asignado: { contains: `,${id},` } },   // middle: "...,123,..."
  ];
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_PORT === '465',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  tls: { rejectUnauthorized: false },
});

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
      const quick = req.query.quick as string;

      const where: Record<string, unknown> = {};
      const userRole = req.user?.rol;

      // Filtrar por usuario responsable o asignado
      if (userId) {
        const orConditions: Record<string, unknown>[] = [
          { id_responsable: userId },
          ...idAsignadoMatch(userId),
        ];

        // Coordinador de Diseño también ve tareas de todos los Diseñadores
        if (userRole === 'Coordinador de Diseño') {
          const disenadores = await prisma.usuario.findMany({
            where: { user_role: 'Diseñadores', deleted_at: null },
            select: { id: true },
          });
          for (const d of disenadores) {
            orConditions.push({ id_responsable: d.id });
            orConditions.push(...idAsignadoMatch(d.id));
          }
        }

        // Gerente Digital (Operaciones) también ve tareas de todos los Jefe de Operaciones Digital
        if (userRole === 'Gerente Digital (Operaciones)') {
          const jefesDigital = await prisma.usuario.findMany({
            where: { user_role: 'Jefe de Operaciones Digital', deleted_at: null },
            select: { id: true },
          });
          for (const j of jefesDigital) {
            orConditions.push({ id_responsable: j.id });
            orConditions.push(...idAsignadoMatch(j.id));
          }
        }

        where.OR = orConditions;
      }

      if (tipo) {
        where.tipo = tipo;
      }

      if (!quick) {
        if (estatus) {
          where.estatus = estatus;
        }

      if (leida !== undefined && leida !== '') {
        // 'leida' = estatus 'Atendido'
        where.estatus =
      leida === 'true'
        ? 'Atendido'
        : { not: 'Atendido' };
  }
}

      if (search) {
        // IDs de tareas cuyos formatos (vía solicitud/propuesta/campaña) matchean el search
        const formatoLike = `%${search}%`;
        const formatoMatchRows = await prisma.$queryRaw<{ id: number }[]>`
          SELECT DISTINCT t.id FROM tareas t
          LEFT JOIN solicitudCaras sc_p ON CAST(sc_p.idquote AS UNSIGNED) = CAST(NULLIF(t.id_propuesta, '') AS UNSIGNED)
          LEFT JOIN propuesta pr_s ON pr_s.solicitud_id = CAST(NULLIF(t.id_solicitud, '') AS UNSIGNED)
          LEFT JOIN solicitudCaras sc_s ON CAST(sc_s.idquote AS UNSIGNED) = pr_s.id
          LEFT JOIN campania cm ON cm.id = t.campania_id
          LEFT JOIN cotizacion ct ON ct.id = cm.cotizacion_id
          LEFT JOIN solicitudCaras sc_c ON CAST(sc_c.idquote AS UNSIGNED) = ct.id_propuesta
          WHERE sc_p.formato LIKE ${formatoLike}
             OR sc_s.formato LIKE ${formatoLike}
             OR sc_c.formato LIKE ${formatoLike}
        `;
        const formatoMatchIds = formatoMatchRows.map(r => Number(r.id));

        // IDs de tareas que matchean por cliente o asesor (via solicitud + cliente)
        const clienteLike = `%${search}%`;
        const clienteMatchRows = await prisma.$queryRaw<{ id: number }[]>`
          SELECT DISTINCT t.id FROM tareas t
          LEFT JOIN solicitud sol ON sol.id = CAST(NULLIF(t.id_solicitud, '') AS UNSIGNED)
          LEFT JOIN cliente cl ON cl.CUIC = CAST(NULLIF(sol.cuic, '') AS UNSIGNED)
          WHERE COALESCE(cl.T0_U_Cliente, sol.razon_social) LIKE ${clienteLike}
             OR sol.asesor LIKE ${clienteLike}
        `;
        const clienteMatchIds = clienteMatchRows.map(r => Number(r.id));

        const orConditions: Record<string, unknown>[] = [
          { titulo: { contains: search } },
          { descripcion: { contains: search } },
          { contenido: { contains: search } },
          { responsable: { contains: search } },
          { asignado: { contains: search } },
        ];
        if (formatoMatchIds.length > 0) {
          orConditions.push({ id: { in: formatoMatchIds } });
        }
        if (clienteMatchIds.length > 0) {
          orConditions.push({ id: { in: clienteMatchIds } });
        }
        where.AND = [
          ...(Array.isArray(where.AND) ? where.AND : []),
          { OR: orConditions },
        ];
      }

      // filtros rapidos
      if (quick) {
        switch (quick) {
          case 'no_leidas':
            where.estatus = { not: 'Atendido' };
            break;

          case 'leidas':
            where.estatus = 'Atendido';
            break;

          case 'hoy': {
            const start = new Date();
            start.setHours(0, 0, 0, 0);

            const end = new Date();
            end.setHours(23, 59, 59, 999);

            where.fecha_inicio = {
              gte: start,
              lte: end,
            };
            break;
          }

          case 'vencidas':
            where.fecha_fin = { lt: new Date() };
            where.estatus = { not: 'Atendido' };
            break;

          case 'asignadas_a_mi':
            where.OR = idAsignadoMatch(userId!);
            break;

          case 'creadas_por_mi':
            where.OR = [{ id_responsable: userId }];
            break;
        }
      }


      // Determinar ordenamiento
      const orderByClause: Record<string, string> = {};
      if (orderBy === 'fecha_fin') {
        orderByClause.fecha_fin = orderDir;
      } else if (orderBy === 'fecha_inicio') {
        orderByClause.fecha_inicio = orderDir;
      } else if (orderBy === 'created_at') {
        orderByClause.created_at = orderDir;
      } else if (orderBy === 'titulo') {
        orderByClause.titulo = orderDir;
      } else if (orderBy === 'estatus') {
        orderByClause.estatus = orderDir;
      } else {
        // Por defecto ordenar por created_at (más nuevo primero)
        orderByClause.created_at = 'desc';
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

      // Auto-cleanup desactivado en getAll — se maneja solo desde el ApprovalModal del frontend

      // Obtener asesor y creador de las solicitudes relacionadas
      const solicitudIds = [...new Set(tareas
        .map(t => t.id_solicitud ? parseInt(t.id_solicitud) : null)
        .filter((id): id is number => id !== null && !isNaN(id))
      )];

      const solicitudMap: Record<number, { asesor: string | null; nombre_usuario: string | null; cliente_nombre: string | null; notas_direccion: string | null; descripcion_trafico: string | null }> = {};
      if (solicitudIds.length > 0) {
        const solicitudes = await prisma.$queryRaw<{ id: number; asesor: string | null; nombre_usuario: string | null; cliente_nombre: string | null; notas_direccion: string | null; descripcion_trafico: string | null }[]>`
          SELECT s.id, s.asesor, s.nombre_usuario, COALESCE(cl.T0_U_Cliente, s.razon_social) AS cliente_nombre, s.notas AS notas_direccion, s.descripcion AS descripcion_trafico
          FROM solicitud s
          LEFT JOIN cliente cl ON cl.CUIC = CAST(s.cuic AS UNSIGNED)
          WHERE s.id IN (${Prisma.join(solicitudIds)})
        `;
        for (const s of solicitudes) {
          solicitudMap[s.id] = { asesor: s.asesor, nombre_usuario: s.nombre_usuario, cliente_nombre: s.cliente_nombre, notas_direccion: s.notas_direccion, descripcion_trafico: s.descripcion_trafico };
        }
      }

      // Formatos por tarea: resolver a través de id_solicitud, id_propuesta o campania_id
      const formatosByTareaId: Record<number, string> = {};
      const propuestaIds = [...new Set(tareas
        .map(t => t.id_propuesta ? parseInt(t.id_propuesta) : null)
        .filter((id): id is number => id !== null && !isNaN(id))
      )];
      const campaniaIds = [...new Set(tareas
        .map(t => t.campania_id)
        .filter((id): id is number => id !== null && id !== undefined)
      )];

      const formatosBySolicitud: Record<number, string> = {};
      const formatosByPropuesta: Record<number, string> = {};
      const formatosByCampania: Record<number, string> = {};

      if (solicitudIds.length > 0) {
        const rows = await prisma.$queryRaw<{ solicitud_id: number; formatos: string | null }[]>`
          SELECT pr.solicitud_id, GROUP_CONCAT(DISTINCT NULLIF(sc.formato, '') ORDER BY sc.formato SEPARATOR ', ') AS formatos
          FROM propuesta pr
          LEFT JOIN solicitudCaras sc ON CAST(sc.idquote AS UNSIGNED) = pr.id
          WHERE pr.solicitud_id IN (${Prisma.join(solicitudIds)})
          GROUP BY pr.solicitud_id
        `;
        for (const r of rows) if (r.formatos) formatosBySolicitud[Number(r.solicitud_id)] = r.formatos;
      }

      if (propuestaIds.length > 0) {
        const rows = await prisma.$queryRaw<{ propuesta_id: number; formatos: string | null }[]>`
          SELECT CAST(sc.idquote AS UNSIGNED) AS propuesta_id, GROUP_CONCAT(DISTINCT NULLIF(sc.formato, '') ORDER BY sc.formato SEPARATOR ', ') AS formatos
          FROM solicitudCaras sc
          WHERE CAST(sc.idquote AS UNSIGNED) IN (${Prisma.join(propuestaIds)})
          GROUP BY CAST(sc.idquote AS UNSIGNED)
        `;
        for (const r of rows) if (r.formatos) formatosByPropuesta[Number(r.propuesta_id)] = r.formatos;
      }

      if (campaniaIds.length > 0) {
        const rows = await prisma.$queryRaw<{ campania_id: number; formatos: string | null }[]>`
          SELECT cm.id AS campania_id, GROUP_CONCAT(DISTINCT NULLIF(sc.formato, '') ORDER BY sc.formato SEPARATOR ', ') AS formatos
          FROM campania cm
          LEFT JOIN cotizacion ct ON ct.id = cm.cotizacion_id
          LEFT JOIN solicitudCaras sc ON CAST(sc.idquote AS UNSIGNED) = ct.id_propuesta
          WHERE cm.id IN (${Prisma.join(campaniaIds)})
          GROUP BY cm.id
        `;
        for (const r of rows) if (r.formatos) formatosByCampania[Number(r.campania_id)] = r.formatos;
      }

      for (const tarea of tareas) {
        const propId = tarea.id_propuesta ? parseInt(tarea.id_propuesta) : NaN;
        const solId = tarea.id_solicitud ? parseInt(tarea.id_solicitud) : NaN;
        const fmt = (!isNaN(propId) && formatosByPropuesta[propId])
          || (!isNaN(solId) && formatosBySolicitud[solId])
          || (tarea.campania_id && formatosByCampania[tarea.campania_id])
          || null;
        if (fmt) formatosByTareaId[tarea.id] = fmt as string;
      }

      // Mapear tareas al formato de notificaciones con todos los campos
      const notificaciones = tareas.map(tarea => {
        const solId = tarea.id_solicitud ? parseInt(tarea.id_solicitud) : null;
        const solData = solId ? solicitudMap[solId] : null;
        return {
        id: tarea.id,
        usuario_id: tarea.id_responsable,
        titulo: tarea.titulo || 'Sin título',
        mensaje: tarea.descripcion || tarea.contenido || '',
        tipo: tarea.tipo || 'info',
        leida: tarea.estatus === 'Atendido',
        referencia_tipo: (tarea.tipo?.includes('Autorización') || tarea.tipo?.includes('Rechazo') || tarea.tipo?.includes('Aprobación')) && tarea.contenido && ['solicitud', 'propuesta', 'campana'].includes(tarea.contenido)
          ? tarea.contenido
          : tarea.id_solicitud ? 'solicitud' : tarea.id_propuesta ? 'propuesta' : tarea.campania_id ? 'campana' : null,
        referencia_id: (tarea.tipo?.includes('Autorización') || tarea.tipo?.includes('Rechazo') || tarea.tipo?.includes('Aprobación')) && tarea.contenido === 'campana' ? tarea.campania_id
          : (tarea.tipo?.includes('Autorización') || tarea.tipo?.includes('Rechazo') || tarea.tipo?.includes('Aprobación')) && tarea.contenido === 'propuesta' ? (tarea.id_propuesta ? parseInt(tarea.id_propuesta) : null)
          : tarea.id_solicitud ? parseInt(tarea.id_solicitud) : tarea.id_propuesta ? parseInt(tarea.id_propuesta) : tarea.campania_id,
        fecha_creacion: tarea.created_at || tarea.fecha_inicio,
        created_at: tarea.created_at,
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
        asesor: solData?.asesor || null,
        creador: (tarea.tipo?.includes('Autorización') || tarea.tipo?.includes('Rechazo'))
          ? (tarea.responsable || solData?.nombre_usuario || null)
          : (solData?.nombre_usuario || null),
        cliente: solData?.cliente_nombre || null,
        notas_direccion: solData?.notas_direccion || null,
        descripcion_trafico: solData?.descripcion_trafico || null,
        formatos: formatosByTareaId[tarea.id] || null,
      };
      });

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

      // Obtener comentarios según el tipo de tarea
      const GESTION_ARTES_TIPOS = ['Revisión de artes', 'Revision de artes', 'Correccion', 'Corrección', 'Instalación', 'Impresión', 'Testigo', 'Programación', 'Recepción', 'Producción'];
      const isArtReviewTask = GESTION_ARTES_TIPOS.includes(tarea.tipo || '');
      let comentarios: { id: number; autor_id: number; autor_nombre: string; autor_foto: string | null; contenido: string; fecha: Date; solicitud_id?: number; tarea_id?: number }[] = [];

      if (isArtReviewTask) {
        // Para tareas de Revisión de artes / Corrección: usar tabla comentarios_revision_artes con tarea_id
        const rawComentarios = await prisma.$queryRaw<{ id: number; tarea_id: number; autor_id: number; autor_nombre: string; contenido: string; fecha: Date }[]>`
          SELECT id, tarea_id, autor_id, autor_nombre, contenido, fecha
          FROM comentarios_revision_artes
          WHERE tarea_id = ${tarea.id}
          ORDER BY fecha DESC
        `;

        // Obtener fotos de los autores
        const autorIds = [...new Set(rawComentarios.map(c => c.autor_id))];
        const usuarios = autorIds.length > 0 ? await prisma.usuario.findMany({
          where: { id: { in: autorIds } },
          select: { id: true, nombre: true, foto_perfil: true },
        }) : [];
        const usuarioMap = new Map(usuarios.map(u => [u.id, { nombre: u.nombre, foto_perfil: u.foto_perfil }]));

        comentarios = rawComentarios.map(c => ({
          id: c.id,
          autor_id: c.autor_id,
          autor_nombre: c.autor_nombre || usuarioMap.get(c.autor_id)?.nombre || 'Usuario',
          autor_foto: usuarioMap.get(c.autor_id)?.foto_perfil || null,
          contenido: c.contenido,
          fecha: c.fecha,
          tarea_id: c.tarea_id,
        }));
      } else if (tarea.id_solicitud) {
        // Para otras tareas: usar tabla comentarios con solicitud_id
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
        referencia_tipo: (tarea.tipo?.includes('Autorización') || tarea.tipo?.includes('Rechazo') || tarea.tipo?.includes('Aprobación')) && tarea.contenido && ['solicitud', 'propuesta', 'campana'].includes(tarea.contenido)
          ? tarea.contenido
          : tarea.id_solicitud ? 'solicitud' : tarea.id_propuesta ? 'propuesta' : tarea.campania_id ? 'campana' : null,
        referencia_id: (tarea.tipo?.includes('Autorización') || tarea.tipo?.includes('Rechazo') || tarea.tipo?.includes('Aprobación')) && tarea.contenido === 'campana' ? tarea.campania_id
          : (tarea.tipo?.includes('Autorización') || tarea.tipo?.includes('Rechazo') || tarea.tipo?.includes('Aprobación')) && tarea.contenido === 'propuesta' ? (tarea.id_propuesta ? parseInt(tarea.id_propuesta) : null)
          : tarea.id_solicitud ? parseInt(tarea.id_solicitud) : tarea.id_propuesta ? parseInt(tarea.id_propuesta) : tarea.campania_id,
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
        notas_direccion: null as string | null,
        descripcion_trafico: null as string | null,
        cliente: null as string | null,
        creador: null as string | null,
        asesor: null as string | null,
      };

      // Obtener datos de la solicitud relacionada
      if (tarea.id_solicitud) {
        const solId = parseInt(tarea.id_solicitud);
        if (!isNaN(solId)) {
          const solRows = await prisma.$queryRaw<{ notas: string | null; descripcion: string | null; cliente_nombre: string | null; nombre_usuario: string | null; asesor: string | null }[]>`
            SELECT s.notas, s.descripcion, s.nombre_usuario, s.asesor, COALESCE(cl.T0_U_Cliente, s.razon_social) AS cliente_nombre
            FROM solicitud s
            LEFT JOIN cliente cl ON cl.CUIC = CAST(s.cuic AS UNSIGNED)
            WHERE s.id = ${solId}
            LIMIT 1
          `;
          if (solRows.length > 0) {
            notificacion.notas_direccion = solRows[0].notas || null;
            notificacion.descripcion_trafico = solRows[0].descripcion || null;
            notificacion.cliente = solRows[0].cliente_nombre || null;
            notificacion.creador = (tarea.tipo?.includes('Autorización') || tarea.tipo?.includes('Rechazo'))
              ? (tarea.responsable || solRows[0].nombre_usuario || null)
              : (solRows[0].nombre_usuario || null);
            notificacion.asesor = solRows[0].asesor || null;
          }
        }
      }

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
          fecha_inicio: new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' })),
          fecha_fin: fecha_fin ? new Date(fecha_fin) : (() => { const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' })); d.setDate(d.getDate() + 7); return d; })(),
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

      // Si es tarea de ajuste y se finaliza, verificar si todas las hermanas ya están finalizadas
      if (
        ['Atendido', 'Completado', 'Finalizada'].includes(tarea.estatus || '') &&
        ['Ajuste Cto Cliente', 'Ajuste de Caras', 'Ajuste Comercial'].includes(tarea.tipo || '') &&
        tarea.id_propuesta
      ) {
        const tareasHermanas = await prisma.tareas.findMany({
          where: {
            id_propuesta: tarea.id_propuesta,
            tipo: tarea.tipo,
          },
          select: { id: true, estatus: true },
        });

        const todasFinalizadas = tareasHermanas.every(t =>
          ['Atendido', 'Completado', 'Cancelado', 'Finalizada'].includes(t.estatus || '')
        );

        if (todasFinalizadas) {
          const { count } = await prisma.propuesta.updateMany({
            where: { id: parseInt(tarea.id_propuesta), status: { not: 'Atendida' } },
            data: { status: 'Atendida', updated_at: new Date() },
          });

          // Si count === 0 ya estaba en "Atendida" (cambio manual previo), no duplicar notificación
          if (count === 0) return;

          const propuestaAtendida = await prisma.propuesta.findUnique({
            where: { id: parseInt(tarea.id_propuesta) },
            select: { solicitud_id: true, id_asignado: true },
          });

          const cotizacionAjuste = await prisma.cotizacion.findFirst({
            where: { id_propuesta: parseInt(tarea.id_propuesta) },
            select: { nombre_campania: true },
          });
          const nombreCampaniaAjuste = cotizacionAjuste?.nombre_campania || 'Propuesta';

          // Para "Ajuste Comercial", notificar a los asignados de tráfico (inverso)
          if (tarea.tipo === 'Ajuste Comercial' && propuestaAtendida?.id_asignado) {
            const idsTrafico = propuestaAtendida.id_asignado
              .split(',')
              .map(i => parseInt(i.trim()))
              .filter(i => !isNaN(i));

            const usuariosTrafico = idsTrafico.length > 0
              ? await prisma.usuario.findMany({
                  where: { id: { in: idsTrafico }, deleted_at: null },
                  select: { id: true, nombre: true, correo_electronico: true },
                })
              : [];

            const nowNotif = new Date();
            for (const usuarioTrafico of usuariosTrafico) {
              await prisma.tareas.create({
                data: {
                  titulo: `Ajuste completado: ${nombreCampaniaAjuste}`,
                  descripcion: 'Todos los ajustes comerciales han sido atendidos. El estado de la propuesta cambió a Atendida.',
                  tipo: 'Notificación',
                  estatus: 'Pendiente',
                  id_responsable: usuarioTrafico.id,
                  responsable: '',
                  id_solicitud: tarea.id_solicitud || '',
                  id_propuesta: tarea.id_propuesta,
                  campania_id: tarea.campania_id,
                  fecha_inicio: nowNotif,
                  fecha_fin: new Date(nowNotif.getTime() + 24 * 60 * 60 * 1000),
                  asignado: req.user?.nombre || 'Usuario',
                  id_asignado: (req.user?.userId || 0).toString(),
                },
              });

              if (usuarioTrafico.correo_electronico) {
                const nombrePropuesta = nombreCampaniaAjuste;
                const htmlBody = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
                <body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
                  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f3f4f6; padding: 40px 20px;">
                    <tr><td align="center">
                      <table width="500" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                        <tr><td style="background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); padding: 32px 40px; text-align: center;">
                          <h1 style="color: #ffffff; margin: 0; font-size: 32px; font-weight: 700;">QEB</h1>
                          <p style="color: rgba(255,255,255,0.85); margin: 6px 0 0 0; font-size: 13px; font-weight: 500;">OOH Management</p>
                        </td></tr>
                        <tr><td style="padding: 40px;">
                          <h2 style="color: #1f2937; margin: 0 0 8px 0; font-size: 22px; font-weight: 600;">Ajuste Comercial Completado</h2>
                          <p style="color: #6b7280; margin: 0 0 24px 0; font-size: 15px; line-height: 1.5;">
                            Hola <strong style="color: #374151;">${usuarioTrafico.nombre}</strong>, todos los ajustes comerciales de la siguiente propuesta han sido atendidos.
                          </p>
                          <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f9fafb; border-radius: 12px; border: 1px solid #e5e7eb; margin-bottom: 24px;">
                            <tr><td style="padding: 20px;">
                              <span style="display: inline-block; background-color: #10b981; color: #ffffff; font-size: 11px; font-weight: 600; padding: 4px 10px; border-radius: 20px; text-transform: uppercase; letter-spacing: 0.5px;">Atendida</span>
                              <h3 style="color: #1f2937; margin: 8px 0; font-size: 18px; font-weight: 600;">${nombrePropuesta}</h3>
                            </td></tr>
                          </table>
                          <table width="100%" cellpadding="0" cellspacing="0">
                            <tr><td align="center">
                              <a href="https://app.qeb.mx/propuestas?viewId=${tarea.id_propuesta}" style="display: inline-block; background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); color: #ffffff; padding: 14px 40px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 15px; box-shadow: 0 4px 14px rgba(139, 92, 246, 0.4);">Ver Propuesta</a>
                            </td></tr>
                          </table>
                        </td></tr>
                        <tr><td style="background-color: #1f2937; padding: 24px 40px; text-align: center;">
                          <p style="color: #9ca3af; font-size: 12px; margin: 0;">Mensaje automático del sistema QEB.</p>
                          <p style="color: #6b7280; font-size: 11px; margin: 8px 0 0 0;">© ${new Date().getFullYear()} QEB OOH Management</p>
                        </td></tr>
                      </table>
                    </td></tr>
                  </table>
                </body></html>`;

                transporter.sendMail({
                  from: process.env.SMTP_FROM || '"QEB Sistema" <no-reply@qeb.mx>',
                  to: usuarioTrafico.correo_electronico,
                  subject: `Ajuste comercial completado: ${nombrePropuesta}`,
                  html: htmlBody,
                }).then(() => {
                  prisma.correos_enviados.create({
                    data: {
                      remitente: 'no-reply@qeb.mx',
                      destinatario: usuarioTrafico.correo_electronico!,
                      asunto: `Ajuste comercial completado: ${nombrePropuesta}`,
                      cuerpo: htmlBody,
                    },
                  }).catch((err: any) => console.error('Error guardando correo ajuste comercial completado:', err));
                }).catch((err: any) => console.error('Error enviando correo ajuste comercial completado:', err));
              }
            }
          }

          // Notificar al creador UNA sola vez al cambiar el status (para Ajuste CTO y Ajuste de Caras)
          if (tarea.tipo !== 'Ajuste Comercial' && propuestaAtendida?.solicitud_id) {
            const solicitudCreador = await prisma.solicitud.findUnique({
              where: { id: propuestaAtendida.solicitud_id },
              select: { usuario_id: true },
            });
            if (solicitudCreador?.usuario_id) {
              const nowNotif = new Date();
              await prisma.tareas.create({
                data: {
                  titulo: `Ajuste completado: ${nombreCampaniaAjuste}`,
                  descripcion: 'Todos los ajustes han sido atendidos. El estado de la propuesta cambió a Atendida.',
                  tipo: 'Notificación',
                  estatus: 'Pendiente',
                  id_responsable: solicitudCreador.usuario_id,
                  responsable: '',
                  id_solicitud: tarea.id_solicitud || '',
                  id_propuesta: tarea.id_propuesta,
                  campania_id: tarea.campania_id,
                  fecha_inicio: nowNotif,
                  fecha_fin: new Date(nowNotif.getTime() + 24 * 60 * 60 * 1000),
                  asignado: req.user?.nombre || 'Usuario',
                  id_asignado: (req.user?.userId || 0).toString(),
                },
              });

              const creador = await prisma.usuario.findUnique({
                where: { id: solicitudCreador.usuario_id },
                select: { nombre: true, correo_electronico: true },
              });
              if (creador?.correo_electronico) {
                const nombrePropuesta = nombreCampaniaAjuste;
                const htmlBody = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
                <body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
                  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f3f4f6; padding: 40px 20px;">
                    <tr><td align="center">
                      <table width="500" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                        <tr><td style="background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); padding: 32px 40px; text-align: center;">
                          <h1 style="color: #ffffff; margin: 0; font-size: 32px; font-weight: 700;">QEB</h1>
                          <p style="color: rgba(255,255,255,0.85); margin: 6px 0 0 0; font-size: 13px; font-weight: 500;">OOH Management</p>
                        </td></tr>
                        <tr><td style="padding: 40px;">
                          <h2 style="color: #1f2937; margin: 0 0 8px 0; font-size: 22px; font-weight: 600;">Ajuste Completado</h2>
                          <p style="color: #6b7280; margin: 0 0 24px 0; font-size: 15px; line-height: 1.5;">
                            Hola <strong style="color: #374151;">${creador.nombre}</strong>, todos los ajustes de la siguiente propuesta han sido atendidos.
                          </p>
                          <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f9fafb; border-radius: 12px; border: 1px solid #e5e7eb; margin-bottom: 24px;">
                            <tr><td style="padding: 20px;">
                              <span style="display: inline-block; background-color: #10b981; color: #ffffff; font-size: 11px; font-weight: 600; padding: 4px 10px; border-radius: 20px; text-transform: uppercase; letter-spacing: 0.5px;">Atendida</span>
                              <h3 style="color: #1f2937; margin: 8px 0; font-size: 18px; font-weight: 600;">${nombrePropuesta}</h3>
                            </td></tr>
                          </table>
                          <table width="100%" cellpadding="0" cellspacing="0">
                            <tr><td align="center">
                              <a href="https://app.qeb.mx/propuestas?viewId=${tarea.id_propuesta}" style="display: inline-block; background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); color: #ffffff; padding: 14px 40px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 15px; box-shadow: 0 4px 14px rgba(139, 92, 246, 0.4);">Ver Propuesta</a>
                            </td></tr>
                          </table>
                        </td></tr>
                        <tr><td style="background-color: #1f2937; padding: 24px 40px; text-align: center;">
                          <p style="color: #9ca3af; font-size: 12px; margin: 0;">Mensaje automático del sistema QEB.</p>
                          <p style="color: #6b7280; font-size: 11px; margin: 8px 0 0 0;">© ${new Date().getFullYear()} QEB OOH Management</p>
                        </td></tr>
                      </table>
                    </td></tr>
                  </table>
                </body></html>`;

                transporter.sendMail({
                  from: process.env.SMTP_FROM || '"QEB Sistema" <no-reply@qeb.mx>',
                  to: creador.correo_electronico,
                  subject: `Ajuste completado: ${nombrePropuesta}`,
                  html: htmlBody,
                }).then(() => {
                  prisma.correos_enviados.create({
                    data: {
                      remitente: 'no-reply@qeb.mx',
                      destinatario: creador.correo_electronico!,
                      asunto: `Ajuste completado: ${nombrePropuesta}`,
                      cuerpo: htmlBody,
                    },
                  }).catch((err: any) => console.error('Error guardando correo ajuste completado:', err));
                }).catch((err: any) => console.error('Error enviando correo ajuste completado:', err));
              }
            }
          }
        }
      }

      // Emitir evento WebSocket para actualizar tareas en tiempo real
      emitToAll(SOCKET_EVENTS.TAREA_ACTUALIZADA, { tareaId: tarea.id });

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
        referencia_tipo: (tarea.tipo?.includes('Autorización') || tarea.tipo?.includes('Rechazo') || tarea.tipo?.includes('Aprobación')) && tarea.contenido && ['solicitud', 'propuesta', 'campana'].includes(tarea.contenido)
          ? tarea.contenido
          : tarea.id_solicitud ? 'solicitud' : tarea.id_propuesta ? 'propuesta' : tarea.campania_id ? 'campana' : null,
        referencia_id: (tarea.tipo?.includes('Autorización') || tarea.tipo?.includes('Rechazo') || tarea.tipo?.includes('Aprobación')) && tarea.contenido === 'campana' ? tarea.campania_id
          : (tarea.tipo?.includes('Autorización') || tarea.tipo?.includes('Rechazo') || tarea.tipo?.includes('Aprobación')) && tarea.contenido === 'propuesta' ? (tarea.id_propuesta ? parseInt(tarea.id_propuesta) : null)
          : tarea.id_solicitud ? parseInt(tarea.id_solicitud) : tarea.id_propuesta ? parseInt(tarea.id_propuesta) : tarea.campania_id,
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
          ...idAsignadoMatch(userId),
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

      // Emitir evento WebSocket para actualizar tareas en tiempo real
      emitToAll(SOCKET_EVENTS.TAREA_ELIMINADA, { tareaId: parseInt(id) });

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
      const userRole = req.user?.rol;

      const where: Record<string, unknown> = {};
      if (userId) {
        const orConditions: Record<string, unknown>[] = [
          { id_responsable: userId },
          ...idAsignadoMatch(userId),
        ];

        // Coordinador de Diseño también ve stats de Diseñadores
        if (userRole === 'Coordinador de Diseño') {
          const disenadores = await prisma.usuario.findMany({
            where: { user_role: 'Diseñadores', deleted_at: null },
            select: { id: true },
          });
          for (const d of disenadores) {
            orConditions.push({ id_responsable: d.id });
            orConditions.push(...idAsignadoMatch(d.id));
          }
        }

        // Gerente Digital (Operaciones) también ve stats de Jefe de Operaciones Digital
        if (userRole === 'Gerente Digital (Operaciones)') {
          const jefesDigital = await prisma.usuario.findMany({
            where: { user_role: 'Jefe de Operaciones Digital', deleted_at: null },
            select: { id: true },
          });
          for (const j of jefesDigital) {
            orConditions.push({ id_responsable: j.id });
            orConditions.push(...idAsignadoMatch(j.id));
          }
        }

        where.OR = orConditions;
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

      // Obtener la tarea para determinar qué tabla de comentarios usar
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

      const GESTION_ARTES_TIPOS = ['Revisión de artes', 'Revision de artes', 'Correccion', 'Corrección', 'Instalación', 'Impresión', 'Testigo', 'Programación', 'Recepción', 'Producción'];
      const isArtReviewTask = GESTION_ARTES_TIPOS.includes(tarea.tipo || '');
      const userName = req.user?.nombre || 'Usuario';

      if (isArtReviewTask) {
        // Para tareas de Revisión de artes / Corrección: insertar en comentarios_revision_artes
        // Obtener nombre del usuario desde la BD
        const [userData] = await prisma.$queryRaw<{ nombre: string }[]>`
          SELECT nombre FROM usuario WHERE id = ${userId}
        `;
        const autorNombre = userData?.nombre || userName;

        await prisma.$executeRaw`
          INSERT INTO comentarios_revision_artes (tarea_id, autor_id, autor_nombre, contenido, fecha)
          VALUES (${tarea.id}, ${userId}, ${autorNombre}, ${contenido.trim()}, NOW())
        `;

        // Obtener el comentario recién insertado
        const [comentario] = await prisma.$queryRaw<{ id: number; tarea_id: number; autor_id: number; autor_nombre: string; contenido: string; fecha: Date }[]>`
          SELECT id, tarea_id, autor_id, autor_nombre, contenido, fecha
          FROM comentarios_revision_artes
          WHERE tarea_id = ${tarea.id}
          ORDER BY id DESC
          LIMIT 1
        `;

        res.status(201).json({
          success: true,
          data: {
            id: comentario.id,
            autor_id: comentario.autor_id,
            autor_nombre: comentario.autor_nombre,
            contenido: comentario.contenido,
            fecha: comentario.fecha,
            tarea_id: comentario.tarea_id,
          },
        });
      } else {
        // Para otras tareas: insertar en tabla comentarios con solicitud_id
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
      }

      // Crear notificaciones para todos los involucrados (excepto el autor)
      const tituloTarea = tarea.titulo || 'Tarea';
      const tituloNotificacion = `Nuevo comentario en tarea: ${tituloTarea}`;
      const descripcionNotificacion = `${userName} comentó: ${contenido.substring(0, 100)}${contenido.length > 100 ? '...' : ''}`;
      const solicitudId = tarea.id_solicitud ? parseInt(tarea.id_solicitud) : 0;

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

      // Emitir evento WebSocket para actualizar tareas en tiempo real
      emitToAll(SOCKET_EVENTS.TAREA_ACTUALIZADA, { tareaId: tarea.id });
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

      // Obtener la tarea para determinar qué tabla de comentarios usar
      const tarea = await prisma.tareas.findUnique({
        where: { id: parseInt(id) },
      });

      if (!tarea) {
        res.json({ success: true, data: [] });
        return;
      }

      const GESTION_ARTES_TIPOS = ['Revisión de artes', 'Revision de artes', 'Correccion', 'Corrección', 'Instalación', 'Impresión', 'Testigo', 'Programación', 'Recepción', 'Producción'];
      const isArtReviewTask = GESTION_ARTES_TIPOS.includes(tarea.tipo || '');

      if (isArtReviewTask) {
        // Para tareas de Revisión de artes / Corrección: usar tabla comentarios_revision_artes
        const rawComentarios = await prisma.$queryRaw<{ id: number; tarea_id: number; autor_id: number; autor_nombre: string; contenido: string; fecha: Date }[]>`
          SELECT id, tarea_id, autor_id, autor_nombre, contenido, fecha
          FROM comentarios_revision_artes
          WHERE tarea_id = ${tarea.id}
          ORDER BY fecha DESC
        `;

        const autorIds = [...new Set(rawComentarios.map(c => c.autor_id))];
        const usuarios = autorIds.length > 0 ? await prisma.usuario.findMany({
          where: { id: { in: autorIds } },
          select: { id: true, foto_perfil: true },
        }) : [];
        const fotoMap = new Map(usuarios.map(u => [u.id, u.foto_perfil]));

        const mappedComentarios = rawComentarios.map(c => ({
          id: c.id,
          autor_id: c.autor_id,
          autor_nombre: c.autor_nombre || 'Usuario',
          autor_foto: fotoMap.get(c.autor_id) || null,
          contenido: c.contenido,
          fecha: c.fecha,
          tarea_id: c.tarea_id,
        }));

        res.json({ success: true, data: mappedComentarios });
        return;
      }

      // Para otras tareas: usar tabla comentarios con solicitud_id
      if (!tarea.id_solicitud) {
        res.json({ success: true, data: [] });
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

      const puestoUpper = (usuario.puesto || '').toUpperCase().trim();
      const tipoUpper = tipo.toUpperCase();

      // Validar permiso: DG puede aprobar DG, DCM puede aprobar DCM
      const esDG = puestoUpper === 'DG' || puestoUpper === 'DIRECTOR GENERAL' || puestoUpper === 'DIRECCIÓN GENERAL' || puestoUpper === 'DIRECCION GENERAL';
      const esDCM = puestoUpper === 'DCM' || puestoUpper === 'DIRECTOR COMERCIAL' || puestoUpper === 'DIRECCIÓN COMERCIAL' || puestoUpper === 'DIRECCION COMERCIAL';
      const tienePermiso = (tipoUpper === 'DG' && esDG) || (tipoUpper === 'DCM' && esDCM);

      if (!tienePermiso) {
        res.status(403).json({
          success: false,
          error: `No tienes permiso para aprobar autorizaciones de ${tipoUpper}`,
        });
        return;
      }

      const result = await aprobarCaras(idquote, tipo, userId || 0, userName);

      // Guardar historial de aprobación
      const propuestaId = parseInt(idquote);
      if (!isNaN(propuestaId)) {
        await prisma.historial.create({
          data: {
            tipo: 'autorizacion_aprobacion',
            ref_id: propuestaId,
            accion: `Aprobación ${tipo.toUpperCase()} por ${userName}`,
            detalles: JSON.stringify({
              tipo: tipo.toUpperCase(),
              carasAprobadas: result.carasAprobadas,
              aprobadoPor: userName,
              userId,
            }),
          },
        });

        emitToAll(SOCKET_EVENTS.AUTORIZACION_APROBADA, { propuestaId, idquote });
      }

      res.json({
        success: true,
        message: `${result.carasAprobadas} circuito(s) aprobado(s) exitosamente`,
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

      const puestoUpper = (usuario.puesto || '').toUpperCase().trim();

      // Determinar el tipo de autorización según el puesto del usuario
      const esDG = puestoUpper === 'DG' || puestoUpper === 'DIRECTOR GENERAL' || puestoUpper === 'DIRECCIÓN GENERAL' || puestoUpper === 'DIRECCION GENERAL';
      const esDCM = puestoUpper === 'DCM' || puestoUpper === 'DIRECTOR COMERCIAL' || puestoUpper === 'DIRECCIÓN COMERCIAL' || puestoUpper === 'DIRECCION COMERCIAL';

      let tipoAutorizacion: 'dg' | 'dcm';
      if (esDG) {
        tipoAutorizacion = 'dg';
      } else if (esDCM) {
        tipoAutorizacion = 'dcm';
      } else {
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

      await rechazarSolicitud(idquote, propuesta.solicitud_id, userId || 0, userName, comentario, tipoAutorizacion);

      // Guardar historial de rechazo
      await prisma.historial.create({
        data: {
          tipo: 'autorizacion_rechazo',
          ref_id: propuestaId,
          accion: `Rechazo ${tipoAutorizacion.toUpperCase()} por ${userName}`,
          detalles: JSON.stringify({
            tipo: tipoAutorizacion.toUpperCase(),
            motivo: comentario,
            rechazadoPor: userName,
            userId,
          }),
        },
      });

      // Emit socket event for real-time updates
      emitToAll(SOCKET_EVENTS.AUTORIZACION_RECHAZADA, { propuestaId, idquote });

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

      // Obtener información de la solicitud (cliente, campaña)
      // idquote puede ser el cuic o el id de la solicitud
      const solicitudId = parseInt(idquote);
      const solicitud = await prisma.solicitud.findFirst({
        where: {
          OR: [
            { cuic: idquote },
            ...(isNaN(solicitudId) ? [] : [{ id: solicitudId }])
          ],
          deleted_at: null
        },
        select: {
          cliente_id: true,
          razon_social: true,
          descripcion: true,
          producto_nombre: true,
        },
      });

      let clienteNombre: string | null = solicitud?.razon_social || null;
      if (solicitud?.cliente_id) {
        const clienteRecord = await prisma.cliente.findFirst({
          where: { CUIC: solicitud.cliente_id },
          select: { T0_U_Cliente: true },
        });
        if (clienteRecord?.T0_U_Cliente) {
          clienteNombre = clienteRecord.T0_U_Cliente;
        }
      }

      const caras = await prisma.solicitudCaras.findMany({
        where: { idquote },
        select: {
          id: true,
          idquote: true,
          ciudad: true,
          estados: true,
          formato: true,
          tipo: true,
          caras: true,
          bonificacion: true,
          costo: true,
          tarifa_publica: true,
          autorizacion_dg: true,
          autorizacion_dcm: true,
          articulo: true,
          inicio_periodo: true,
          fin_periodo: true,
          grupo_rt_bf: true,
        },
      });

      // Get unique inicio_periodo dates and resolve catorcena for each
      const uniquePeriodos = [...new Set(caras.map(c => c.inicio_periodo?.toISOString()).filter(Boolean))] as string[];
      const catorcenaMap = new Map<string, string>();
      for (const periodoStr of uniquePeriodos) {
        const fecha = new Date(periodoStr);
        const catorcena = await prisma.catorcenas.findFirst({
          where: {
            fecha_inicio: { lte: fecha },
            fecha_fin: { gte: fecha },
          },
        });
        if (catorcena) {
          catorcenaMap.set(periodoStr, `Cat ${catorcena.numero_catorcena} - ${catorcena.a_o}`);
        }
      }

      // Calcular tarifa efectiva para cada cara e incluir cliente/campaña/catorcena
      // Build grupo_rt_bf map to find BF pair caras for effective tarifa calculation
      const grupoCarasMap = new Map<number, number>();
      for (const c of caras) {
        if (c.grupo_rt_bf) {
          grupoCarasMap.set(c.grupo_rt_bf, (grupoCarasMap.get(c.grupo_rt_bf) || 0) + (c.caras || 0) + (Number(c.bonificacion) || 0));
        }
      }

      const carasConTarifa = caras.map(cara => {
        const totalCarasLocal = (cara.caras || 0) + (Number(cara.bonificacion) || 0);
        const totalCarasGrupo = cara.grupo_rt_bf ? (grupoCarasMap.get(cara.grupo_rt_bf) || totalCarasLocal) : totalCarasLocal;
        const tarifaEfectiva = totalCarasGrupo > 0 ? (Number(cara.costo) || 0) / totalCarasGrupo : 0;
        const tarifaPublicaReal = (cara.caras || 0) > 0 ? (Number(cara.costo) || 0) / (cara.caras || 1) : Number(cara.tarifa_publica) || 0;
        const catorcenaInfo = cara.inicio_periodo ? catorcenaMap.get(cara.inicio_periodo.toISOString()) || null : null;
        return {
          ...cara,
          total_caras: totalCarasLocal,
          tarifa_efectiva: tarifaEfectiva,
          tarifa_publica: tarifaPublicaReal,
          catorcena: catorcenaInfo,
          cliente: clienteNombre,
          campana: solicitud?.producto_nombre || solicitud?.descripcion || null,
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
  async getHistorialAutorizacion(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { idquote } = req.params;
      const refId = parseInt(idquote);

      if (isNaN(refId)) {
        res.status(400).json({ success: false, error: 'idquote inválido' });
        return;
      }

      const historial = await prisma.historial.findMany({
        where: {
          ref_id: refId,
          tipo: {
            in: [
              'autorizacion_aprobacion',
              'autorizacion_rechazo',
              'autorizacion_cambio_solicitud',
              'autorizacion_cambio_propuesta',
              'autorizacion_cambio_campana',
              'autorizacion_nueva_cara_solicitud',
              'autorizacion_nueva_cara_propuesta',
              'autorizacion_nueva_cara_campana',
              'autorizacion_solicitud_solicitud',
              'autorizacion_solicitud_propuesta',
              'autorizacion_solicitud_campana',
            ],
          },
        },
        orderBy: { fecha_hora: 'asc' },
      });

      const formatted = historial.map(h => ({
        id: Number(h.id),
        tipo: h.tipo,
        accion: h.accion,
        fecha: h.fecha_hora,
        detalles: h.detalles ? JSON.parse(h.detalles) : null,
      }));

      res.json({ success: true, data: formatted });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener historial';
      res.status(500).json({ success: false, error: message });
    }
  }
  async depurarAutorizaciones(req: AuthRequest, res: Response) {
    try {
      const finalizadas = await depurarTareasAutorizacionResueltas();
      res.json({ success: true, data: { finalizadas } });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al depurar autorizaciones';
      res.status(500).json({ success: false, error: message });
    }
  }
}

export const notificacionesController = new NotificacionesController();
