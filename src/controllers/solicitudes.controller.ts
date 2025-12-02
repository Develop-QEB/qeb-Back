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
      const userName = req.user?.nombre || req.user?.email;

      // Calculate totals from caras
      const totalCaras = caras.reduce((acc: number, c: { caras: number; bonificacion: number }) => acc + c.caras + (c.bonificacion || 0), 0);
      const totalBonificacion = caras.reduce((acc: number, c: { bonificacion: number }) => acc + (c.bonificacion || 0), 0);
      const totalInversion = caras.reduce((acc: number, c: { costo: number }) => acc + c.costo, 0);

      // Format asignados string
      const asignadosStr = asignados.map((a: { nombre: string }) => a.nombre).join(', ');
      const asignadosIds = asignados.map((a: { id: number }) => a.id).join(',');

      // Use transaction for complex creation
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
              articulo,
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
}

export const solicitudesController = new SolicitudesController();
