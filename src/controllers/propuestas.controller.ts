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

      // Build WHERE conditions
      let whereConditions = `pr.deleted_at IS NULL AND pr.status <> 'Sin solicitud activa'`;
      const params: any[] = [];

      if (status) {
        whereConditions += ` AND pr.status = ?`;
        params.push(status);
      }

      if (search) {
        whereConditions += ` AND (pr.articulo LIKE ? OR pr.descripcion LIKE ? OR pr.asignado LIKE ? OR cl.T1_U_Cliente LIKE ?)`;
        const searchPattern = `%${search}%`;
        params.push(searchPattern, searchPattern, searchPattern, searchPattern);
      }

      // Get total count
      const countQuery = `
        SELECT COUNT(DISTINCT pr.id) as total
        FROM propuesta pr
        LEFT JOIN solicitud sl ON sl.id = pr.solicitud_id
        LEFT JOIN cliente cl ON cl.id = pr.cliente_id
        WHERE ${whereConditions}
      `;
      const countResult = await prisma.$queryRawUnsafe<[{ total: bigint }]>(countQuery, ...params);
      const total = Number(countResult[0]?.total || 0);

      // Main query inspired by Retool - get propuestas with related data
      const offset = (page - 1) * limit;
      const mainQuery = `
        SELECT
          pr.id,
          pr.cliente_id,
          pr.fecha,
          pr.status,
          pr.descripcion,
          pr.precio,
          pr.notas,
          pr.solicitud_id,
          pr.precio_simulado,
          pr.asignado,
          pr.id_asignado,
          pr.inversion,
          pr.comentario_cambio_status,
          pr.articulo,
          pr.updated_at,
          cm.fecha_inicio,
          cm.fecha_fin,
          cm.nombre AS campana_nombre,
          cl.T1_U_Cliente AS nombre_comercial,
          cl.T0_U_Asesor AS asesor,
          cl.T0_U_Agencia AS agencia,
          cl.T2_U_Marca AS marca,
          cl.T2_U_Producto AS producto,
          cl.CUIC AS cuic,
          sl.nombre_usuario AS creador_nombre,
          sl.archivo AS archivo_solicitud,
          sl.marca_nombre,
          cat_inicio.numero_catorcena AS catorcena_inicio,
          cat_inicio.año AS anio_inicio,
          cat_fin.numero_catorcena AS catorcena_fin,
          cat_fin.año AS anio_fin
        FROM propuesta pr
        LEFT JOIN cotizacion ct ON ct.id_propuesta = pr.id
        LEFT JOIN campania cm ON cm.cotizacion_id = ct.id
        LEFT JOIN cliente cl ON cl.id = pr.cliente_id
        LEFT JOIN solicitud sl ON sl.id = pr.solicitud_id
        LEFT JOIN catorcenas cat_inicio ON cm.fecha_inicio BETWEEN cat_inicio.fecha_inicio AND cat_inicio.fecha_fin
        LEFT JOIN catorcenas cat_fin ON cm.fecha_fin BETWEEN cat_fin.fecha_inicio AND cat_fin.fecha_fin
        WHERE ${whereConditions}
        GROUP BY pr.id
        ORDER BY pr.id DESC
        LIMIT ? OFFSET ?
      `;

      const propuestas = await prisma.$queryRawUnsafe<any[]>(mainQuery, ...params, limit, offset);

      // Convert BigInt values and format dates
      const formattedPropuestas = propuestas.map(p => ({
        ...p,
        id: Number(p.id),
        cliente_id: Number(p.cliente_id),
        solicitud_id: Number(p.solicitud_id),
        precio: p.precio ? Number(p.precio) : null,
        precio_simulado: p.precio_simulado ? Number(p.precio_simulado) : null,
        inversion: p.inversion ? Number(p.inversion) : null,
        cuic: p.cuic ? Number(p.cuic) : null,
        marca_nombre: p.marca_nombre || p.marca || p.articulo,
        creador_nombre: p.creador_nombre || 'Sistema',
        catorcena_inicio: p.catorcena_inicio ? Number(p.catorcena_inicio) : null,
        anio_inicio: p.anio_inicio ? Number(p.anio_inicio) : null,
        catorcena_fin: p.catorcena_fin ? Number(p.catorcena_fin) : null,
        anio_fin: p.anio_fin ? Number(p.anio_fin) : null,
      }));

      res.json({
        success: true,
        data: formattedPropuestas,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      console.error('Error in getAll propuestas:', error);
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
      const userId = req.user?.userId || 0;
      const userName = req.user?.nombre || 'Usuario';
      const propuestaId = parseInt(id);

      // Obtener propuesta antes de actualizar
      const propuestaAnterior = await prisma.propuesta.findUnique({
        where: { id: propuestaId },
      });

      if (!propuestaAnterior) {
        res.status(404).json({ success: false, error: 'Propuesta no encontrada' });
        return;
      }

      const statusAnterior = propuestaAnterior.status;

      const propuesta = await prisma.propuesta.update({
        where: { id: propuestaId },
        data: {
          status,
          comentario_cambio_status: comentario_cambio_status || '',
          updated_at: new Date(),
        },
      });

      // Obtener datos relacionados para la notificación
      const cotizacion = await prisma.cotizacion.findFirst({
        where: { id_propuesta: propuestaId },
      });
      const campania = cotizacion ? await prisma.campania.findFirst({
        where: { cotizacion_id: cotizacion.id },
      }) : null;
      const solicitud = propuesta.solicitud_id
        ? await prisma.solicitud.findUnique({ where: { id: propuesta.solicitud_id } })
        : null;

      // Crear notificaciones para los involucrados
      const nombrePropuesta = cotizacion?.nombre_campania || `Propuesta #${propuestaId}`;
      const tituloNotificacion = `Cambio de estado en propuesta: ${nombrePropuesta}`;
      const descripcionNotificacion = `${userName} cambió el estado de "${statusAnterior}" a "${status}"${comentario_cambio_status ? ` - ${comentario_cambio_status}` : ''}`;

      // Recopilar involucrados (sin duplicados, excluyendo al autor)
      const involucrados = new Set<number>();

      // Agregar usuarios asignados de la propuesta
      if (propuesta.id_asignado) {
        propuesta.id_asignado.split(',').forEach(id => {
          const parsed = parseInt(id.trim());
          if (!isNaN(parsed) && parsed !== userId) {
            involucrados.add(parsed);
          }
        });
      }

      // Agregar creador de la solicitud
      if (solicitud?.usuario_id && solicitud.usuario_id !== userId) {
        involucrados.add(solicitud.usuario_id);
      }

      // Crear notificación para cada involucrado
      const now = new Date();
      const fechaFin = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      for (const responsableId of involucrados) {
        await prisma.tareas.create({
          data: {
            titulo: tituloNotificacion,
            descripcion: descripcionNotificacion,
            tipo: 'Notificación',
            estatus: 'Pendiente',
            id_responsable: responsableId,
            responsable: '',
            id_solicitud: propuesta.solicitud_id?.toString() || '',
            id_propuesta: propuestaId.toString(),
            campania_id: campania?.id || null,
            fecha_inicio: now,
            fecha_fin: fechaFin,
            asignado: userName,
            id_asignado: userId.toString(),
          },
        });
      }

      // Registrar en historial
      await prisma.historial.create({
        data: {
          tipo: 'Propuesta',
          ref_id: propuestaId,
          accion: 'Cambio de estado',
          fecha_hora: now,
          detalles: `${userName} cambió estado de "${statusAnterior}" a "${status}"${comentario_cambio_status ? ` - ${comentario_cambio_status}` : ''}`,
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

  async updateAsignados(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { asignados, id_asignados } = req.body;
      const userId = req.user?.userId || 0;
      const userName = req.user?.nombre || 'Usuario';
      const propuestaId = parseInt(id);

      // Obtener propuesta antes de actualizar para comparar asignados
      const propuestaAnterior = await prisma.propuesta.findUnique({
        where: { id: propuestaId },
      });

      if (!propuestaAnterior) {
        res.status(404).json({ success: false, error: 'Propuesta no encontrada' });
        return;
      }

      const asignadosAnteriores = propuestaAnterior.id_asignado?.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id)) || [];

      const propuesta = await prisma.propuesta.update({
        where: { id: propuestaId },
        data: {
          asignado: asignados,
          id_asignado: id_asignados,
          updated_at: new Date(),
        },
      });

      // Obtener datos relacionados para la notificación
      const cotizacion = await prisma.cotizacion.findFirst({
        where: { id_propuesta: propuestaId },
      });
      const campania = cotizacion ? await prisma.campania.findFirst({
        where: { cotizacion_id: cotizacion.id },
      }) : null;

      const nombrePropuesta = cotizacion?.nombre_campania || `Propuesta #${propuestaId}`;

      // Identificar nuevos asignados (los que no estaban antes)
      const nuevosAsignadosIds = id_asignados?.split(',').map((id: string) => parseInt(id.trim())).filter((id: number) => !isNaN(id)) || [];
      const nuevosAsignados = nuevosAsignadosIds.filter((id: number) => !asignadosAnteriores.includes(id) && id !== userId);

      // Crear notificación para los NUEVOS asignados
      const now = new Date();
      const fechaFin = cotizacion?.fecha_fin || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      for (const responsableId of nuevosAsignados) {
        await prisma.tareas.create({
          data: {
            titulo: `Asignación a propuesta: ${nombrePropuesta}`,
            descripcion: `${userName} te asignó a esta propuesta`,
            tipo: 'Solicitud',
            estatus: 'Pendiente',
            id_responsable: responsableId,
            responsable: '',
            id_solicitud: propuesta.solicitud_id?.toString() || '',
            id_propuesta: propuestaId.toString(),
            campania_id: campania?.id || null,
            fecha_inicio: now,
            fecha_fin: fechaFin,
            asignado: userName,
            id_asignado: userId.toString(),
          },
        });
      }

      // Notificar a los asignados que fueron removidos
      const removidos = asignadosAnteriores.filter(id => !nuevosAsignadosIds.includes(id) && id !== userId);
      for (const responsableId of removidos) {
        await prisma.tareas.create({
          data: {
            titulo: `Removido de propuesta: ${nombrePropuesta}`,
            descripcion: `${userName} te removió de esta propuesta`,
            tipo: 'Notificación',
            estatus: 'Pendiente',
            id_responsable: responsableId,
            responsable: '',
            id_solicitud: propuesta.solicitud_id?.toString() || '',
            id_propuesta: propuestaId.toString(),
            campania_id: campania?.id || null,
            fecha_inicio: now,
            fecha_fin: new Date(now.getTime() + 24 * 60 * 60 * 1000),
            asignado: userName,
            id_asignado: userId.toString(),
          },
        });
      }

      // Registrar en historial
      await prisma.historial.create({
        data: {
          tipo: 'Propuesta',
          ref_id: propuestaId,
          accion: 'Reasignación',
          fecha_hora: now,
          detalles: `${userName} actualizó asignados a: ${asignados}`,
        },
      });

      res.json({
        success: true,
        data: propuesta,
        message: 'Asignados actualizados correctamente',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al actualizar asignados';
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

      const comments = await prisma.historial_comentarios.findMany({
        where: { id_propuesta: parseInt(id) },
        orderBy: { fecha: 'desc' },
      });

      // Get user photos by name (historial_comentarios stores username, not user_id)
      const userNames = [...new Set(comments.map(c => c.usuario).filter(Boolean))];
      const usuarios = userNames.length > 0 ? await prisma.usuario.findMany({
        where: { nombre: { in: userNames as string[] } },
        select: { nombre: true, foto_perfil: true },
      }) : [];
      const usuarioFotoMap = new Map(usuarios.map(u => [u.nombre, u.foto_perfil]));

      const formattedComments = comments.map(c => ({
        id: Number(c.id),
        comentario: c.comentario,
        creado_en: c.fecha,
        autor_nombre: c.usuario || 'Sistema',
        autor_foto: c.usuario ? (usuarioFotoMap.get(c.usuario) || null) : null,
        nuevo_status: c.nuevo_status,
      }));

      res.json({
        success: true,
        data: formattedComments,
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
      const userName = req.user?.nombre || 'Usuario';
      const userId = req.user?.userId || 0;
      const propuestaId = parseInt(id);

      // Obtener la propuesta para conseguir los asignados y solicitud_id
      const propuesta = await prisma.propuesta.findUnique({
        where: { id: propuestaId },
      });

      if (!propuesta) {
        res.status(404).json({ success: false, error: 'Propuesta no encontrada' });
        return;
      }

      const newComment = await prisma.historial_comentarios.create({
        data: {
          id_propuesta: propuestaId,
          comentario,
          usuario: userName,
          fecha: new Date(),
        },
      });

      // Crear notificaciones para todos los involucrados (excepto el autor)
      // Obtener nombre de la cotización/campaña para el título
      const cotizacion = await prisma.cotizacion.findFirst({
        where: { id_propuesta: propuestaId },
      });
      const nombrePropuesta = cotizacion?.nombre_campania || `Propuesta #${propuestaId}`;
      const tituloNotificacion = `Nuevo comentario en propuesta: ${nombrePropuesta}`;
      const descripcionNotificacion = `${userName} comentó: ${comentario.substring(0, 100)}${comentario.length > 100 ? '...' : ''}`;

      // Obtener campaña si existe
      const campania = cotizacion ? await prisma.campania.findFirst({
        where: { cotizacion_id: cotizacion.id },
      }) : null;

      // Obtener solicitud para el creador
      const solicitudData = propuesta.solicitud_id
        ? await prisma.solicitud.findUnique({ where: { id: propuesta.solicitud_id } })
        : null;

      // Recopilar todos los involucrados (sin duplicados, excluyendo al autor)
      const involucrados = new Set<number>();

      // Agregar usuarios asignados de la propuesta
      if (propuesta.id_asignado) {
        propuesta.id_asignado.split(',').forEach(id => {
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
            id_solicitud: propuesta.solicitud_id?.toString() || '',
            id_propuesta: propuestaId.toString(),
            campania_id: campania?.id || null,
            fecha_inicio: now,
            fecha_fin: fechaFin,
            responsable: '',
            asignado: userName,
            id_asignado: userId.toString(),
          },
        });
      }

      res.json({
        success: true,
        data: {
          id: Number(newComment.id),
          comentario: newComment.comentario,
          creado_en: newComment.fecha,
          autor_nombre: userName,
        },
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

  // Get full details for compartir view
  async getFullDetails(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const propuestaId = parseInt(id);

      // Get propuesta
      const propuesta = await prisma.propuesta.findFirst({
        where: { id: propuestaId, deleted_at: null },
      });

      if (!propuesta) {
        res.status(404).json({ success: false, error: 'Propuesta no encontrada' });
        return;
      }

      // Get related data
      const [solicitud, cotizacion, campania, caras] = await Promise.all([
        prisma.solicitud.findUnique({ where: { id: propuesta.solicitud_id } }),
        prisma.cotizacion.findFirst({ where: { id_propuesta: propuestaId } }),
        prisma.campania.findFirst({
          where: {
            cotizacion_id: { in: (await prisma.cotizacion.findMany({ where: { id_propuesta: propuestaId }, select: { id: true } })).map(c => c.id) }
          }
        }),
        prisma.solicitudCaras.findMany({ where: { idquote: String(propuestaId) } }),
      ]);

      res.json({
        success: true,
        data: {
          propuesta,
          solicitud,
          cotizacion,
          campania,
          caras,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener detalles';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Get reserved inventory for propuesta
  async getInventarioReservado(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const propuestaId = parseInt(id);

      const query = `
        SELECT
          GROUP_CONCAT(DISTINCT rsv.id ORDER BY rsv.id SEPARATOR ',') as rsv_ids,
          MIN(i.id) as id,
          CASE
            WHEN rsv.grupo_completo_id IS NOT NULL
            THEN CONCAT(SUBSTRING_INDEX(MIN(i.codigo_unico), '_', 1), '_completo_', SUBSTRING_INDEX(MIN(i.codigo_unico), '_', -1))
            ELSE MIN(i.codigo_unico)
          END as codigo_unico,
          MAX(sc.id) AS solicitud_caras_id,
          MIN(i.mueble) as mueble,
          MIN(i.estado) as estado,
          MIN(i.municipio) as municipio,
          MIN(i.ubicacion) as ubicacion,
          CASE
            WHEN rsv.grupo_completo_id IS NOT NULL THEN 'Completo'
            ELSE MIN(i.tipo_de_cara)
          END as tipo_de_cara,
          CAST(COUNT(DISTINCT rsv.id) AS UNSIGNED) AS caras_totales,
          MIN(i.latitud) as latitud,
          MIN(i.longitud) as longitud,
          MIN(i.plaza) as plaza,
          MAX(rsv.estatus) as estatus_reserva,
          MAX(sc.articulo) as articulo,
          MAX(sc.tipo) as tipo_medio,
          MAX(sc.inicio_periodo) as inicio_periodo,
          MAX(sc.fin_periodo) as fin_periodo,
          MIN(i.tradicional_digital) as tradicional_digital,
          MIN(i.tipo_de_mueble) as tipo_de_mueble,
          MIN(i.ancho) as ancho,
          MIN(i.alto) as alto,
          MIN(i.nivel_socioeconomico) as nivel_socioeconomico,
          COALESCE(MAX(sc.tarifa_publica), MIN(i.tarifa_publica), 0) as tarifa_publica,
          COALESCE(rsv.grupo_completo_id, rsv.id) as grupo_completo_id,
          cat.numero_catorcena,
          cat.año as anio_catorcena
        FROM inventarios i
          INNER JOIN espacio_inventario epIn ON i.id = epIn.inventario_id
          INNER JOIN reservas rsv ON epIn.id = rsv.inventario_id AND rsv.deleted_at IS NULL
          INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
          LEFT JOIN catorcenas cat ON sc.inicio_periodo BETWEEN cat.fecha_inicio AND cat.fecha_fin
        WHERE sc.idquote = ?
        GROUP BY COALESCE(rsv.grupo_completo_id, rsv.id), cat.numero_catorcena, cat.año
        ORDER BY cat.año DESC, cat.numero_catorcena DESC, MIN(rsv.id) DESC
      `;

      const inventario = await prisma.$queryRawUnsafe(query, String(propuestaId)) as any[];

      // Convert BigInts to numbers to avoid serialization errors
      const serializedInventario = inventario.map(item => ({
        ...item,
        caras_totales: Number(item.caras_totales),
      }));

      res.json({
        success: true,
        data: serializedInventario,
      });
    } catch (error) {
      console.error('Error en getInventarioReservado propuesta:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener inventario';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Public endpoint for client view (no auth required)
  async getPublicDetails(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const propuestaId = parseInt(id);

      // Get propuesta
      const propuesta = await prisma.propuesta.findFirst({
        where: { id: propuestaId, deleted_at: null },
      });

      if (!propuesta) {
        res.status(404).json({ success: false, error: 'Propuesta no encontrada' });
        return;
      }

      // Get related data
      const [solicitud, cotizacion, campania, caras] = await Promise.all([
        prisma.solicitud.findUnique({ where: { id: propuesta.solicitud_id } }),
        prisma.cotizacion.findFirst({ where: { id_propuesta: propuestaId } }),
        prisma.campania.findFirst({
          where: {
            cotizacion_id: { in: (await prisma.cotizacion.findMany({ where: { id_propuesta: propuestaId }, select: { id: true } })).map(c => c.id) }
          }
        }),
        prisma.solicitudCaras.findMany({ where: { idquote: String(propuestaId) } }),
      ]);

      // Get cliente name
      let clienteNombre = '';
      if (solicitud?.cliente_id) {
        const cliente = await prisma.cliente.findUnique({ where: { id: solicitud.cliente_id } });
        clienteNombre = cliente?.T0_U_Cliente || '';
      }

      // Get catorcena info from campaign dates
      let catorcenaInicio = null;
      let anioInicio = null;
      let catorcenaFin = null;
      let anioFin = null;

      if (campania) {
        // Get catorcena for fecha_inicio
        const catInicio = await prisma.$queryRaw<any[]>`
          SELECT numero_catorcena, año as anio
          FROM catorcenas
          WHERE ${campania.fecha_inicio} BETWEEN fecha_inicio AND fecha_fin
          LIMIT 1
        `;
        if (catInicio.length > 0) {
          catorcenaInicio = Number(catInicio[0].numero_catorcena);
          anioInicio = Number(catInicio[0].anio);
        }

        // Get catorcena for fecha_fin
        const catFin = await prisma.$queryRaw<any[]>`
          SELECT numero_catorcena, año as anio
          FROM catorcenas
          WHERE ${campania.fecha_fin} BETWEEN fecha_inicio AND fecha_fin
          LIMIT 1
        `;
        if (catFin.length > 0) {
          catorcenaFin = Number(catFin[0].numero_catorcena);
          anioFin = Number(catFin[0].anio);
        }
      }

      // Get inventory
      const inventarioQuery = `
        SELECT
          GROUP_CONCAT(DISTINCT rsv.id ORDER BY rsv.id SEPARATOR ',') as rsv_ids,
          MIN(i.id) as id,
          CASE
            WHEN rsv.grupo_completo_id IS NOT NULL
            THEN CONCAT(SUBSTRING_INDEX(MIN(i.codigo_unico), '_', 1), '_completo_', SUBSTRING_INDEX(MIN(i.codigo_unico), '_', -1))
            ELSE MIN(i.codigo_unico)
          END as codigo_unico,
          MAX(sc.id) AS solicitud_caras_id,
          MIN(i.mueble) as mueble,
          MIN(i.estado) as estado,
          MIN(i.municipio) as municipio,
          MIN(i.ubicacion) as ubicacion,
          CASE
            WHEN rsv.grupo_completo_id IS NOT NULL THEN 'Completo'
            ELSE MIN(i.tipo_de_cara)
          END as tipo_de_cara,
          CAST(COUNT(DISTINCT rsv.id) AS UNSIGNED) AS caras_totales,
          MIN(i.latitud) as latitud,
          MIN(i.longitud) as longitud,
          MIN(i.plaza) as plaza,
          MAX(rsv.estatus) as estatus_reserva,
          MAX(sc.articulo) as articulo,
          MAX(sc.tipo) as tipo_medio,
          MAX(sc.inicio_periodo) as inicio_periodo,
          MAX(sc.fin_periodo) as fin_periodo,
          MIN(i.tradicional_digital) as tradicional_digital,
          MIN(i.tipo_de_mueble) as tipo_de_mueble,
          MIN(i.ancho) as ancho,
          MIN(i.alto) as alto,
          MIN(i.nivel_socioeconomico) as nivel_socioeconomico,
          COALESCE(MAX(sc.tarifa_publica), MIN(i.tarifa_publica), 0) as tarifa_publica,
          COALESCE(rsv.grupo_completo_id, rsv.id) as grupo_completo_id,
          cat.numero_catorcena,
          cat.año as anio_catorcena
        FROM inventarios i
          INNER JOIN espacio_inventario epIn ON i.id = epIn.inventario_id
          INNER JOIN reservas rsv ON epIn.id = rsv.inventario_id AND rsv.deleted_at IS NULL
          INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
          LEFT JOIN catorcenas cat ON sc.inicio_periodo BETWEEN cat.fecha_inicio AND cat.fecha_fin
        WHERE sc.idquote = ?
        GROUP BY COALESCE(rsv.grupo_completo_id, rsv.id), cat.numero_catorcena, cat.año
        ORDER BY cat.año DESC, cat.numero_catorcena DESC, MIN(rsv.id) DESC
      `;

      const inventario = await prisma.$queryRawUnsafe(inventarioQuery, String(propuestaId)) as any[];

      // Convert BigInts to numbers
      const serializedInventario = inventario.map(item => ({
        ...item,
        caras_totales: Number(item.caras_totales),
      }));

      res.json({
        success: true,
        data: {
          propuesta: {
            id: propuesta.id,
            status: propuesta.status,
            descripcion: propuesta.descripcion,
            notas: propuesta.notas,
            fecha: propuesta.fecha,
            catorcena_inicio: catorcenaInicio,
            anio_inicio: anioInicio,
            catorcena_fin: catorcenaFin,
            anio_fin: anioFin,
          },
          solicitud: solicitud ? {
            cuic: solicitud.cuic,
            cliente: clienteNombre,
            razon_social: solicitud.razon_social,
            unidad_negocio: solicitud.unidad_negocio,
            marca_nombre: solicitud.marca_nombre,
            asesor: solicitud.asesor,
            agencia: solicitud.agencia,
            producto_nombre: solicitud.producto_nombre,
            categoria_nombre: solicitud.categoria_nombre,
          } : null,
          cotizacion: cotizacion ? {
            nombre_campania: cotizacion.nombre_campania,
            fecha_inicio: cotizacion.fecha_inicio,
            fecha_fin: cotizacion.fecha_fin,
            numero_caras: cotizacion.numero_caras,
            bonificacion: cotizacion.bonificacion,
            precio: cotizacion.precio,
          } : null,
          campania: campania ? {
            id: campania.id,
            nombre: campania.nombre,
            status: campania.status,
          } : null,
          caras,
          inventario: serializedInventario,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener detalles';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Create reservas for a propuesta
  async createReservas(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const propuestaId = parseInt(id);
      const { reservas, solicitudCaraId, clienteId, fechaInicio, fechaFin, agruparComoCompleto = true } = req.body;

      if (!reservas || !Array.isArray(reservas) || reservas.length === 0) {
        res.status(400).json({ success: false, error: 'No hay reservas para guardar' });
        return;
      }

      // 0. Get all solicitudCaras IDs for duplicate check
      const proposalCaras = await prisma.solicitudCaras.findMany({
        where: { idquote: String(propuestaId) },
        select: { id: true }
      });
      const proposalCaraIds = proposalCaras.map(p => p.id);

      // Verify propuesta exists
      const propuesta = await prisma.propuesta.findFirst({
        where: { id: propuestaId, deleted_at: null },
      });

      if (!propuesta) {
        res.status(404).json({ success: false, error: 'Propuesta no encontrada' });
        return;
      }

      // Create calendario entry
      const calendario = await prisma.calendario.create({
        data: {
          fecha_inicio: new Date(fechaInicio),
          fecha_fin: new Date(fechaFin),
        },
      });

      // Group reservas by whether they are completo (flujo + contraflujo at same location)
      const gruposCompletos: Map<string, number[]> = new Map();
      let reservasNormales: typeof reservas = [];

      // Only group if agruparComoCompleto is enabled
      if (agruparComoCompleto) {
        // First pass: identify grupos completos by location
        const locationMap: Map<string, typeof reservas> = new Map();
        for (const reserva of reservas) {
          const locationKey = `${reserva.latitud}-${reserva.longitud}`;
          if (!locationMap.has(locationKey)) {
            locationMap.set(locationKey, []);
          }
          locationMap.get(locationKey)!.push(reserva);
        }

        // Get max grupo_completo_id from database to avoid collisions
        const maxGrupoResult = await prisma.$queryRaw<[{ max_grupo: number | null }]>`
          SELECT MAX(grupo_completo_id) as max_grupo FROM reservas WHERE grupo_completo_id IS NOT NULL
        `;
        let nextGrupoCompletoId = (maxGrupoResult[0]?.max_grupo || 0) + 1;

        // Second pass: determine if location has both flujo and contraflujo
        for (const [locationKey, locationReservas] of locationMap) {
          const hasFlujo = locationReservas.some(r => r.tipo === 'Flujo');
          const hasContraflujo = locationReservas.some(r => r.tipo === 'Contraflujo');

          if (hasFlujo && hasContraflujo) {
            // This is a grupo completo - use sequential ID
            const grupoId = nextGrupoCompletoId++;
            for (const reserva of locationReservas) {
              if (reserva.tipo === 'Flujo' || reserva.tipo === 'Contraflujo') {
                if (!gruposCompletos.has(String(grupoId))) {
                  gruposCompletos.set(String(grupoId), []);
                }
                gruposCompletos.get(String(grupoId))!.push(reserva.inventario_id);
              }
            }
          } else {
            reservasNormales.push(...locationReservas);
          }
        }
      } else {
        // No grouping - all reservas are treated as normal
        reservasNormales = [...reservas];
      }

      // Get espacio_inventario ids for the inventario_ids
      const inventarioIds = reservas.map(r => r.inventario_id);
      const espacios = await prisma.espacio_inventario.findMany({
        where: { inventario_id: { in: inventarioIds } },
      });
      const inventarioToEspacio = new Map<number, number>();
      for (const esp of espacios) {
        inventarioToEspacio.set(esp.inventario_id, esp.id);
      }

      // Create reservas
      const createdReservas = [];

      // Process grupos completos first
      for (const [grupoId, invIds] of gruposCompletos) {
        for (const invId of invIds) {
          const reserva = reservas.find(r => r.inventario_id === invId);
          if (!reserva) continue;

          const espacioId = inventarioToEspacio.get(invId);
          if (!espacioId) {
            console.warn(`No espacio_inventario found for inventario_id ${invId}`);
            continue;
          }

          const estatus = reserva.tipo === 'Bonificacion' ? 'Bonificado' : 'Reservado';

          const exists = await prisma.reservas.findFirst({
            where: {
              inventario_id: espacioId,
              solicitudCaras_id: { in: proposalCaraIds },
              deleted_at: null
            }
          });

          if (exists) {
            continue;
          }

          const created = await prisma.reservas.create({
            data: {
              inventario_id: espacioId,
              calendario_id: calendario.id,
              cliente_id: clienteId,
              solicitudCaras_id: solicitudCaraId,
              estatus,
              estatus_original: estatus,
              arte_aprobado: 'Pendiente',
              comentario_rechazo: '',
              fecha_testigo: new Date(),
              imagen_testigo: '',
              instalado: false,
              tarea: '',
              grupo_completo_id: parseInt(grupoId),
            },
          });
          createdReservas.push(created);
        }
      }

      // Process normal reservas
      for (const reserva of reservasNormales) {
        const espacioId = inventarioToEspacio.get(reserva.inventario_id);
        if (!espacioId) {
          console.warn(`No espacio_inventario found for inventario_id ${reserva.inventario_id}`);
          continue;
        }

        const estatus = reserva.tipo === 'Bonificacion' ? 'Bonificado' : 'Reservado';

        const exists = await prisma.reservas.findFirst({
          where: {
            inventario_id: espacioId,
            solicitudCaras_id: { in: proposalCaraIds },
            deleted_at: null
          }
        });

        if (exists) {
          continue;
        }

        const created = await prisma.reservas.create({
          data: {
            inventario_id: espacioId,
            calendario_id: calendario.id,
            cliente_id: clienteId,
            solicitudCaras_id: solicitudCaraId,
            estatus,
            estatus_original: estatus,
            arte_aprobado: 'Pendiente',
            comentario_rechazo: '',
            fecha_testigo: new Date(),
            imagen_testigo: '',
            instalado: false,
            tarea: '',
            grupo_completo_id: null,
          },
        });
        createdReservas.push(created);
      }

      // Update solicitudCaras totals if needed
      await this.updateSolicitudCarasTotals(solicitudCaraId);

      // Crear notificaciones para usuarios asignados a la propuesta
      const userId = req.user?.userId;
      const userName = req.user?.nombre || 'Usuario';

      if (propuesta.id_asignado && createdReservas.length > 0) {
        const involucrados = new Set<number>();
        propuesta.id_asignado.split(',').forEach(idStr => {
          const parsed = parseInt(idStr.trim());
          if (!isNaN(parsed) && parsed !== userId) {
            involucrados.add(parsed);
          }
        });

        const now = new Date();
        for (const responsableId of involucrados) {
          await prisma.tareas.create({
            data: {
              titulo: 'Nuevas reservas creadas',
              descripcion: `${userName} ha creado ${createdReservas.length} reserva(s) en la propuesta`,
              tipo: 'Notificación',
              estatus: 'Pendiente',
              id_responsable: responsableId,
              asignado: userName,
              id_asignado: userId?.toString() || '',
              id_solicitud: propuesta.solicitud_id?.toString() || '',
              id_propuesta: propuesta.id.toString(),
              fecha_inicio: now,
              fecha_fin: now,
            },
          });
        }
      }

      res.json({
        success: true,
        data: {
          calendarioId: calendario.id,
          reservasCreadas: createdReservas.length,
        },
      });
    } catch (error) {
      console.error('Error creating reservas:', error);
      const message = error instanceof Error ? error.message : 'Error al crear reservas';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Helper to update solicitudCaras totals after reservas
  private async updateSolicitudCarasTotals(solicitudCaraId: number): Promise<void> {
    try {
      // Count reservas for this solicitudCara
      const reservasCount = await prisma.reservas.count({
        where: {
          solicitudCaras_id: solicitudCaraId,
          deleted_at: null,
        },
      });

      const bonificadasCount = await prisma.reservas.count({
        where: {
          solicitudCaras_id: solicitudCaraId,
          deleted_at: null,
          estatus: 'Bonificado',
        },
      });

      // Update solicitudCaras with new counts
      await prisma.solicitudCaras.update({
        where: { id: solicitudCaraId },
        data: {
          // These fields might need adjustment based on actual schema
        },
      });
    } catch (error) {
      console.error('Error updating solicitudCaras totals:', error);
    }
  }

  // Get reservas for modal (individual, not grouped)
  async getReservasForModal(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const propuestaId = parseInt(id);

      const query = `
        SELECT
          rsv.id as reserva_id,
          rsv.inventario_id as espacio_id,
          i.id as inventario_id,
          i.codigo_unico,
          i.tipo_de_cara,
          i.latitud,
          i.longitud,
          i.plaza,
          i.tipo_de_mueble as formato,
          i.ubicacion,
          rsv.estatus,
          rsv.grupo_completo_id,
          sc.id as solicitud_cara_id
        FROM reservas rsv
          INNER JOIN espacio_inventario epIn ON rsv.inventario_id = epIn.id
          INNER JOIN inventarios i ON epIn.inventario_id = i.id
          INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
        WHERE sc.idquote = ?
          AND rsv.deleted_at IS NULL
        ORDER BY rsv.id DESC
      `;

      const reservas = await prisma.$queryRawUnsafe(query, String(propuestaId));

      res.json({
        success: true,
        data: reservas,
      });
    } catch (error) {
      console.error('Error en getReservasForModal:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener reservas';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Delete reservas
  async deleteReservas(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { reservaIds } = req.body;
      const userId = req.user?.userId;
      const userName = req.user?.nombre || 'Usuario';

      if (!reservaIds || !Array.isArray(reservaIds) || reservaIds.length === 0) {
        res.status(400).json({ success: false, error: 'No hay reservas para eliminar' });
        return;
      }

      // Obtener propuesta para notificar a usuarios asignados
      const propuestaId = id ? parseInt(id) : null;
      const propuesta = propuestaId ? await prisma.propuesta.findFirst({
        where: { id: propuestaId, deleted_at: null },
      }) : null;

      // Soft delete reservas
      await prisma.reservas.updateMany({
        where: { id: { in: reservaIds } },
        data: { deleted_at: new Date() },
      });

      // Crear notificaciones para usuarios asignados
      if (propuesta?.id_asignado) {
        const involucrados = new Set<number>();
        propuesta.id_asignado.split(',').forEach(idStr => {
          const parsed = parseInt(idStr.trim());
          if (!isNaN(parsed) && parsed !== userId) {
            involucrados.add(parsed);
          }
        });

        const now = new Date();
        for (const responsableId of involucrados) {
          await prisma.tareas.create({
            data: {
              titulo: 'Reservas eliminadas',
              descripcion: `${userName} ha eliminado ${reservaIds.length} reserva(s) de la propuesta`,
              tipo: 'Notificación',
              estatus: 'Pendiente',
              id_responsable: responsableId,
              asignado: userName,
              id_asignado: userId?.toString() || '',
              id_solicitud: propuesta.solicitud_id?.toString() || '',
              id_propuesta: propuesta.id.toString(),
              fecha_inicio: now,
              fecha_fin: now,
            },
          });
        }
      }

      res.json({
        success: true,
        message: `${reservaIds.length} reservas eliminadas`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al eliminar reservas';
      res.status(500).json({ success: false, error: message });
    }
  }


  // Toggle reserva (Immediate Save)
  async toggleReserva(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const propuestaId = parseInt(id);
      const { inventarioId, solicitudCaraId, clienteId, tipo, fechaInicio, fechaFin } = req.body;
      const userId = req.user?.userId;
      const userName = req.user?.nombre || 'Usuario';

      // 0. Get all solicitudCaras IDs for duplicates check
      const proposalCaras = await prisma.solicitudCaras.findMany({
        where: { idquote: String(propuestaId) },
        select: { id: true }
      });
      const proposalCaraIds = proposalCaras.map(p => p.id);

      // 1. Check if ANY active reservation exists for this inventory in this proposal
      const existingReserva = await prisma.reservas.findFirst({
        where: {
          inventario_id: parseInt(inventarioId),
          solicitudCaras_id: { in: proposalCaraIds },
          deleted_at: null
        }
      });

      if (existingReserva) {
        // DELETE (Soft delete)
        await prisma.reservas.update({
          where: { id: existingReserva.id },
          data: { deleted_at: new Date() }
        });

        // Also delete if it's part of a group group_completo_id
        if (existingReserva.grupo_completo_id) {
          await prisma.reservas.updateMany({
            where: {
              grupo_completo_id: existingReserva.grupo_completo_id,
              id: { not: existingReserva.id }
            },
            data: { deleted_at: new Date() }
          });
        }

        // Notificar sobre eliminación de reserva
        const propuestaForDelete = await prisma.propuesta.findFirst({
          where: { id: propuestaId, deleted_at: null },
        });

        if (propuestaForDelete?.id_asignado) {
          const involucrados = new Set<number>();
          propuestaForDelete.id_asignado.split(',').forEach(idStr => {
            const parsed = parseInt(idStr.trim());
            if (!isNaN(parsed) && parsed !== userId) {
              involucrados.add(parsed);
            }
          });

          const now = new Date();
          for (const responsableId of involucrados) {
            await prisma.tareas.create({
              data: {
                titulo: 'Reserva eliminada',
                descripcion: `${userName} ha eliminado una reserva de la propuesta`,
                tipo: 'Notificación',
                estatus: 'Pendiente',
                id_responsable: responsableId,
                asignado: userName,
                id_asignado: userId?.toString() || '',
                id_solicitud: propuestaForDelete.solicitud_id?.toString() || '',
                id_propuesta: propuestaForDelete.id.toString(),
                fecha_inicio: now,
                fecha_fin: now,
              },
            });
          }
        }

        res.json({
          success: true,
          data: {
            action: 'deleted',
          },
          message: 'Reserva eliminada'
        });
        return;
      }

      // CREATE
      const propuesta = await prisma.propuesta.findFirst({
        where: { id: propuestaId, deleted_at: null },
      });

      if (!propuesta) {
        res.status(404).json({ success: false, error: 'Propuesta no encontrada' });
        return;
      }

      let calendario = await prisma.calendario.findFirst({
        where: {
          fecha_inicio: new Date(fechaInicio),
          fecha_fin: new Date(fechaFin),
          deleted_at: null
        }
      });

      if (!calendario) {
        calendario = await prisma.calendario.create({
          data: {
            fecha_inicio: new Date(fechaInicio),
            fecha_fin: new Date(fechaFin),
          },
        });
      }

      const espacio = await prisma.espacio_inventario.findFirst({
        where: { inventario_id: parseInt(inventarioId) }
      });

      if (!espacio) {
        res.status(400).json({ success: false, error: 'Espacio de inventario no encontrado' });
        return;
      }

      const estatus = tipo === 'Bonificacion' ? 'Bonificado' : 'Reservado';

      const newReserva = await prisma.reservas.create({
        data: {
          inventario_id: espacio.id,
          calendario_id: calendario.id,
          cliente_id: clienteId,
          solicitudCaras_id: solicitudCaraId,
          estatus,
          estatus_original: estatus,
          arte_aprobado: 'Pendiente',
          comentario_rechazo: '',
          fecha_testigo: new Date(),
          imagen_testigo: '',
          instalado: false,
          tarea: '',
          grupo_completo_id: null,
        },
      });

      // Simple implementation for "completo" logic if needed immediately:
      // If user selected a "Completo" item in frontend, frontend sends one request.
      // But if it's "Flujo" and has a "Contraflujo" pair at same location... we might need to handle that.
      // For now, let's stick to 1:1 unless we see the frontend sending special flags.

      // Notificar sobre creación de reserva
      if (propuesta?.id_asignado) {
        const involucrados = new Set<number>();
        propuesta.id_asignado.split(',').forEach(idStr => {
          const parsed = parseInt(idStr.trim());
          if (!isNaN(parsed) && parsed !== userId) {
            involucrados.add(parsed);
          }
        });

        const now = new Date();
        for (const responsableId of involucrados) {
          await prisma.tareas.create({
            data: {
              titulo: 'Nueva reserva creada',
              descripcion: `${userName} ha creado una reserva en la propuesta`,
              tipo: 'Notificación',
              estatus: 'Pendiente',
              id_responsable: responsableId,
              asignado: userName,
              id_asignado: userId?.toString() || '',
              id_solicitud: propuesta.solicitud_id?.toString() || '',
              id_propuesta: propuesta.id.toString(),
              fecha_inicio: now,
              fecha_fin: now,
            },
          });
        }
      }

      res.json({
        success: true,
        data: {
          action: 'created',
          reserva: {
            ...newReserva,
            inventario_id: inventarioId // Return original intentario ID for frontend mapping
          }
        }
      });

    } catch (error) {
      console.error('Error toggling reserva:', error);
      const message = error instanceof Error ? error.message : 'Error al cambiar reserva';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Update propuesta general fields
  async updatePropuesta(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { nombre_campania, notas, descripcion, year_inicio, catorcena_inicio, year_fin, catorcena_fin } = req.body;

      // Update propuesta fields
      const updatedPropuesta = await prisma.propuesta.update({
        where: { id: parseInt(id) },
        data: {
          notas: notas !== undefined ? notas : undefined,
          descripcion: descripcion !== undefined ? descripcion : undefined,
          updated_at: new Date(),
        },
      });

      // Update cotizacion nombre_campania if provided
      if (nombre_campania !== undefined) {
        await prisma.cotizacion.updateMany({
          where: { id_propuesta: parseInt(id) },
          data: { nombre_campania },
        });
      }

      // Update campania dates if provided
      if (year_inicio !== undefined || catorcena_inicio !== undefined || year_fin !== undefined || catorcena_fin !== undefined) {
        // Find the cotizacion and campania
        const cotizacion = await prisma.cotizacion.findFirst({
          where: { id_propuesta: parseInt(id) },
        });

        if (cotizacion) {
          // Calculate new dates from catorcenas if provided
          let fechaInicio: Date | undefined;
          let fechaFin: Date | undefined;

          if (year_inicio && catorcena_inicio) {
            const catInicio = await prisma.catorcenas.findFirst({
              where: { a_o: year_inicio, numero_catorcena: catorcena_inicio },
            });
            if (catInicio) {
              fechaInicio = catInicio.fecha_inicio;
            }
          }

          if (year_fin && catorcena_fin) {
            const catFin = await prisma.catorcenas.findFirst({
              where: { a_o: year_fin, numero_catorcena: catorcena_fin },
            });
            if (catFin) {
              fechaFin = catFin.fecha_fin;
            }
          }

          if (fechaInicio || fechaFin) {
            await prisma.campania.updateMany({
              where: { cotizacion_id: cotizacion.id },
              data: {
                ...(fechaInicio && { fecha_inicio: fechaInicio }),
                ...(fechaFin && { fecha_fin: fechaFin }),
              },
            });
          }
        }
      }

      res.json({ success: true, data: updatedPropuesta });
    } catch (error) {
      console.error('Error updating propuesta:', error);
      const message = error instanceof Error ? error.message : 'Error al actualizar propuesta';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Upload archivo for propuesta
  async uploadArchivo(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      // For now, we'll handle file upload in a simple way
      // In production, you'd want to use multer or similar
      if (!req.files || !('archivo' in req.files)) {
        res.status(400).json({ success: false, error: 'No se proporcionó archivo' });
        return;
      }

      const file = (req.files as any).archivo;
      const fileName = `propuesta_${id}_${Date.now()}_${file.name}`;
      const uploadPath = `./uploads/${fileName}`;

      // Move file to uploads directory
      await file.mv(uploadPath);

      // Update propuesta with file URL
      // Note: propuesta model doesn't have 'archivo' field, only update timestamp
      await prisma.propuesta.update({
        where: { id: parseInt(id) },
        data: {
          updated_at: new Date(),
        },
      });

      res.json({ success: true, data: { url: `/uploads/${fileName}` } });
    } catch (error) {
      console.error('Error uploading archivo:', error);
      const message = error instanceof Error ? error.message : 'Error al subir archivo';
      res.status(500).json({ success: false, error: message });
    }
  }
}

export const propuestasController = new PropuestasController();
