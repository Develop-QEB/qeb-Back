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
      } else {
        where.estatus = { not: 'Bloqueado' };
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

      console.log('[getDisponibles] Query params:', { ciudad, estado, formato, flujo, nse, tipo });

      // Build where clause for inventarios
      const where: Record<string, unknown> = {
        latitud: { not: 0 },
        longitud: { not: 0 },
        estatus: { not: 'Bloqueado' },
      };

      // Filter by city (plaza) - puede ser múltiples ciudades separadas por coma
      if (ciudad) {
        const ciudadList = (ciudad as string).split(',').map(c => c.trim()).filter(Boolean);
        if (ciudadList.length === 1) {
          where.plaza = ciudadList[0];
        } else if (ciudadList.length > 1) {
          where.plaza = { in: ciudadList };
        }
      }

      // Filter by state - puede ser múltiples estados separados por coma
      if (estado) {
        const estadoList = (estado as string).split(',').map(e => e.trim()).filter(Boolean);
        if (estadoList.length === 1) {
          where.estado = estadoList[0];
        } else if (estadoList.length > 1) {
          where.estado = { in: estadoList };
        }
      }

      // Filter by format (tipo_de_mueble) - puede ser múltiples formatos separados por coma
      if (formato) {
        const formatoList = (formato as string).split(',').map(f => f.trim()).filter(Boolean);
        if (formatoList.length === 1) {
          where.tipo_de_mueble = { contains: formatoList[0] };
        } else if (formatoList.length > 1) {
          where.OR = formatoList.map(f => ({ tipo_de_mueble: { contains: f } }));
        }
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
      console.log('[getDisponibles] Where clause:', JSON.stringify(where, null, 2));
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
          isla: true,
        },
      });

      // Get espacio_inventario for each inventario
      console.log('[getDisponibles] Found inventarios:', inventarios.length);
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

      // Get reserved espacio_ids (not inventario_ids) for digital inventory
      let reservedEspacioIds: Set<number> = new Set();
      let reservedForCaraEspacioIds: Set<number> = new Set();

      if (fecha_inicio && fecha_fin) {
        const fechaIni2 = new Date(fecha_inicio as string);
        const fechaFin2 = new Date(fecha_fin as string);

        const calendarios2 = await prisma.calendario.findMany({
          where: {
            deleted_at: null,
            OR: [{ fecha_inicio: { lte: fechaFin2 }, fecha_fin: { gte: fechaIni2 } }],
          },
          select: { id: true },
        });

        if (calendarios2.length > 0) {
          const reservas2 = await prisma.reservas.findMany({
            where: {
              deleted_at: null,
              calendario_id: { in: calendarios2.map(c => c.id) },
              estatus: { in: ['Reservado', 'Bonificado', 'Vendido'] },
            },
            select: { inventario_id: true }, // This is actually espacio_inventario.id
          });
          reservedEspacioIds = new Set(reservas2.map(r => r.inventario_id));
        }
      }

      if (solicitudCaraId) {
        const existingReservas2 = await prisma.reservas.findMany({
          where: {
            deleted_at: null,
            solicitudCaras_id: parseInt(solicitudCaraId as string),
          },
          select: { inventario_id: true },
        });
        reservedForCaraEspacioIds = new Set(existingReservas2.map(r => r.inventario_id));
      }

      // Build the response - for digital items, create one entry per available espacio
      const disponibles: Array<{
        id: number;
        codigo_unico: string | null;
        ubicacion: string | null;
        tipo_de_mueble: string | null;
        tipo_de_cara: string | null;
        cara: string | null;
        latitud: number | null;
        longitud: number | null;
        plaza: string | null;
        estado: string | null;
        municipio: string | null;
        estatus: string | null;
        tarifa_publica: number | null;
        tarifa_piso: number | null;
        tradicional_digital: string | null;
        nivel_socioeconomico: string | null;
        ancho: number | null;
        alto: number | null;
        total_espacios: number | null;
        entre_calle_1: string | null;
        entre_calle_2: string | null;
        orientacion: string | null;
        sentido: string | null;
        espacio_id: number | null;
        numero_espacio: number | null;
        espacios: typeof espacios;
        espacios_count: number;
        ya_reservado_para_cara: boolean;
      }> = [];

      for (const inv of inventarios) {
        const invEspacios = espacios.filter(e => e.inventario_id === inv.id);
        const isDigital = inv.tradicional_digital === 'Digital' || (inv.total_espacios && inv.total_espacios > 0);

        if (isDigital && invEspacios.length > 0) {
          // Digital: create one entry per available espacio
          for (const esp of invEspacios) {
            const isReserved = reservedEspacioIds.has(esp.id);
            const isReservedForCara = reservedForCaraEspacioIds.has(esp.id);

            if (!isReserved) {
              disponibles.push({
                ...inv,
                tarifa_publica: inv.tarifa_publica ? Number(inv.tarifa_publica) : null,
                tarifa_piso: inv.tarifa_piso ? Number(inv.tarifa_piso) : null,
                espacio_id: esp.id,
                numero_espacio: esp.numero_espacio,
                espacios: [esp],
                espacios_count: 1,
                ya_reservado_para_cara: isReservedForCara,
              });
            }
          }
        } else {
          // Traditional: show once if not all reserved
          const allReserved = invEspacios.length > 0 && invEspacios.every(e => reservedEspacioIds.has(e.id));
          if (!allReserved && !reservedInventarioIds.has(inv.id)) {
            const availableEspacios = invEspacios.filter(e => !reservedEspacioIds.has(e.id));
            disponibles.push({
              ...inv,
              tarifa_publica: inv.tarifa_publica ? Number(inv.tarifa_publica) : null,
              tarifa_piso: inv.tarifa_piso ? Number(inv.tarifa_piso) : null,
              espacio_id: availableEspacios[0]?.id || null,
              numero_espacio: availableEspacios[0]?.numero_espacio || null,
              espacios: availableEspacios,
              espacios_count: availableEspacios.length,
              ya_reservado_para_cara: alreadyReservedForCara.has(inv.id),
            });
          }
        }
      }

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

  /**
   * Poblar/actualizar la tabla espacio_inventario basado en todos los inventarios
   * - Para digitales (total_espacios > 0): crear N registros (1 por espacio)
   * - Para tradicionales: crear 1 registro por inventario
   */
  async poblarEspaciosInventario(_req: AuthRequest, res: Response): Promise<void> {
    try {
      // 1. Limpiar la tabla espacio_inventario
      await prisma.espacio_inventario.deleteMany({});
      console.log('[poblarEspacios] Tabla espacio_inventario limpiada');

      // 2. Obtener TODOS los inventarios
      const todosInventarios = await prisma.inventarios.findMany({
        select: {
          id: true,
          codigo_unico: true,
          total_espacios: true,
          tipo_de_mueble: true,
          tradicional_digital: true
        }
      });

      console.log(`[poblarEspacios] Encontrados ${todosInventarios.length} inventarios totales`);

      // 3. Crear registros de espacios
      const espaciosToCreate: { inventario_id: number; numero_espacio: number }[] = [];
      let digitalesCount = 0;
      let tradicionalesCount = 0;

      for (const inv of todosInventarios) {
        const isDigital = inv.tradicional_digital === 'Digital' || (inv.total_espacios && inv.total_espacios > 0);

        if (isDigital && inv.total_espacios && inv.total_espacios > 0) {
          // Digital: crear N espacios
          for (let i = 1; i <= inv.total_espacios; i++) {
            espaciosToCreate.push({
              inventario_id: inv.id,
              numero_espacio: i
            });
          }
          digitalesCount++;
        } else {
          // Tradicional: crear 1 espacio
          espaciosToCreate.push({
            inventario_id: inv.id,
            numero_espacio: 1
          });
          tradicionalesCount++;
        }
      }

      // 4. Insertar todos los espacios
      if (espaciosToCreate.length > 0) {
        await prisma.espacio_inventario.createMany({
          data: espaciosToCreate
        });
      }

      console.log(`[poblarEspacios] Creados ${espaciosToCreate.length} espacios (${digitalesCount} digitales, ${tradicionalesCount} tradicionales)`);

      // Detalle solo de digitales para no sobrecargar la respuesta
      const inventariosDigitales = todosInventarios.filter(inv =>
        inv.tradicional_digital === 'Digital' || (inv.total_espacios && inv.total_espacios > 0)
      );

      res.json({
        success: true,
        message: `Se poblaron ${espaciosToCreate.length} espacios (${digitalesCount} digitales con múltiples espacios, ${tradicionalesCount} tradicionales)`,
        data: {
          inventarios_procesados: todosInventarios.length,
          espacios_creados: espaciosToCreate.length,
          digitales: digitalesCount,
          tradicionales: tradicionalesCount,
          detalle_digitales: inventariosDigitales.map(inv => ({
            id: inv.id,
            codigo: inv.codigo_unico,
            tipo: inv.tipo_de_mueble,
            espacios: inv.total_espacios
          }))
        }
      });
    } catch (error) {
      console.error('Error en poblarEspaciosInventario:', error);
      const message = error instanceof Error ? error.message : 'Error al poblar espacios';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  /**
   * Arreglar reservas huérfanas después de repoblar espacio_inventario
   * Las reservas que tenían inventario_id apuntando a IDs viejos necesitan actualizarse
   */
  async arreglarReservasHuerfanas(_req: AuthRequest, res: Response): Promise<void> {
    try {
      // 1. Obtener todos los espacio_inventario actuales
      const espaciosActuales = await prisma.espacio_inventario.findMany({
        select: { id: true, inventario_id: true, numero_espacio: true }
      });
      const espacioIdsActuales = new Set(espaciosActuales.map(e => e.id));

      // Crear mapa de inventario_id -> espacio_id (primer espacio de cada inventario)
      const inventarioToEspacio = new Map<number, number>();
      for (const esp of espaciosActuales) {
        if (!inventarioToEspacio.has(esp.inventario_id)) {
          inventarioToEspacio.set(esp.inventario_id, esp.id);
        }
      }

      // 2. Obtener todas las reservas
      const todasReservas = await prisma.reservas.findMany({
        where: { deleted_at: null },
        select: { id: true, inventario_id: true }
      });

      // 3. Identificar reservas huérfanas (su inventario_id no existe en espacio_inventario actual)
      const reservasHuerfanas = todasReservas.filter(r => !espacioIdsActuales.has(r.inventario_id));
      console.log(`[arreglarReservas] Encontradas ${reservasHuerfanas.length} reservas huérfanas de ${todasReservas.length} totales`);

      // 4. Intentar arreglar cada reserva huérfana
      // Asumimos que el viejo inventario_id era el inventarios.id directamente
      let arregladas = 0;
      let noEncontradas = 0;
      const detalles: { reservaId: number; oldId: number; newId: number | null; status: string }[] = [];

      for (const reserva of reservasHuerfanas) {
        const oldInventarioId = reserva.inventario_id;

        // Buscar si existe un espacio_inventario para este inventario_id
        const nuevoEspacioId = inventarioToEspacio.get(oldInventarioId);

        if (nuevoEspacioId) {
          // Actualizar la reserva con el nuevo espacio_id
          await prisma.reservas.update({
            where: { id: reserva.id },
            data: { inventario_id: nuevoEspacioId }
          });
          arregladas++;
          detalles.push({
            reservaId: reserva.id,
            oldId: oldInventarioId,
            newId: nuevoEspacioId,
            status: 'arreglada'
          });
        } else {
          noEncontradas++;
          detalles.push({
            reservaId: reserva.id,
            oldId: oldInventarioId,
            newId: null,
            status: 'no_encontrada'
          });
        }
      }

      console.log(`[arreglarReservas] Arregladas: ${arregladas}, No encontradas: ${noEncontradas}`);

      res.json({
        success: true,
        message: `Se procesaron ${reservasHuerfanas.length} reservas huérfanas`,
        data: {
          total_reservas: todasReservas.length,
          huerfanas_encontradas: reservasHuerfanas.length,
          arregladas,
          no_encontradas: noEncontradas,
          detalle: detalles.slice(0, 50) // Solo mostrar las primeras 50 para no sobrecargar
        }
      });
    } catch (error) {
      console.error('Error en arreglarReservasHuerfanas:', error);
      const message = error instanceof Error ? error.message : 'Error al arreglar reservas';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  /**
   * Obtener espacios disponibles de un inventario digital
   * Retorna los espacios que NO están reservados en el período dado
   */
  async getEspaciosDisponibles(req: AuthRequest, res: Response): Promise<void> {
    try {
      const inventarioId = parseInt(req.params.id);
      const { fecha_inicio, fecha_fin, solicitudCaraId } = req.query;

      // Obtener todos los espacios del inventario
      const espacios = await prisma.espacio_inventario.findMany({
        where: { inventario_id: inventarioId }
      });

      if (espacios.length === 0) {
        res.json({
          success: true,
          data: {
            total_espacios: 0,
            disponibles: 0,
            reservados: 0,
            espacios: []
          }
        });
        return;
      }

      // Obtener calendarios del período
      let reservadosIds: Set<number> = new Set();

      if (fecha_inicio && fecha_fin) {
        const calendarios = await prisma.calendario.findMany({
          where: {
            OR: [
              { fecha_inicio: { lte: new Date(fecha_fin as string), gte: new Date(fecha_inicio as string) } },
              { fecha_fin: { lte: new Date(fecha_fin as string), gte: new Date(fecha_inicio as string) } },
              { AND: [{ fecha_inicio: { lte: new Date(fecha_inicio as string) } }, { fecha_fin: { gte: new Date(fecha_fin as string) } }] }
            ]
          },
          select: { id: true }
        });

        const calendarioIds = calendarios.map(c => c.id);

        if (calendarioIds.length > 0) {
          const reservas = await prisma.reservas.findMany({
            where: {
              deleted_at: null,
              calendario_id: { in: calendarioIds },
              inventario_id: { in: espacios.map(e => e.id) },
              estatus: { in: ['Reservado', 'Bonificado', 'Vendido'] }
            },
            select: { inventario_id: true }
          });
          reservadosIds = new Set(reservas.map(r => r.inventario_id));
        }
      }

      // También excluir los ya reservados para esta cara específica
      if (solicitudCaraId) {
        const existingReservas = await prisma.reservas.findMany({
          where: {
            deleted_at: null,
            solicitudCaras_id: parseInt(solicitudCaraId as string),
            inventario_id: { in: espacios.map(e => e.id) }
          },
          select: { inventario_id: true }
        });
        existingReservas.forEach(r => reservadosIds.add(r.inventario_id));
      }

      const espaciosConEstado = espacios.map(esp => ({
        ...esp,
        disponible: !reservadosIds.has(esp.id)
      }));

      const disponibles = espaciosConEstado.filter(e => e.disponible).length;

      res.json({
        success: true,
        data: {
          total_espacios: espacios.length,
          disponibles,
          reservados: espacios.length - disponibles,
          espacios: espaciosConEstado
        }
      });
    } catch (error) {
      console.error('Error en getEspaciosDisponibles:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener espacios';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }
  // Create a new inventario
  async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      const data = req.body;
      const inventario = await prisma.inventarios.create({
        data: {
          codigo_unico: data.codigo_unico || null,
          ubicacion: data.ubicacion || null,
          tipo_de_cara: data.tipo_de_cara || null,
          cara: data.cara || null,
          mueble: data.mueble || null,
          latitud: parseFloat(data.latitud) || 0,
          longitud: parseFloat(data.longitud) || 0,
          plaza: data.plaza || null,
          estado: data.estado || null,
          municipio: data.municipio || null,
          cp: data.cp ? parseInt(data.cp) : null,
          tradicional_digital: data.tradicional_digital || null,
          sentido: data.sentido || null,
          tipo_de_mueble: data.tipo_de_mueble || null,
          ancho: parseFloat(data.ancho) || 0,
          alto: parseFloat(data.alto) || 0,
          nivel_socioeconomico: data.nivel_socioeconomico || null,
          total_espacios: data.total_espacios ? parseInt(data.total_espacios) : null,
          estatus: data.estatus || 'Disponible',
          codigo: data.codigo || null,
          isla: data.isla || null,
          mueble_isla: data.mueble_isla || null,
          entre_calle_1: data.entre_calle_1 || null,
          entre_calle_2: data.entre_calle_2 || null,
          orientacion: data.orientacion || null,
          tarifa_piso: data.tarifa_piso ? parseFloat(data.tarifa_piso) : null,
          tarifa_publica: data.tarifa_publica ? parseFloat(data.tarifa_publica) : null,
        },
      });
      res.json({ success: true, data: inventario });
    } catch (error) {
      console.error('Error creating inventario:', error);
      const message = error instanceof Error ? error.message : 'Error al crear inventario';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Update an existing inventario
  async update(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = parseInt(req.params.id);
      const data = req.body;

      const updateData: Record<string, unknown> = {};
      if (data.codigo_unico !== undefined) updateData.codigo_unico = data.codigo_unico || null;
      if (data.ubicacion !== undefined) updateData.ubicacion = data.ubicacion || null;
      if (data.tipo_de_cara !== undefined) updateData.tipo_de_cara = data.tipo_de_cara || null;
      if (data.cara !== undefined) updateData.cara = data.cara || null;
      if (data.mueble !== undefined) updateData.mueble = data.mueble || null;
      if (data.latitud !== undefined) updateData.latitud = parseFloat(data.latitud) || 0;
      if (data.longitud !== undefined) updateData.longitud = parseFloat(data.longitud) || 0;
      if (data.plaza !== undefined) updateData.plaza = data.plaza || null;
      if (data.estado !== undefined) updateData.estado = data.estado || null;
      if (data.municipio !== undefined) updateData.municipio = data.municipio || null;
      if (data.cp !== undefined) updateData.cp = data.cp ? parseInt(data.cp) : null;
      if (data.tradicional_digital !== undefined) updateData.tradicional_digital = data.tradicional_digital || null;
      if (data.sentido !== undefined) updateData.sentido = data.sentido || null;
      if (data.tipo_de_mueble !== undefined) updateData.tipo_de_mueble = data.tipo_de_mueble || null;
      if (data.ancho !== undefined) updateData.ancho = parseFloat(data.ancho) || 0;
      if (data.alto !== undefined) updateData.alto = parseFloat(data.alto) || 0;
      if (data.nivel_socioeconomico !== undefined) updateData.nivel_socioeconomico = data.nivel_socioeconomico || null;
      if (data.total_espacios !== undefined) updateData.total_espacios = data.total_espacios ? parseInt(data.total_espacios) : null;
      if (data.estatus !== undefined) updateData.estatus = data.estatus || null;
      if (data.codigo !== undefined) updateData.codigo = data.codigo || null;
      if (data.isla !== undefined) updateData.isla = data.isla || null;
      if (data.mueble_isla !== undefined) updateData.mueble_isla = data.mueble_isla || null;
      if (data.entre_calle_1 !== undefined) updateData.entre_calle_1 = data.entre_calle_1 || null;
      if (data.entre_calle_2 !== undefined) updateData.entre_calle_2 = data.entre_calle_2 || null;
      if (data.orientacion !== undefined) updateData.orientacion = data.orientacion || null;
      if (data.tarifa_piso !== undefined) updateData.tarifa_piso = data.tarifa_piso ? parseFloat(data.tarifa_piso) : null;
      if (data.tarifa_publica !== undefined) updateData.tarifa_publica = data.tarifa_publica ? parseFloat(data.tarifa_publica) : null;

      const inventario = await prisma.inventarios.update({
        where: { id },
        data: updateData,
      });
      res.json({ success: true, data: inventario });
    } catch (error) {
      console.error('Error updating inventario:', error);
      const message = error instanceof Error ? error.message : 'Error al actualizar inventario';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Toggle block/unblock inventario
  async toggleBlock(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = parseInt(req.params.id);
      const inventario = await prisma.inventarios.findUnique({ where: { id } });
      if (!inventario) {
        res.status(404).json({ success: false, error: 'Inventario no encontrado' });
        return;
      }
      const newEstatus = inventario.estatus === 'Bloqueado' ? 'Disponible' : 'Bloqueado';
      const updated = await prisma.inventarios.update({
        where: { id },
        data: { estatus: newEstatus },
      });
      res.json({ success: true, data: updated });
    } catch (error) {
      console.error('Error toggling block:', error);
      const message = error instanceof Error ? error.message : 'Error al bloquear/desbloquear inventario';
      res.status(500).json({ success: false, error: message });
    }
  }
}

export const inventariosController = new InventariosController();
