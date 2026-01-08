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
        const searchNum = parseInt(search);
        const orConditions: Record<string, unknown>[] = [
          { codigo_unico: { contains: search } },
          { ubicacion: { contains: search } },
          { municipio: { contains: search } },
        ];

        // Si es un número, también buscar por ID
        if (!isNaN(searchNum)) {
          orConditions.push({ id: searchNum });
        }

        where.OR = orConditions;
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

  // Buscar inventario disponible para asignación de propuestas
  async getDisponibles(req: AuthRequest, res: Response): Promise<void> {
    try {
      const {
        ciudad,
        estado,
        formato,
        flujo,
        nse,
        tipo,
        fecha_inicio,
        fecha_fin,
        solicitudCaraId,
      } = req.query;

      // Build where clause for inventarios
      const where: Record<string, unknown> = {
        latitud: { not: 0 },
        longitud: { not: 0 },
      };

      // Filter by city (plaza)
      if (ciudad) {
        where.plaza = ciudad;
      }

      // Filter by state
      if (estado) {
        where.estado = estado;
      }

      // Filter by format (tipo_de_mueble)
      if (formato) {
        where.tipo_de_mueble = { contains: formato as string };
      }

      // Filter by flujo (tipo_de_cara: Flujo/Contraflujo)
      if (flujo && flujo !== 'Completo') {
        where.tipo_de_cara = flujo;
      }

      // Filter by NSE (nivel_socioeconomico)
      if (nse) {
        const nseList = (nse as string).split(',').map(n => n.trim());
        where.nivel_socioeconomico = { in: nseList };
      }

      // Filter by tipo (tradicional/digital)
      if (tipo) {
        where.tradicional_digital = tipo;
      }

      // Get all inventarios that match the criteria
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
          tarifa_piso: true,
          tradicional_digital: true,
          nivel_socioeconomico: true,
          ancho: true,
          alto: true,
          total_espacios: true,
          entre_calle_1: true,
          entre_calle_2: true,
          orientacion: true,
          sentido: true,
        },
      });

      // Get espacio_inventario for each inventario
      const inventarioIds = inventarios.map(inv => inv.id);
      const espacios = await prisma.espacio_inventario.findMany({
        where: { inventario_id: { in: inventarioIds } },
      });

      // If we have date range, get reservations for that period
      let reservedInventarioIds: Set<number> = new Set();

      if (fecha_inicio && fecha_fin) {
        const fechaIni = new Date(fecha_inicio as string);
        const fechaFin = new Date(fecha_fin as string);

        // Get calendarios that overlap with the date range
        const calendarios = await prisma.calendario.findMany({
          where: {
            deleted_at: null,
            OR: [
              {
                fecha_inicio: { lte: fechaFin },
                fecha_fin: { gte: fechaIni },
              },
            ],
          },
          select: { id: true },
        });

        const calendarioIds = calendarios.map(c => c.id);

        if (calendarioIds.length > 0) {
          // Get reservations in those calendarios - need to map through espacio_inventario
          const reservas = await prisma.reservas.findMany({
            where: {
              deleted_at: null,
              calendario_id: { in: calendarioIds },
              estatus: { in: ['Reservado', 'Bonificado'] },
            },
            select: { inventario_id: true },
          });

          // reservas.inventario_id is actually espacio_inventario.id, need to map to inventarios.id
          const espacioIds = reservas.map(r => r.inventario_id);
          if (espacioIds.length > 0) {
            const espaciosReservados = await prisma.espacio_inventario.findMany({
              where: { id: { in: espacioIds } },
              select: { inventario_id: true },
            });
            reservedInventarioIds = new Set(espaciosReservados.map(e => e.inventario_id));
          }
        }
      }

      // Get already reserved for this solicitudCara if provided
      let alreadyReservedForCara: Set<number> = new Set();
      if (solicitudCaraId) {
        const existingReservas = await prisma.reservas.findMany({
          where: {
            deleted_at: null,
            solicitudCaras_id: parseInt(solicitudCaraId as string),
          },
          select: { inventario_id: true },
        });
        // reservas.inventario_id is actually espacio_inventario.id, need to map to inventarios.id
        const espacioIds = existingReservas.map(r => r.inventario_id);
        if (espacioIds.length > 0) {
          const espaciosReservados = await prisma.espacio_inventario.findMany({
            where: { id: { in: espacioIds } },
            select: { inventario_id: true },
          });
          alreadyReservedForCara = new Set(espaciosReservados.map(e => e.inventario_id));
        }
      }

      // Build the response with espacio info and filter out reserved
      const espaciosByInventario = espacios.reduce((acc, esp) => {
        if (!acc[esp.inventario_id]) {
          acc[esp.inventario_id] = [];
        }
        acc[esp.inventario_id].push(esp);
        return acc;
      }, {} as Record<number, typeof espacios>);

      const disponibles = inventarios
        .filter(inv => !reservedInventarioIds.has(inv.id))
        .map(inv => ({
          ...inv,
          espacios: espaciosByInventario[inv.id] || [],
          espacios_count: (espaciosByInventario[inv.id] || []).length,
          ya_reservado_para_cara: alreadyReservedForCara.has(inv.id),
        }));

      res.json({
        success: true,
        data: disponibles,
        total: disponibles.length,
        filtros_aplicados: {
          ciudad,
          estado,
          formato,
          flujo,
          nse,
          tipo,
          fecha_inicio,
          fecha_fin,
        },
      });
    } catch (error) {
      console.error('Error getDisponibles:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener inventarios disponibles';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Get formatos disponibles por ciudad
  async getFormatosByCiudad(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { ciudad } = req.query;

      const where: Record<string, unknown> = {};
      if (ciudad) {
        where.plaza = ciudad;
      }

      const formatos = await prisma.inventarios.findMany({
        where,
        select: { tipo_de_mueble: true },
        distinct: ['tipo_de_mueble'],
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

  // Get NSE disponibles
  async getNSE(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const nseList = await prisma.inventarios.findMany({
        select: { nivel_socioeconomico: true },
        distinct: ['nivel_socioeconomico'],
      });

      res.json({
        success: true,
        data: nseList.map(n => n.nivel_socioeconomico).filter(Boolean),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener NSE';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Get estados disponibles
  async getEstados(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const estados = await prisma.inventarios.findMany({
        select: { estado: true },
        distinct: ['estado'],
      });

      res.json({
        success: true,
        data: estados.map(e => e.estado).filter(Boolean).sort(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener estados';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Get ciudades por estado
  async getCiudadesByEstado(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { estado } = req.query;

      const where: Record<string, unknown> = {};
      if (estado) {
        where.estado = estado;
      }

      const ciudades = await prisma.inventarios.findMany({
        where,
        select: { plaza: true },
        distinct: ['plaza'],
      });

      res.json({
        success: true,
        data: ciudades.map(c => c.plaza).filter(Boolean).sort(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener ciudades';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Obtener historial de un inventario (reservas, campañas, fechas, artes)
  async getHistorial(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const inventarioId = parseInt(id);

      // Obtener info del inventario
      const inventario = await prisma.inventarios.findUnique({
        where: { id: inventarioId },
        select: {
          id: true,
          codigo_unico: true,
          ubicacion: true,
          mueble: true,
          plaza: true,
          estado: true,
          tipo_de_cara: true,
          tradicional_digital: true,
          latitud: true,
          longitud: true,
          ancho: true,
          alto: true,
        },
      });

      if (!inventario) {
        res.status(404).json({
          success: false,
          error: 'Inventario no encontrado',
        });
        return;
      }

      // Query para obtener historial de reservas con campañas
      const query = `
        SELECT
          rsv.id as reserva_id,
          rsv.estatus as reserva_estatus,
          rsv.archivo,
          rsv.arte_aprobado,
          rsv.fecha_reserva,
          rsv.instalado,
          rsv.APS,
          sc.inicio_periodo,
          sc.fin_periodo,
          sc.tipo as tipo_medio,
          cm.id as campana_id,
          cm.nombre as campana_nombre,
          cl.T0_U_Cliente as cliente_nombre,
          cat.numero_catorcena,
          cat.año as anio_catorcena
        FROM espacio_inventario epIn
          INNER JOIN reservas rsv ON epIn.id = rsv.inventario_id
          INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
          INNER JOIN cotizacion ct ON ct.id_propuesta = sc.idquote
          INNER JOIN campania cm ON cm.cotizacion_id = ct.id
          LEFT JOIN cliente cl ON cl.id = cm.cliente_id
          LEFT JOIN catorcenas cat ON sc.inicio_periodo BETWEEN cat.fecha_inicio AND cat.fecha_fin
        WHERE epIn.inventario_id = ?
          AND rsv.estatus != 'eliminada'
          AND rsv.deleted_at IS NULL
        ORDER BY sc.inicio_periodo DESC
      `;

      const historial = await prisma.$queryRawUnsafe(query, inventarioId);

      // Convertir BigInt a Number
      const historialSerializable = JSON.parse(JSON.stringify(historial, (_, value) =>
        typeof value === 'bigint' ? Number(value) : value
      ));

      res.json({
        success: true,
        data: {
          inventario,
          historial: historialSerializable,
        },
      });
    } catch (error) {
      console.error('Error en getHistorial:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener historial';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }
}

export const inventariosController = new InventariosController();
