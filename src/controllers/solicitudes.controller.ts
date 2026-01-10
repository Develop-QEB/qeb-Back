import { Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';

// Helper function to serialize BigInt values to numbers
function serializeBigInt<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj, (_, value) =>
    typeof value === 'bigint' ? Number(value) : value
  ));
}

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

      // Get related propuesta
      const propuesta = await prisma.propuesta.findFirst({
        where: { solicitud_id: solicitud.id, deleted_at: null },
      });

      // Get related cotizacion
      const cotizacion = propuesta ? await prisma.cotizacion.findFirst({
        where: { id_propuesta: propuesta.id },
      }) : null;

      // Get related campania
      const campania = cotizacion ? await prisma.campania.findFirst({
        where: { cotizacion_id: cotizacion.id },
      }) : null;

      // Get solicitudCaras by propuesta id (idquote)
      const caras = propuesta ? await prisma.solicitudCaras.findMany({
        where: { idquote: propuesta.id.toString() },
      }) : [];

      // Get comentarios
      const comentarios = await prisma.comentarios.findMany({
        where: { solicitud_id: solicitud.id },
        orderBy: { creado_en: 'desc' },
      });

      // Get autor names and photos for comentarios
      const autorIds = [...new Set(comentarios.map(c => c.autor_id))].filter(id => id != null);
      const autores = autorIds.length > 0 ? await prisma.usuario.findMany({
        where: { id: { in: autorIds } },
        select: { id: true, nombre: true, foto_perfil: true },
      }) : [];
      const autoresMap = new Map(autores.map(a => [a.id, { nombre: a.nombre, foto_perfil: a.foto_perfil }]));

      const comentariosWithAuthor = comentarios.map(c => ({
        ...c,
        autor_nombre: c.autor_id ? (autoresMap.get(c.autor_id)?.nombre || 'Usuario desconocido') : 'Sistema',
        autor_foto: c.autor_id ? (autoresMap.get(c.autor_id)?.foto_perfil || null) : null,
      }));

      // Get historial
      const historial = await prisma.historial.findMany({
        where: { ref_id: solicitud.id, tipo: 'Solicitud' },
        orderBy: { fecha_hora: 'desc' },
      });

      res.json(serializeBigInt({
        success: true,
        data: {
          solicitud,
          propuesta,
          cotizacion,
          campania,
          caras,
          comentarios: comentariosWithAuthor,
          historial,
        },
      }));
    } catch (error) {
      console.error('Error in getById:', error);
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
      const userId = req.user?.userId;
      // Get user name from database if not in token
      let userName = req.user?.nombre;
      if (!userName && userId) {
        const user = await prisma.usuario.findUnique({ where: { id: userId }, select: { nombre: true } });
        userName = user?.nombre || 'Usuario';
      }
      userName = userName || 'Usuario';

      // Obtener solicitud antes de actualizar
      const solicitudAnterior = await prisma.solicitud.findUnique({
        where: { id: parseInt(id) },
      });

      if (!solicitudAnterior) {
        res.status(404).json({ success: false, error: 'Solicitud no encontrada' });
        return;
      }

      const statusAnterior = solicitudAnterior.status;

      const solicitud = await prisma.solicitud.update({
        where: { id: parseInt(id) },
        data: { status },
      });

      // Crear notificaciones para los involucrados
      const nombreSolicitud = solicitud.razon_social || solicitud.marca_nombre || 'Sin nombre';
      const tituloNotificacion = `Cambio de estado en solicitud #${solicitud.id}`;
      const descripcionNotificacion = `${userName} cambió el estado de "${statusAnterior}" a "${status}" - ${nombreSolicitud}`;

      // Obtener propuesta y campaña relacionadas
      const propuesta = await prisma.propuesta.findFirst({
        where: { solicitud_id: solicitud.id, deleted_at: null },
      });
      const cotizacion = propuesta ? await prisma.cotizacion.findFirst({
        where: { id_propuesta: propuesta.id },
      }) : null;
      const campania = cotizacion ? await prisma.campania.findFirst({
        where: { cotizacion_id: cotizacion.id },
      }) : null;

      // Recopilar involucrados (sin duplicados, excluyendo al autor)
      const involucrados = new Set<number>();

      // Agregar usuarios asignados
      if (solicitud.id_asignado) {
        solicitud.id_asignado.split(',').forEach(id => {
          const parsed = parseInt(id.trim());
          if (!isNaN(parsed) && parsed !== userId) {
            involucrados.add(parsed);
          }
        });
      }

      // Agregar creador de la solicitud
      if (solicitud.usuario_id && solicitud.usuario_id !== userId) {
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
            id_solicitud: solicitud.id.toString(),
            id_propuesta: propuesta?.id?.toString() || '',
            campania_id: campania?.id || null,
            fecha_inicio: now,
            fecha_fin: fechaFin,
            asignado: userName,
            id_asignado: userId?.toString() || '',
          },
        });
      }

      // Registrar en historial
      await prisma.historial.create({
        data: {
          tipo: 'Solicitud',
          ref_id: solicitud.id,
          accion: 'Cambio de estado',
          fecha_hora: now,
          detalles: `${userName} cambió estado de "${statusAnterior}" a "${status}"`,
        },
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
      const userId = req.user?.userId;
      // Get user name from database if not in token
      let userName = req.user?.nombre;
      if (!userName && userId) {
        const user = await prisma.usuario.findUnique({ where: { id: userId }, select: { nombre: true } });
        userName = user?.nombre || 'Usuario';
      }
      userName = userName || 'Usuario';

      // Obtener la solicitud antes de eliminar
      const solicitud = await prisma.solicitud.findFirst({
        where: { id: parseInt(id), deleted_at: null },
      });

      if (!solicitud) {
        res.status(404).json({ success: false, error: 'Solicitud no encontrada' });
        return;
      }

      await prisma.solicitud.update({
        where: { id: parseInt(id) },
        data: { deleted_at: new Date() },
      });

      // Crear notificaciones para usuarios involucrados
      const involucrados = new Set<number>();

      if (solicitud.usuario_id && solicitud.usuario_id !== userId) {
        involucrados.add(solicitud.usuario_id);
      }

      if (solicitud.id_asignado) {
        solicitud.id_asignado.split(',').forEach(idStr => {
          const parsed = parseInt(idStr.trim());
          if (!isNaN(parsed) && parsed !== userId) {
            involucrados.add(parsed);
          }
        });
      }

      const now = new Date();
      for (const responsableId of involucrados) {
        await prisma.tareas.create({
          data: {
            titulo: 'Solicitud eliminada',
            descripcion: `La solicitud "${solicitud.descripcion || solicitud.id}" ha sido eliminada por ${userName}`,
            tipo: 'Notificación',
            estatus: 'Pendiente',
            id_responsable: responsableId,
            asignado: userName,
            id_asignado: userId?.toString() || '',
            id_solicitud: solicitud.id.toString(),
            fecha_inicio: now,
            fecha_fin: now,
          },
        });
      }

      // Registrar en historial
      await prisma.historial.create({
        data: {
          tipo: 'Solicitud',
          ref_id: solicitud.id,
          accion: 'Eliminación',
          fecha_hora: now,
          detalles: `Solicitud eliminada por ${userName}`,
        },
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

  async getUsers(req: AuthRequest, res: Response): Promise<void> {
    try {
      const area = req.query.area as string;

      const where: Record<string, unknown> = {
        deleted_at: null,
      };

      if (area) {
        where.area = area;
      }

      const users = await prisma.usuario.findMany({
        where,
        select: {
          id: true,
          nombre: true,
          area: true,
          puesto: true,
        },
        orderBy: { nombre: 'asc' },
      });

      res.json({
        success: true,
        data: users,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener usuarios';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getInventarioFilters(req: AuthRequest, res: Response): Promise<void> {
    try {
      // Get distinct estados
      const estados = await prisma.inventarios.findMany({
        select: { estado: true },
        distinct: ['estado'],
        where: { estado: { not: null } },
        orderBy: { estado: 'asc' },
      });

      // Get distinct municipios (ciudades)
      const ciudades = await prisma.inventarios.findMany({
        select: { municipio: true, estado: true },
        distinct: ['municipio'],
        where: { municipio: { not: null } },
        orderBy: { municipio: 'asc' },
      });

      // Get distinct tipo_de_mueble (formatos)
      const formatos = await prisma.inventarios.findMany({
        select: { tipo_de_mueble: true },
        distinct: ['tipo_de_mueble'],
        where: { tipo_de_mueble: { not: null } },
        orderBy: { tipo_de_mueble: 'asc' },
      });

      // Get distinct nivel_socioeconomico
      const nse = await prisma.inventarios.findMany({
        select: { nivel_socioeconomico: true },
        distinct: ['nivel_socioeconomico'],
        where: { nivel_socioeconomico: { not: null } },
        orderBy: { nivel_socioeconomico: 'asc' },
      });

      res.json({
        success: true,
        data: {
          estados: estados.map(e => e.estado).filter(Boolean),
          ciudades: ciudades.map(c => ({ ciudad: c.municipio, estado: c.estado })),
          formatos: formatos.map(f => f.tipo_de_mueble).filter(Boolean),
          nse: nse.map(n => n.nivel_socioeconomico).filter(Boolean),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener filtros de inventario';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getFormatosByCiudades(req: AuthRequest, res: Response): Promise<void> {
    try {
      const ciudades = req.query.ciudades as string;

      if (!ciudades) {
        res.json({ success: true, data: [] });
        return;
      }

      const ciudadesArray = ciudades.split(',').map(c => c.trim());

      const formatos = await prisma.inventarios.findMany({
        select: { tipo_de_mueble: true },
        distinct: ['tipo_de_mueble'],
        where: {
          municipio: { in: ciudadesArray },
          tipo_de_mueble: { not: null },
        },
        orderBy: { tipo_de_mueble: 'asc' },
      });

      res.json({
        success: true,
        data: formatos.map(f => f.tipo_de_mueble).filter(Boolean),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener formatos';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getNextId(req: AuthRequest, res: Response): Promise<void> {
    try {
      // Get max ID from solicitud, propuesta, cotizacion, campania tables
      const result = await prisma.$queryRaw<{ proximo_id: bigint }[]>`
        SELECT COALESCE(
          GREATEST(
            (SELECT COALESCE(MAX(id), 0) FROM solicitud),
            (SELECT COALESCE(MAX(id), 0) FROM propuesta),
            (SELECT COALESCE(MAX(id), 0) FROM cotizacion),
            (SELECT COALESCE(MAX(id), 0) FROM campania)
          ) + 1,
          1
        ) AS proximo_id
      `;

      const nextId = result[0]?.proximo_id ? Number(result[0].proximo_id) : 1;

      res.json({
        success: true,
        data: { nextId },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener próximo ID';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      const {
        // Client data
        cliente_id,
        cuic,
        razon_social,
        unidad_negocio,
        marca_id,
        marca_nombre,
        asesor,
        producto_id,
        producto_nombre,
        agencia,
        categoria_id,
        categoria_nombre,
        card_code, // SAP CardCode (ACA_U_SAPCode)
        // Campaign data
        nombre_campania,
        descripcion,
        notas,
        presupuesto,
        // Articulo
        articulo,
        // Asignados (array of user IDs and names)
        asignados,
        // Date range
        fecha_inicio,
        fecha_fin,
        // File
        archivo,
        tipo_archivo,
        // IMU
        IMU,
        // Caras data (array)
        caras,
      } = req.body;

      const userId = req.user?.userId;
      // Get user name from database if not in token
      let userName = req.user?.nombre;
      if (!userName && userId) {
        const user = await prisma.usuario.findUnique({ where: { id: userId }, select: { nombre: true } });
        userName = user?.nombre || 'Usuario';
      }
      userName = userName || 'Usuario';

      // Calculate totals from caras
      const totalCaras = caras.reduce((acc: number, c: { caras: number; bonificacion: number }) => acc + c.caras + (c.bonificacion || 0), 0);
      const totalBonificacion = caras.reduce((acc: number, c: { bonificacion: number }) => acc + (c.bonificacion || 0), 0);
      const totalInversion = caras.reduce((acc: number, c: { costo: number }) => acc + c.costo, 0);

      // Format asignados string
      const asignadosStr = asignados.map((a: { nombre: string }) => a.nombre).join(', ');
      const asignadosIds = asignados.map((a: { id: number }) => a.id).join(',');

      // Use transaction for complex creation with extended timeout
      const result = await prisma.$transaction(async (tx) => {
        // 1. Create solicitud
        const solicitud = await tx.solicitud.create({
          data: {
            fecha: new Date(),
            descripcion,
            presupuesto: presupuesto || totalInversion,
            notas: notas || '',
            cliente_id,
            usuario_id: userId,
            status: 'Pendiente',
            nombre_usuario: userName,
            asignado: asignadosStr,
            id_asignado: asignadosIds,
            cuic: cuic?.toString(),
            razon_social,
            unidad_negocio,
            marca_id,
            marca_nombre,
            asesor,
            producto_id,
            producto_nombre,
            agencia,
            categoria_id,
            categoria_nombre,
            IMU: IMU ? 1 : 0,
            archivo,
            tipo_archivo,
            card_code: card_code || null,
          },
        });

        // 2. Create historial
        await tx.historial.create({
          data: {
            tipo: 'Solicitud',
            ref_id: solicitud.id,
            accion: 'Creacion',
            fecha_hora: new Date(),
            detalles: `Solicitud creada por ${userName}`,
          },
        });

        // 3. Create propuesta
        const propuesta = await tx.propuesta.create({
          data: {
            cliente_id,
            fecha: new Date(),
            status: 'Pendiente',
            descripcion,
            notas,
            solicitud_id: solicitud.id,
            asignado: asignadosStr,
            id_asignado: asignadosIds,
            inversion: totalInversion,
            precio: totalInversion,
            comentario_cambio_status: '',
            articulo,
          },
        });

        // 4. Create cotizacion
        const cotizacion = await tx.cotizacion.create({
          data: {
            user_id: userId || 0,
            clientes_id: cliente_id,
            nombre_campania,
            numero_caras: totalCaras,
            fecha_inicio: new Date(fecha_inicio),
            fecha_fin: new Date(fecha_fin),
            frontal: caras.reduce((acc: number, c: { caras_flujo: number }) => acc + (c.caras_flujo || 0), 0),
            cruzada: caras.reduce((acc: number, c: { caras_contraflujo: number }) => acc + (c.caras_contraflujo || 0), 0),
            nivel_socioeconomico: caras.map((c: { nivel_socioeconomico: string }) => c.nivel_socioeconomico).join(','),
            observaciones: notas || '',
            bonificacion: totalBonificacion,
            descuento: 0,
            precio: totalInversion,
            contacto: asignadosStr,
            status: 'Pendiente',
            id_propuesta: propuesta.id,
            articulo,
          },
        });

        // 5. Create campania
        const campania = await tx.campania.create({
          data: {
            cliente_id,
            nombre: nombre_campania,
            fecha_inicio: new Date(fecha_inicio),
            fecha_fin: new Date(fecha_fin),
            total_caras: totalCaras.toString(),
            bonificacion: totalBonificacion,
            status: 'inactiva',
            cotizacion_id: cotizacion.id,
            articulo,
          },
        });

        // 6. Create solicitud_original
        await tx.solicitud_original.create({
          data: {
            fecha: new Date(),
            descripcion,
            presupuesto: presupuesto || totalInversion,
            notas: notas || '',
            cliente_id,
            usuario_id: userId,
            status: 'Pendiente',
            nombre_usuario: userName,
            propuesta_id: propuesta.id,
            nombre_campania,
            fecha_inicio: new Date(fecha_inicio),
            fecha_fin: new Date(fecha_fin),
            flujo: caras.reduce((acc: number, c: { caras_flujo: number }) => acc + (c.caras_flujo || 0), 0),
            contraflujo: caras.reduce((acc: number, c: { caras_contraflujo: number }) => acc + (c.caras_contraflujo || 0), 0),
            total_flujo: totalCaras,
            bonificacion: totalBonificacion,
            nombre_cliente: razon_social,
            descuento: 0,
            articulo,
          },
        });

        // 7. Create tareas for each asignado
        for (const asignado of asignados) {
          await tx.tareas.create({
            data: {
              fecha_inicio: new Date(),
              fecha_fin: new Date(fecha_fin),
              tipo: 'Solicitud',
              responsable: asignado.nombre,
              id_responsable: asignado.id,
              estatus: 'Pendiente',
              descripcion: `Atender solicitud: ${nombre_campania}`,
              titulo: nombre_campania,
              campania_id: campania.id,
              id_solicitud: solicitud.id.toString(),
              id_propuesta: propuesta.id.toString(),
              asignado: asignado.nombre,
              id_asignado: asignado.id.toString(),
            },
          });
        }

        // 8. Create solicitudCaras for each cara entry
        const createdCaras = [];
        for (const cara of caras) {
          const solicitudCara = await tx.solicitudCaras.create({
            data: {
              idquote: propuesta.id.toString(),
              ciudad: cara.ciudad,
              estados: cara.estado,
              tipo: cara.tipo,
              flujo: cara.flujo || 'Ambos',
              bonificacion: cara.bonificacion || 0,
              caras: cara.caras,
              nivel_socioeconomico: cara.nivel_socioeconomico,
              formato: cara.formato,
              costo: cara.costo,
              tarifa_publica: cara.tarifa_publica || 0,
              inicio_periodo: new Date(cara.inicio_periodo),
              fin_periodo: new Date(cara.fin_periodo),
              caras_flujo: cara.caras_flujo || 0,
              caras_contraflujo: cara.caras_contraflujo || 0,
              articulo: cara.articulo || articulo, // Use per-cara articulo, fallback to top-level
              descuento: cara.descuento || 0,
            },
          });
          createdCaras.push(solicitudCara);
        }

        return {
          solicitud,
          propuesta,
          cotizacion,
          campania,
          caras: createdCaras,
        };
      }, {
        maxWait: 60000, // 60 seconds max wait to acquire transaction
        timeout: 120000, // 2 minutes for the transaction to complete
      });

      res.status(201).json({
        success: true,
        data: result,
        message: 'Solicitud creada exitosamente',
      });
    } catch (error) {
      console.error('Error creating solicitud:', error);
      const message = error instanceof Error ? error.message : 'Error al crear solicitud';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Add comment to solicitud
  async addComment(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { comentario } = req.body;
      const userId = req.user?.userId;
      // Get user name from database if not in token
      let userName = req.user?.nombre;
      if (!userName && userId) {
        const user = await prisma.usuario.findUnique({ where: { id: userId }, select: { nombre: true } });
        userName = user?.nombre || 'Usuario';
      }
      userName = userName || 'Usuario';

      if (!userId) {
        res.status(401).json({ success: false, error: 'No autorizado' });
        return;
      }

      // Get solicitud and its campania_id
      const solicitud = await prisma.solicitud.findFirst({
        where: { id: parseInt(id), deleted_at: null },
      });

      if (!solicitud) {
        res.status(404).json({ success: false, error: 'Solicitud no encontrada' });
        return;
      }

      // Get campania_id from propuesta -> cotizacion -> campania
      const propuesta = await prisma.propuesta.findFirst({
        where: { solicitud_id: solicitud.id, deleted_at: null },
      });
      const cotizacion = propuesta ? await prisma.cotizacion.findFirst({
        where: { id_propuesta: propuesta.id },
      }) : null;
      const campania = cotizacion ? await prisma.campania.findFirst({
        where: { cotizacion_id: cotizacion.id },
      }) : null;

      const newComment = await prisma.comentarios.create({
        data: {
          autor_id: userId,
          comentario,
          creado_en: new Date(),
          campania_id: campania?.id || 0,
          solicitud_id: solicitud.id,
          origen: 'solicitud',
        },
      });

      // Crear notificaciones para todos los involucrados (excepto el autor)
      const nombreSolicitud = solicitud.razon_social || solicitud.marca_nombre || 'Sin nombre';
      const tituloNotificacion = `Nuevo comentario en solicitud #${solicitud.id} - ${nombreSolicitud}`;
      const descripcionNotificacion = `${userName} comentó: ${comentario.substring(0, 100)}${comentario.length > 100 ? '...' : ''}`;

      // Recopilar todos los involucrados (sin duplicados, excluyendo al autor)
      const involucrados = new Set<number>();

      // Agregar usuarios asignados
      if (solicitud.id_asignado) {
        solicitud.id_asignado.split(',').forEach(id => {
          const parsed = parseInt(id.trim());
          if (!isNaN(parsed) && parsed !== userId) {
            involucrados.add(parsed);
          }
        });
      }

      // Agregar creador de la solicitud
      if (solicitud.usuario_id && solicitud.usuario_id !== userId) {
        involucrados.add(solicitud.usuario_id);
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
            id_solicitud: solicitud.id.toString(),
            id_propuesta: propuesta?.id?.toString() || '',
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
          ...newComment,
          autor_nombre: userName,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al agregar comentario';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Get comments for solicitud
  async getComments(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const comentarios = await prisma.comentarios.findMany({
        where: { solicitud_id: parseInt(id) },
        orderBy: { creado_en: 'desc' },
      });

      // Get autor names and photos
      const autorIds = [...new Set(comentarios.map(c => c.autor_id))];
      const autores = await prisma.usuario.findMany({
        where: { id: { in: autorIds } },
        select: { id: true, nombre: true, foto_perfil: true },
      });
      const autoresMap = new Map(autores.map(a => [a.id, { nombre: a.nombre, foto_perfil: a.foto_perfil }]));

      const comentariosWithAuthor = comentarios.map(c => ({
        ...c,
        autor_nombre: autoresMap.get(c.autor_id)?.nombre || 'Usuario desconocido',
        autor_foto: autoresMap.get(c.autor_id)?.foto_perfil || null,
      }));

      res.json({
        success: true,
        data: comentariosWithAuthor,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener comentarios';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Atender solicitud (change status to Atendida and create tasks)
  async atender(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.user?.userId;
      // Get user name from database if not in token
      let userName = req.user?.nombre;
      if (!userName && userId) {
        const user = await prisma.usuario.findUnique({ where: { id: userId }, select: { nombre: true } });
        userName = user?.nombre || 'Usuario';
      }
      userName = userName || 'Usuario';

      if (!userId) {
        res.status(401).json({ success: false, error: 'No autorizado' });
        return;
      }

      const solicitud = await prisma.solicitud.findFirst({
        where: { id: parseInt(id), deleted_at: null },
      });

      if (!solicitud) {
        res.status(404).json({ success: false, error: 'Solicitud no encontrada' });
        return;
      }

      if (solicitud.status !== 'Aprobada') {
        res.status(400).json({ success: false, error: 'Solo se pueden atender solicitudes aprobadas' });
        return;
      }

      // Get propuesta
      const propuesta = await prisma.propuesta.findFirst({
        where: { solicitud_id: solicitud.id, deleted_at: null },
      });

      // Get cotizacion
      const cotizacion = propuesta ? await prisma.cotizacion.findFirst({
        where: { id_propuesta: propuesta.id },
      }) : null;

      await prisma.$transaction(async (tx) => {
        // Update solicitud status
        await tx.solicitud.update({
          where: { id: solicitud.id },
          data: { status: 'Atendida' },
        });

        // Update propuesta status
        if (propuesta) {
          await tx.propuesta.update({
            where: { id: propuesta.id },
            data: { status: 'Abierto' },
          });
        }

        // Update existing tareas to "Atendido"
        await tx.tareas.updateMany({
          where: { id_solicitud: solicitud.id.toString() },
          data: { estatus: 'Atendido' },
        });

        // Create new tarea for seguimiento propuesta
        if (propuesta) {
          await tx.tareas.create({
            data: {
              fecha_inicio: new Date(),
              fecha_fin: solicitud.fecha || new Date(),
              tipo: 'Seguimiento de propuesta',
              responsable: solicitud.nombre_usuario || userName || '',
              id_responsable: solicitud.usuario_id || userId,
              asignado: solicitud.asignado || '',
              id_asignado: solicitud.id_asignado || '',
              estatus: 'Activo',
              descripcion: `Seguimiento de propuesta: ${cotizacion?.nombre_campania || ''}`,
              titulo: `Atender propuesta ${cotizacion?.nombre_campania || ''}`,
              id_propuesta: propuesta.id.toString(),
              id_solicitud: solicitud.id.toString(),
            },
          });
        }

        // Create historial for solicitud
        await tx.historial.create({
          data: {
            tipo: 'Solicitud',
            ref_id: solicitud.id,
            accion: 'Activación',
            fecha_hora: new Date(),
            detalles: 'Se ha atendido la solicitud.',
          },
        });

        // Create historial for propuesta
        if (propuesta) {
          await tx.historial.create({
            data: {
              tipo: 'Propuesta',
              ref_id: propuesta.id,
              accion: 'Inicio',
              fecha_hora: new Date(),
              detalles: 'Se ha creado la propuesta.',
            },
          });
        }

        // Crear notificaciones para usuarios involucrados
        const involucrados = new Set<number>();

        // Agregar creador de la solicitud
        if (solicitud.usuario_id && solicitud.usuario_id !== userId) {
          involucrados.add(solicitud.usuario_id);
        }

        // Agregar usuarios asignados
        if (solicitud.id_asignado) {
          solicitud.id_asignado.split(',').forEach(idStr => {
            const parsed = parseInt(idStr.trim());
            if (!isNaN(parsed) && parsed !== userId) {
              involucrados.add(parsed);
            }
          });
        }

        // Crear notificación para cada involucrado
        const now = new Date();
        for (const responsableId of involucrados) {
          await tx.tareas.create({
            data: {
              titulo: 'Solicitud atendida',
              descripcion: `La solicitud "${solicitud.descripcion || solicitud.id}" ha sido atendida por ${userName}`,
              tipo: 'Notificación',
              estatus: 'Pendiente',
              id_responsable: responsableId,
              asignado: userName,
              id_asignado: userId.toString(),
              id_solicitud: solicitud.id.toString(),
              id_propuesta: propuesta?.id.toString() || '',
              fecha_inicio: now,
              fecha_fin: now,
            },
          });
        }
      });

      res.json({
        success: true,
        message: 'Solicitud atendida exitosamente',
      });
    } catch (error) {
      console.error('Error atendiendo solicitud:', error);
      const message = error instanceof Error ? error.message : 'Error al atender solicitud';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Update solicitud
  async update(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const {
        cliente_id,
        cuic,
        razon_social,
        unidad_negocio,
        marca_id,
        marca_nombre,
        asesor,
        producto_id,
        producto_nombre,
        agencia,
        categoria_id,
        categoria_nombre,
        nombre_campania,
        descripcion,
        notas,
        presupuesto,
        articulo,
        asignados,
        fecha_inicio,
        fecha_fin,
        archivo,
        tipo_archivo,
        IMU,
        caras,
      } = req.body;

      const solicitud = await prisma.solicitud.findFirst({
        where: { id: parseInt(id), deleted_at: null },
      });

      if (!solicitud) {
        res.status(404).json({ success: false, error: 'Solicitud no encontrada' });
        return;
      }

      // Calculate totals from caras
      const totalCaras = caras.reduce((acc: number, c: { caras: number; bonificacion: number }) => acc + c.caras + (c.bonificacion || 0), 0);
      const totalBonificacion = caras.reduce((acc: number, c: { bonificacion: number }) => acc + (c.bonificacion || 0), 0);
      const totalInversion = caras.reduce((acc: number, c: { costo: number }) => acc + c.costo, 0);

      // Format asignados string
      const asignadosStr = asignados.map((a: { nombre: string }) => a.nombre).join(', ');
      const asignadosIds = asignados.map((a: { id: number }) => a.id).join(',');

      // Get existing propuesta
      const propuesta = await prisma.propuesta.findFirst({
        where: { solicitud_id: solicitud.id, deleted_at: null },
      });

      // Get existing cotizacion
      const cotizacion = propuesta ? await prisma.cotizacion.findFirst({
        where: { id_propuesta: propuesta.id },
      }) : null;

      // Get existing campania
      const campania = cotizacion ? await prisma.campania.findFirst({
        where: { cotizacion_id: cotizacion.id },
      }) : null;

      await prisma.$transaction(async (tx) => {
        // Update solicitud
        await tx.solicitud.update({
          where: { id: solicitud.id },
          data: {
            descripcion,
            presupuesto: presupuesto || totalInversion,
            notas: notas || '',
            cliente_id,
            asignado: asignadosStr,
            id_asignado: asignadosIds,
            cuic: cuic?.toString(),
            razon_social,
            unidad_negocio,
            marca_id,
            marca_nombre,
            asesor,
            producto_id,
            producto_nombre,
            agencia,
            categoria_id,
            categoria_nombre,
            IMU: IMU ? 1 : 0,
            archivo,
            tipo_archivo,
          },
        });

        // Update propuesta if exists
        if (propuesta) {
          await tx.propuesta.update({
            where: { id: propuesta.id },
            data: {
              cliente_id,
              descripcion,
              notas,
              asignado: asignadosStr,
              id_asignado: asignadosIds,
              inversion: totalInversion,
              precio: totalInversion,
              articulo,
            },
          });
        }

        // Update cotizacion if exists
        if (cotizacion) {
          await tx.cotizacion.update({
            where: { id: cotizacion.id },
            data: {
              clientes_id: cliente_id,
              nombre_campania,
              numero_caras: totalCaras,
              fecha_inicio: new Date(fecha_inicio),
              fecha_fin: new Date(fecha_fin),
              frontal: caras.reduce((acc: number, c: { caras_flujo: number }) => acc + (c.caras_flujo || 0), 0),
              cruzada: caras.reduce((acc: number, c: { caras_contraflujo: number }) => acc + (c.caras_contraflujo || 0), 0),
              nivel_socioeconomico: caras.map((c: { nivel_socioeconomico: string }) => c.nivel_socioeconomico).join(','),
              observaciones: notas || '',
              bonificacion: totalBonificacion,
              precio: totalInversion,
              contacto: asignadosStr,
              articulo,
            },
          });
        }

        // Update campania if exists
        if (campania) {
          await tx.campania.update({
            where: { id: campania.id },
            data: {
              cliente_id,
              nombre: nombre_campania,
              fecha_inicio: new Date(fecha_inicio),
              fecha_fin: new Date(fecha_fin),
              total_caras: totalCaras.toString(),
              bonificacion: totalBonificacion,
              articulo,
            },
          });
        }

        // Delete existing caras and recreate
        if (propuesta) {
          await tx.solicitudCaras.deleteMany({
            where: { idquote: propuesta.id.toString() },
          });

          // Create new caras
          for (const cara of caras) {
            await tx.solicitudCaras.create({
              data: {
                idquote: propuesta.id.toString(),
                ciudad: cara.ciudad,
                estados: cara.estado,
                tipo: cara.tipo,
                flujo: cara.flujo || 'Ambos',
                bonificacion: cara.bonificacion || 0,
                caras: cara.caras,
                nivel_socioeconomico: cara.nivel_socioeconomico,
                formato: cara.formato,
                costo: cara.costo,
                tarifa_publica: cara.tarifa_publica || 0,
                inicio_periodo: new Date(cara.inicio_periodo),
                fin_periodo: new Date(cara.fin_periodo),
                caras_flujo: cara.caras_flujo || 0,
                caras_contraflujo: cara.caras_contraflujo || 0,
                articulo: cara.articulo || articulo, // Use per-cara articulo, fallback to top-level
                descuento: cara.descuento || 0,
              },
            });
          }
        }

        // Create historial entry
        await tx.historial.create({
          data: {
            tipo: 'Solicitud',
            ref_id: solicitud.id,
            accion: 'Edición',
            fecha_hora: new Date(),
            detalles: `Solicitud editada por ${req.user?.nombre || 'usuario'}`,
          },
        });
      }, {
        maxWait: 60000,
        timeout: 120000,
      });

      res.json({
        success: true,
        message: 'Solicitud actualizada exitosamente',
      });
    } catch (error) {
      console.error('Error updating solicitud:', error);
      const message = error instanceof Error ? error.message : 'Error al actualizar solicitud';
      res.status(500).json({ success: false, error: message });
    }
  }

  async uploadArchivo(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!req.file) {
        res.status(400).json({ success: false, error: 'No se proporcionó archivo' });
        return;
      }

      const fileUrl = `/uploads/${req.file.filename}`;

      await prisma.solicitud.update({
        where: { id: parseInt(id) },
        data: {
          archivo: fileUrl,
        },
      });

      res.json({ success: true, data: { url: fileUrl } });
    } catch (error) {
      console.error('Error uploading archivo:', error);
      const message = error instanceof Error ? error.message : 'Error al subir archivo';
      res.status(500).json({ success: false, error: message });
    }
  }
}

export const solicitudesController = new SolicitudesController();
