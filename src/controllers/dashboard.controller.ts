import { Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';
import { cache, CACHE_TTL, CACHE_KEYS } from '../utils/cache';

// Convierte un valor de query (string, string[], undefined) a array limpio
// Soporta tanto formato CSV ("a,b,c") como repetido (?x=a&x=b)
function toMultiValue(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .flatMap((v) => String(v).split(','))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

// Construye una cláusula prisma { in: [...] } o equality según el array
function multiClause(values: string[]): unknown {
  if (values.length === 0) return undefined;
  if (values.length === 1) return values[0];
  return { in: values };
}

export class DashboardController {
  // Obtener estadisticas del dashboard con filtros (cached 10min)
  async getStats(req: AuthRequest, res: Response): Promise<void> {
    try {
      const {
        catorcena_id,
        fecha_inicio,
        fecha_fin,
      } = req.query;

      const estados = toMultiValue(req.query.estado);
      const ciudades = toMultiValue(req.query.ciudad);
      const formatos = toMultiValue(req.query.formato);
      const nses = toMultiValue(req.query.nse);
      const tipos = toMultiValue(req.query.tipo);

      // Cache key based on filters
      const cacheKey = CACHE_KEYS.DASHBOARD_STATS(
        JSON.stringify({ estados, ciudades, formatos, nses, tipos, catorcena_id, fecha_inicio, fecha_fin })
      );

      const data = await cache.getOrSet(cacheKey, async () => {
      // Construir filtro base para inventarios
      const inventarioWhere: Record<string, unknown> = {};

      const estadoClause = multiClause(estados);
      if (estadoClause !== undefined) inventarioWhere.estado = estadoClause;

      const ciudadClause = multiClause(ciudades);
      if (ciudadClause !== undefined) inventarioWhere.plaza = ciudadClause;

      const formatoClause = multiClause(formatos);
      if (formatoClause !== undefined) inventarioWhere.mueble = formatoClause;

      const nseClause = multiClause(nses);
      if (nseClause !== undefined) inventarioWhere.nivel_socioeconomico = nseClause;

      const tipoClause = multiClause(tipos);
      if (tipoClause !== undefined) inventarioWhere.tradicional_digital = tipoClause;

      // Obtener todos los inventarios que cumplen los filtros.
      // Los Inactivos son "fantasmas" — quedan en el catálogo pero NO cuentan
      // en KPIs, mapa, distribuciones ni gráficas. Solo se ven en el listado
      // admin de /api/inventarios cuando se filtra explícitamente por estatus.
      inventarioWhere.estatus = { not: 'Inactivo' };
      const inventariosBase = await prisma.inventarios.findMany({
        where: inventarioWhere,
        select: {
          id: true,
          mueble: true,
          municipio: true,
          plaza: true,
          estado: true,
          nivel_socioeconomico: true,
          tradicional_digital: true,
          estatus: true,
        },
      });

      const inventarioIds = inventariosBase.map((i) => i.id);

      // Mapear espacio_inventario -> inventario
      const espacios = await prisma.espacio_inventario.findMany({
        where: { inventario_id: { in: inventarioIds } },
        select: { id: true, inventario_id: true },
      });
      const espacioIds = espacios.map((e) => e.id);
      const espacioToInventario = new Map(espacios.map((e) => [e.id, e.inventario_id]));

      // Construir filtro de fechas para reservas (catorcena o fechas manuales)
      let fechaInicio: Date | null = null;
      let fechaFin: Date | null = null;

      if (catorcena_id) {
        const catorcena = await prisma.catorcenas.findUnique({
          where: { id: parseInt(catorcena_id as string) },
        });
        if (catorcena) {
          fechaInicio = catorcena.fecha_inicio;
          fechaFin = catorcena.fecha_fin;
        }
      } else if (fecha_inicio && fecha_fin) {
        fechaInicio = new Date(fecha_inicio as string);
        fechaFin = new Date(fecha_fin as string);
      }

      // Obtener reservas activas para el periodo
      const reservasWhere: Record<string, unknown> = {
        deleted_at: null,
        inventario_id: { in: espacioIds },
      };

      // Si hay filtro de fecha, buscar reservas en calendarios que coincidan
      if (fechaInicio && fechaFin) {
        const calendarios = await prisma.calendario.findMany({
          where: {
            deleted_at: null,
            fecha_inicio: { lte: fechaFin },
            fecha_fin: { gte: fechaInicio },
          },
          select: { id: true },
        });
        const calendarioIds = calendarios.map((c) => c.id);
        reservasWhere.calendario_id = { in: calendarioIds };
      }

      // Obtener reservas por estatus
      const reservas = await prisma.reservas.findMany({
        where: reservasWhere,
        select: {
          inventario_id: true,
          estatus: true,
        },
      });

      // Mapear estatus de reserva por inventario (via espacio_inventario)
      const inventarioEstatus: Record<number, string> = {};
      const prioridad: Record<string, number> = {
        'Vendido': 5,
        'Vendido bonificado': 4,
        'Con Arte': 3,
        'Reservado': 2,
        'Bloqueado': 1,
      };
      reservas.forEach((r) => {
        const invId = espacioToInventario.get(r.inventario_id);
        if (!invId) return;
        const current = inventarioEstatus[invId];
        const currentPrioridad = current ? (prioridad[current] || 0) : 0;
        const newPrioridad = prioridad[r.estatus] || 0;

        if (newPrioridad > currentPrioridad) {
          inventarioEstatus[invId] = r.estatus;
        }
      });

      // Estatus efectivo: Bloqueado del inventario manda sobre cualquier reserva,
      // luego prevalece el estatus de reserva (Vendido/Reservado/etc), default Disponible
      const getEstatusEfectivo = (inv: { id: number; estatus: string | null }): string => {
        if (inv.estatus === 'Bloqueado') return 'Bloqueado';
        return inventarioEstatus[inv.id] || 'Disponible';
      };

      // Calcular KPIs
      const total = inventariosBase.length;
      let disponibles = 0;
      let reservados = 0;
      let vendidos = 0;
      let bloqueados = 0;

      inventariosBase.forEach((inv) => {
        const estatus = getEstatusEfectivo(inv);
        if (estatus === 'Vendido' || estatus === 'Vendido bonificado' || estatus === 'Con Arte') {
          vendidos++;
        } else if (estatus === 'Reservado') {
          reservados++;
        } else if (estatus === 'Bloqueado') {
          bloqueados++;
        } else {
          disponibles++;
        }
      });

      // Funcion para calcular distribucion por campo con filtro de estatus
      const calcularDistribucion = (
        campo: keyof (typeof inventariosBase)[0],
        estatusFiltro?: string
      ): Array<{ nombre: string; cantidad: number }> => {
        const conteo: Record<string, number> = {};

        inventariosBase.forEach((inv) => {
          const estatusInv = getEstatusEfectivo(inv);

          if (estatusFiltro && estatusInv !== estatusFiltro) {
            return;
          }

          const valor = inv[campo] as string;
          if (valor) {
            conteo[valor] = (conteo[valor] || 0) + 1;
          }
        });

        return Object.entries(conteo)
          .map(([nombre, cantidad]) => ({ nombre, cantidad }))
          .sort((a, b) => b.cantidad - a.cantidad);
      };

      const calcularDistribucionTipo = (estatusFiltro?: string): Array<{ nombre: string; cantidad: number }> => {
        const conteo: Record<string, number> = {};

        inventariosBase.forEach((inv) => {
          const estatusInv = getEstatusEfectivo(inv);

          if (estatusFiltro && estatusInv !== estatusFiltro) {
            return;
          }

          const valor = (inv as Record<string, unknown>).tradicional_digital as string;
          if (valor) {
            conteo[valor] = (conteo[valor] || 0) + 1;
          }
        });

        return Object.entries(conteo)
          .map(([nombre, cantidad]) => ({ nombre, cantidad }))
          .sort((a, b) => b.cantidad - a.cantidad);
      };

      return {
          kpis: {
            total,
            disponibles,
            reservados,
            vendidos,
            bloqueados,
          },
          graficas: {
            porMueble: calcularDistribucion('mueble'),
            porTipo: calcularDistribucionTipo(),
            porMunicipio: calcularDistribucion('municipio'),
            porPlaza: calcularDistribucion('plaza'),
            porNSE: calcularDistribucion('nivel_socioeconomico'),
          },
      };
      }, CACHE_TTL.DASHBOARD_STATS);

      res.json({ success: true, data });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Error al obtener estadisticas';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Obtener estadisticas filtradas por estatus (para interactividad de KPIs)
  async getStatsByEstatus(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { estatus_filtro } = req.params;
      const {
        catorcena_id,
        fecha_inicio,
        fecha_fin,
      } = req.query;

      const estados = toMultiValue(req.query.estado);
      const ciudades = toMultiValue(req.query.ciudad);
      const formatos = toMultiValue(req.query.formato);
      const nses = toMultiValue(req.query.nse);
      const tipos = toMultiValue(req.query.tipo);

      const cacheKey = `dashboard:stats-estatus:${JSON.stringify({ estatus_filtro, estados, ciudades, formatos, nses, tipos, catorcena_id, fecha_inicio, fecha_fin })}`;

      const data = await cache.getOrSet(cacheKey, async () => {
      // Construir filtro base para inventarios
      const inventarioWhere: Record<string, unknown> = {};

      const estadoClause = multiClause(estados);
      if (estadoClause !== undefined) inventarioWhere.estado = estadoClause;

      const ciudadClause = multiClause(ciudades);
      if (ciudadClause !== undefined) inventarioWhere.plaza = ciudadClause;

      const formatoClause = multiClause(formatos);
      if (formatoClause !== undefined) inventarioWhere.mueble = formatoClause;

      const nseClause = multiClause(nses);
      if (nseClause !== undefined) inventarioWhere.nivel_socioeconomico = nseClause;

      const tipoClause = multiClause(tipos);
      if (tipoClause !== undefined) inventarioWhere.tradicional_digital = tipoClause;

      const inventariosBase = await prisma.inventarios.findMany({
        where: inventarioWhere,
        select: {
          id: true,
          mueble: true,
          municipio: true,
          plaza: true,
          estado: true,
          nivel_socioeconomico: true,
          tradicional_digital: true,
          estatus: true,
        },
      });

      const inventarioIds = inventariosBase.map((i) => i.id);

      // Mapear espacio_inventario -> inventario
      const espacios = await prisma.espacio_inventario.findMany({
        where: { inventario_id: { in: inventarioIds } },
        select: { id: true, inventario_id: true },
      });
      const espacioIds = espacios.map((e) => e.id);
      const espacioToInventario = new Map(espacios.map((e) => [e.id, e.inventario_id]));

      // Filtro de fechas
      let fechaInicio: Date | null = null;
      let fechaFin: Date | null = null;

      if (catorcena_id) {
        const catorcena = await prisma.catorcenas.findUnique({
          where: { id: parseInt(catorcena_id as string) },
        });
        if (catorcena) {
          fechaInicio = catorcena.fecha_inicio;
          fechaFin = catorcena.fecha_fin;
        }
      } else if (fecha_inicio && fecha_fin) {
        fechaInicio = new Date(fecha_inicio as string);
        fechaFin = new Date(fecha_fin as string);
      }

      const reservasWhere: Record<string, unknown> = {
        deleted_at: null,
        inventario_id: { in: espacioIds },
      };

      if (fechaInicio && fechaFin) {
        const calendarios = await prisma.calendario.findMany({
          where: {
            deleted_at: null,
            fecha_inicio: { lte: fechaFin },
            fecha_fin: { gte: fechaInicio },
          },
          select: { id: true },
        });
        const calendarioIds = calendarios.map((c) => c.id);
        reservasWhere.calendario_id = { in: calendarioIds };
      }

      const reservas = await prisma.reservas.findMany({
        where: reservasWhere,
        select: {
          inventario_id: true,
          estatus: true,
        },
      });

      const inventarioEstatus: Record<number, string> = {};
      const prioridadMap: Record<string, number> = {
        'Vendido': 5,
        'Vendido bonificado': 4,
        'Con Arte': 3,
        'Reservado': 2,
        'Bloqueado': 1,
      };
      reservas.forEach((r) => {
        const invId = espacioToInventario.get(r.inventario_id);
        if (!invId) return;
        const current = inventarioEstatus[invId];
        const currentPrioridad = current ? (prioridadMap[current] || 0) : 0;
        const newPrioridad = prioridadMap[r.estatus] || 0;

        if (newPrioridad > currentPrioridad) {
          inventarioEstatus[invId] = r.estatus;
        }
      });

      // Filtrar inventarios por estatus seleccionado
      // Bloqueado del inventario manda sobre cualquier reserva
      const inventariosFiltrados = inventariosBase.filter((inv) => {
        const est = inv.estatus === 'Bloqueado'
          ? 'Bloqueado'
          : inventarioEstatus[inv.id] || 'Disponible';

        if (estatus_filtro === 'Reservado') {
          return est === 'Reservado' || est === 'Bonificado';
        } else if (estatus_filtro === 'Vendido') {
          return est === 'Vendido' || est === 'Vendido bonificado' || est === 'Con Arte';
        }
        return est === estatus_filtro;
      });

      // Calcular distribuciones solo para el estatus filtrado
      const calcularDistribucion = (
        campo: keyof (typeof inventariosFiltrados)[0]
      ): Array<{ nombre: string; cantidad: number }> => {
        const conteo: Record<string, number> = {};

        inventariosFiltrados.forEach((inv) => {
          const valor = inv[campo] as string;
          if (valor) {
            conteo[valor] = (conteo[valor] || 0) + 1;
          }
        });

        return Object.entries(conteo)
          .map(([nombre, cantidad]) => ({ nombre, cantidad }))
          .sort((a, b) => b.cantidad - a.cantidad);
      };

      return {
          total: inventariosFiltrados.length,
          estatus: estatus_filtro,
          graficas: {
            porMueble: calcularDistribucion('mueble'),
            porTipo: calcularDistribucion('tradicional_digital'),
            porMunicipio: calcularDistribucion('municipio'),
            porPlaza: calcularDistribucion('plaza'),
            porNSE: calcularDistribucion('nivel_socioeconomico'),
          },
      };
      }, CACHE_TTL.DASHBOARD_STATS);

      res.json({ success: true, data });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Error al obtener estadisticas';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Obtener opciones para los filtros (con cache de 30 minutos)
  async getFilterOptions(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const data = await cache.getOrSet(
        CACHE_KEYS.FILTER_OPTIONS,
        async () => {
          const [estados, ciudades, formatos, nses, tipos, catorcenas] = await Promise.all([
            // Estados
            prisma.inventarios.findMany({
              select: { estado: true },
              distinct: ['estado'],
              where: { estado: { not: null } },
            }),
            // Ciudades/Plazas (con estado para cascada)
            prisma.inventarios.findMany({
              select: { plaza: true, estado: true },
              distinct: ['plaza', 'estado'],
              where: { plaza: { not: null } },
            }),
            // Formatos con plaza y estado (para cascada)
            prisma.inventarios.findMany({
              select: { mueble: true, plaza: true, estado: true },
              distinct: ['mueble', 'plaza', 'estado'],
              where: { mueble: { not: null } },
            }),
            // NSE con plaza y estado (para cascada)
            prisma.inventarios.findMany({
              select: { nivel_socioeconomico: true, plaza: true, estado: true },
              distinct: ['nivel_socioeconomico', 'plaza', 'estado'],
              where: { nivel_socioeconomico: { not: null } },
            }),
            // Tipos (tradicional_digital)
            prisma.inventarios.findMany({
              select: { tradicional_digital: true },
              distinct: ['tradicional_digital'],
              where: { tradicional_digital: { not: null } },
            }),
            // Catorcenas (ultimos 2 anos)
            prisma.catorcenas.findMany({
              where: {
                a_o: { gte: new Date().getFullYear() - 1 },
              },
              orderBy: [{ a_o: 'desc' }, { numero_catorcena: 'desc' }],
            }),
          ]);

          // Buscar catorcena actual por separado
          const catorcenaActual = await prisma.catorcenas.findFirst({
            where: {
              fecha_inicio: { lte: new Date() },
              fecha_fin: { gte: new Date() },
            },
          });

          return {
            estados: estados.map((e) => e.estado).filter(Boolean).sort(),
            ciudades: ciudades.filter(c => c.plaza).map(c => ({ ciudad: c.plaza!, estado: c.estado || '' })).sort((a, b) => a.ciudad.localeCompare(b.ciudad)),
            formatos: formatos.filter(f => f.mueble).map(f => ({ formato: f.mueble!, estado: f.estado || '', ciudad: f.plaza || '' })),
            nses: nses.filter(n => n.nivel_socioeconomico).map(n => ({ nse: n.nivel_socioeconomico!, estado: n.estado || '', ciudad: n.plaza || '' })),
            tipos: tipos.map((t) => t.tradicional_digital).filter((v): v is string => Boolean(v)).sort(),
            catorcenaActual: catorcenaActual ? {
              id: catorcenaActual.id,
              label: `Cat ${catorcenaActual.numero_catorcena} - ${catorcenaActual.a_o} (Actual)`,
              numero: catorcenaActual.numero_catorcena,
              ano: catorcenaActual.a_o,
              fecha_inicio: catorcenaActual.fecha_inicio,
              fecha_fin: catorcenaActual.fecha_fin,
            } : null,
            catorcenas: catorcenas.map((c) => ({
              id: c.id,
              label: `Cat ${c.numero_catorcena} - ${c.a_o}`,
              numero: c.numero_catorcena,
              ano: c.a_o,
              fecha_inicio: c.fecha_inicio,
              fecha_fin: c.fecha_fin,
            })),
          };
        },
        CACHE_TTL.FILTER_OPTIONS
      );

      res.json({
        success: true,
        data,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Error al obtener opciones';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Widget: Actividad reciente (cached 5min)
  async getRecentActivity(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const data = await cache.getOrSet('dashboard:recent-activity', async () => {
        const [ultimasSolicitudes, ultimasReservas, ultimasCampanas] =
          await Promise.all([
            prisma.solicitud.findMany({
              take: 5,
              orderBy: { fecha: 'desc' },
              where: { deleted_at: null },
              select: {
                id: true,
                descripcion: true,
                status: true,
                fecha: true,
                razon_social: true,
              },
            }),
            prisma.reservas.findMany({
              take: 5,
              orderBy: { fecha_reserva: 'desc' },
              where: { deleted_at: null },
              select: {
                id: true,
                estatus: true,
                fecha_reserva: true,
                inventario_id: true,
              },
            }),
            prisma.campania.findMany({
              take: 5,
              orderBy: { fecha_inicio: 'desc' },
              select: {
                id: true,
                nombre: true,
                status: true,
                fecha_inicio: true,
                fecha_fin: true,
              },
            }),
          ]);

        return {
          solicitudes: ultimasSolicitudes,
          reservas: ultimasReservas,
          campanas: ultimasCampanas,
        };
      }, CACHE_TTL.DASHBOARD_STATS);

      res.json({ success: true, data });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Error al obtener actividad';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Widget: Proximas catorcenas (con cache de 1 hora)
  async getUpcomingCatorcenas(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const data = await cache.getOrSet(
        CACHE_KEYS.CATORCENAS,
        async () => {
          const hoy = new Date();
          const catorcenas = await prisma.catorcenas.findMany({
            where: {
              fecha_inicio: { gte: hoy },
            },
            orderBy: { fecha_inicio: 'asc' },
            take: 6,
          });

          return catorcenas.map((c) => ({
            id: c.id,
            numero: c.numero_catorcena,
            ano: c.a_o,
            fecha_inicio: c.fecha_inicio,
            fecha_fin: c.fecha_fin,
          }));
        },
        CACHE_TTL.CATORCENAS
      );

      res.json({
        success: true,
        data,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Error al obtener catorcenas';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Widget: Top clientes por reservas (cached 10min)
  async getTopClientes(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const data = await cache.getOrSet('dashboard:top-clientes', async () => {
        const topClientes = await prisma.$queryRaw<
          Array<{ cliente_id: number; total: bigint }>
        >`
          SELECT cliente_id, COUNT(*) as total
          FROM reservas
          WHERE deleted_at IS NULL
          GROUP BY cliente_id
          ORDER BY total DESC
          LIMIT 5
        `;

        const clienteIds = topClientes.map((c) => c.cliente_id);
        const clientes = await prisma.cliente.findMany({
          where: { id: { in: clienteIds } },
          select: { id: true, T0_U_Cliente: true, T0_U_RazonSocial: true },
        });

        const clienteMap = new Map(clientes.map((c) => [c.id, c]));

        return topClientes.map((tc) => {
          const cliente = clienteMap.get(tc.cliente_id);
          return {
            id: tc.cliente_id,
            nombre: cliente?.T0_U_Cliente || cliente?.T0_U_RazonSocial || 'Sin nombre',
            totalReservas: Number(tc.total),
          };
        });
      }, CACHE_TTL.DASHBOARD_STATS);

      res.json({ success: true, data });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Error al obtener top clientes';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Obtener inventario detallado con info de campañas/propuestas
  async getInventoryDetail(req: AuthRequest, res: Response): Promise<void> {
    try {
      const {
        catorcena_id,
        fecha_inicio,
        fecha_fin,
        estatus: estatusFiltro,
        page = '1',
        limit = '50',
        includeCoords,
      } = req.query;
      const wantCoords = includeCoords === 'true';

      const estados = toMultiValue(req.query.estado);
      const ciudades = toMultiValue(req.query.ciudad);
      const formatos = toMultiValue(req.query.formato);
      const nses = toMultiValue(req.query.nse);
      const tipos = toMultiValue(req.query.tipo);

      const pageNum = parseInt(page as string) || 1;
      const limitNum = parseInt(limit as string) || 50;
      const skip = (pageNum - 1) * limitNum;

      const cacheKey = CACHE_KEYS.INVENTORY_DETAIL(
        JSON.stringify({ estados, ciudades, formatos, nses, tipos, catorcena_id, fecha_inicio, fecha_fin, estatus: estatusFiltro, page, limit, includeCoords })
      );

      const data = await cache.getOrSet(cacheKey, async () => {
      // Construir filtro base para inventarios
      const inventarioWhere: Record<string, unknown> = {};

      const estadoClause = multiClause(estados);
      if (estadoClause !== undefined) inventarioWhere.estado = estadoClause;

      const ciudadClause = multiClause(ciudades);
      if (ciudadClause !== undefined) inventarioWhere.plaza = ciudadClause;

      const formatoClause = multiClause(formatos);
      if (formatoClause !== undefined) inventarioWhere.mueble = formatoClause;

      const nseClause = multiClause(nses);
      if (nseClause !== undefined) inventarioWhere.nivel_socioeconomico = nseClause;

      const tipoClause = multiClause(tipos);
      if (tipoClause !== undefined) inventarioWhere.tradicional_digital = tipoClause;

      // Obtener TODOS los inventarios para calcular estatus
      const inventarios = await prisma.inventarios.findMany({
        where: inventarioWhere,
        select: {
          id: true,
          codigo_unico: true,
          plaza: true,
          mueble: true,
          tipo_de_mueble: true,
          tradicional_digital: true,
          municipio: true,
          estado: true,
          nivel_socioeconomico: true,
          latitud: true,
          longitud: true,
          estatus: true,
        },
      });

      const inventarioIds = inventarios.map((i) => i.id);

      // Filtro de fechas para calendario
      let fechaInicio: Date | null = null;
      let fechaFin: Date | null = null;

      if (catorcena_id) {
        const catorcena = await prisma.catorcenas.findUnique({
          where: { id: parseInt(catorcena_id as string) },
        });
        if (catorcena) {
          fechaInicio = catorcena.fecha_inicio;
          fechaFin = catorcena.fecha_fin;
        }
      } else if (fecha_inicio && fecha_fin) {
        fechaInicio = new Date(fecha_inicio as string);
        fechaFin = new Date(fecha_fin as string);
      }

      let calendarioClause = '';
      if (fechaInicio && fechaFin) {
        const [calendarios, catorcenasMatch] = await Promise.all([
          prisma.calendario.findMany({
            where: {
              deleted_at: null,
              fecha_inicio: { lte: fechaFin },
              fecha_fin: { gte: fechaInicio },
            },
            select: { id: true },
          }),
          prisma.catorcenas.findMany({
            where: {
              fecha_inicio: { lte: fechaFin },
              fecha_fin: { gte: fechaInicio },
            },
            select: { id: true },
          }),
        ]);
        const allIds = [
          ...calendarios.map(c => c.id),
          ...catorcenasMatch.map(c => c.id),
        ];
        if (allIds.length > 0) {
          calendarioClause = `AND rsv.calendario_id IN (${allIds.join(',')})`;
        }
      }

      // Obtener reservas via raw query (JOIN directo evita IN masivo que MySQL trunca)
      type ReservaRaw = { inventario_id: number; estatus: string; cliente_id: number; APS: number | null; solicitudCaras_id: number };
      const inventarioIdsSet = new Set(inventarioIds);
      const allReservas: ReservaRaw[] = await prisma.$queryRawUnsafe(`
        SELECT
          ei.inventario_id as inventario_id,
          rsv.estatus,
          rsv.cliente_id,
          rsv.APS,
          rsv.solicitudCaras_id
        FROM reservas rsv
        INNER JOIN espacio_inventario ei ON ei.id = rsv.inventario_id
        WHERE rsv.deleted_at IS NULL
        ${calendarioClause}
      `);
      const reservas = allReservas.filter(r => inventarioIdsSet.has(Number(r.inventario_id)));

      // Construir mapa solicitudCaras_id → propuesta_id y campana_id
      const solicitudCarasIds = [...new Set(reservas.map((r) => r.solicitudCaras_id))];
      const solicitudCarasList = solicitudCarasIds.length > 0 ? await prisma.solicitudCaras.findMany({
        where: { id: { in: solicitudCarasIds } },
        select: { id: true, idquote: true },
      }) : [];
      const idquoteValues = solicitudCarasList
        .map((sc) => parseInt(sc.idquote || ''))
        .filter((v) => !isNaN(v));

      // Obtener campana_id via cotizacion (para el link de APS))
      const cotizaciones = idquoteValues.length > 0 ? await prisma.cotizacion.findMany({
        where: { id_propuesta: { in: idquoteValues } },
        select: { id: true, id_propuesta: true, nombre_campania: true },
      }) : [];
      const cotizacionIds = cotizaciones.map((c) => c.id);
      const campanas = cotizacionIds.length > 0 ? await prisma.campania.findMany({
        where: { cotizacion_id: { in: cotizacionIds } },
        select: { id: true, cotizacion_id: true },
      }) : [];
      const idquoteToCotizacion = new Map(cotizaciones.map((c) => [c.id_propuesta, c.id]));
      const idquoteToNombreCampania = new Map(cotizaciones.map((c) => [c.id_propuesta, c.nombre_campania || '']));
      const cotizacionToCampana = new Map(campanas.map((c) => [c.cotizacion_id!, c]));

      // Obtener nombre del cliente via propuesta → solicitud → CUIC → cliente.T2_U_Marca
      const propuestas = idquoteValues.length > 0 ? await prisma.propuesta.findMany({
        where: { id: { in: idquoteValues } },
        select: { id: true, solicitud_id: true },
      }) : [];
      const solicitudIds = [...new Set(propuestas.map((p) => p.solicitud_id))];
      const solicitudes = solicitudIds.length > 0 ? await prisma.solicitud.findMany({
        where: { id: { in: solicitudIds } },
        select: { id: true, razon_social: true, cuic: true },
      }) : [];
      const cuicValues = [...new Set(solicitudes.map(s => parseInt(s.cuic || '')).filter((id): id is number => !isNaN(id) && id > 0))];
      const cuicClientes = cuicValues.length > 0 ? await prisma.cliente.findMany({
        where: { CUIC: { in: cuicValues } },
        select: { CUIC: true, T2_U_Marca: true, T0_U_Cliente: true, T0_U_RazonSocial: true },
      }) : [];
      const cuicToInfo = new Map(cuicClientes.map(c => [c.CUIC!, {
        nombre: c.T2_U_Marca || c.T0_U_Cliente || c.T0_U_RazonSocial || '',
        marca: c.T2_U_Marca || '',
        cliente: c.T0_U_Cliente || '',
      }]));
      const solicitudInfoMap = new Map(solicitudes.map((s) => {
        const cuicNum = parseInt(s.cuic || '');
        const cuicInfo = !isNaN(cuicNum) ? cuicToInfo.get(cuicNum) || null : null;
        return [s.id, {
          cliente_nombre: cuicInfo?.nombre || s.razon_social || null,
          cuic: !isNaN(cuicNum) ? cuicNum : null,
          marca: cuicInfo?.marca || null,
          cliente: cuicInfo?.cliente || null,
        }] as [number, { cliente_nombre: string | null; cuic: number | null; marca: string | null; cliente: string | null }];
      }));
      const propuestaToSolicitudInfo = new Map(propuestas.map((p) => [p.id, solicitudInfoMap.get(p.solicitud_id) || null]));

      // solicitudCaras_id → { campana_id, cliente_nombre, cuic, marca, cliente }
      const solicitudToCampana = new Map(
        solicitudCarasList.map((sc) => {
          const idquote = parseInt(sc.idquote || '');
          const cotizId = idquoteToCotizacion.get(idquote);
          const campana = cotizId !== undefined ? cotizacionToCampana.get(cotizId) : undefined;
          const solInfo = !isNaN(idquote) ? propuestaToSolicitudInfo.get(idquote) : null;
          const nombreCampania = !isNaN(idquote) ? idquoteToNombreCampania.get(idquote) || null : null;
          return [sc.id, {
            campana_id: campana?.id ?? null,
            propuesta_id: !isNaN(idquote) ? idquote : null,
            nombre_campania: nombreCampania,
            cliente_nombre: solInfo?.cliente_nombre || null,
            cuic: solInfo?.cuic || null,
            marca: solInfo?.marca || null,
            cliente: solInfo?.cliente || null,
          }] as [number, { campana_id: number | null; propuesta_id: number | null; nombre_campania: string | null; cliente_nombre: string | null; cuic: number | null; marca: string | null; cliente: string | null }];
        })
      );

      // Fallback: resolver cliente_nombre via cliente_id de la reserva cuando la cadena propuesta→solicitud falla
      const clienteIdsForFallback = [...new Set(reservas.map(r => r.cliente_id).filter(id => id && id > 0))];
      const clienteNombreMap = new Map<number, string>();
      if (clienteIdsForFallback.length > 0) {
        const clientes = await prisma.cliente.findMany({
          where: { CUIC: { in: clienteIdsForFallback } },
          select: { CUIC: true, T0_U_Cliente: true, T0_U_RazonSocial: true },
        });
        for (const cl of clientes) {
          if (cl.CUIC) clienteNombreMap.set(cl.CUIC, cl.T0_U_RazonSocial || cl.T0_U_Cliente || '');
        }
      }

      // Mapear info de reserva por inventario
      const inventarioInfo: Record<number, {
        estatus: string;
        cliente_nombre: string | null;
        cuic: number | null;
        marca: string | null;
        cliente: string | null;
        propuesta_id: number | null;
        nombre_campania: string | null;
        APS: number | null;
        campana_id: number | null;
        solicitudCaras_id: number;
      }> = {};

      reservas.forEach((r) => {
        const invId = Number(r.inventario_id);
        if (!invId) return;
        const current = inventarioInfo[invId];
        const prioridad: Record<string, number> = {
          'Vendido': 5,
          'Vendido bonificado': 4,
          'Con Arte': 3,
          'Reservado': 2,
          'Bloqueado': 1,
        };
        const currentPrioridad = current ? (prioridad[current.estatus] || 0) : 0;
        const newPrioridad = prioridad[r.estatus] || 0;

        if (newPrioridad > currentPrioridad) {
          const solInfo = solicitudToCampana.get(r.solicitudCaras_id);
          const clienteNombre = (r.cliente_id ? clienteNombreMap.get(r.cliente_id) || null : null) || solInfo?.cliente_nombre || null;
          inventarioInfo[invId] = {
            estatus: r.estatus,
            cliente_nombre: clienteNombre,
            cuic: solInfo?.cuic || null,
            marca: solInfo?.marca || null,
            cliente: solInfo?.cliente || null,
            propuesta_id: solInfo?.propuesta_id ?? null,
            nombre_campania: solInfo?.nombre_campania || null,
            APS: r.APS,
            campana_id: solInfo?.campana_id ?? null,
            solicitudCaras_id: r.solicitudCaras_id,
          };
        }
      });

      // Construir resultado con filtro de estatus
      // Bloqueado del inventario manda sobre cualquier reserva
      const allResults = inventarios
        .map((inv) => {
          const info = inventarioInfo[inv.id];
          const estatusActual = inv.estatus === 'Bloqueado'
            ? 'Bloqueado'
            : info?.estatus || 'Disponible';

          return {
            id: inv.id,
            codigo_unico: inv.codigo_unico,
            plaza: inv.plaza,
            mueble: inv.mueble,
            tipo_de_mueble: inv.tipo_de_mueble,
            tradicional_digital: inv.tradicional_digital,
            municipio: inv.municipio,
            estado: inv.estado,
            latitud: inv.latitud,
            longitud: inv.longitud,
            estatus: estatusActual,
            cliente_nombre: info?.cliente_nombre || null,
            cuic: info?.cuic || null,
            marca: info?.marca || null,
            cliente: info?.cliente || null,
            propuesta_id: info?.propuesta_id || null,
            nombre_campania: info?.nombre_campania || null,
            APS: info?.APS || null,
            campana_id: info?.campana_id ?? null,
          };
        })
        .filter((inv) => {
          if (!estatusFiltro) return true;

          // Reservado = solo estatus Reservado o Bonificado (propuestas sin pase a ventas)
          if (estatusFiltro === 'Reservado') {
            return inv.estatus === 'Reservado' || inv.estatus === 'Bonificado';
          } else if (estatusFiltro === 'Vendido') {
            return inv.estatus === 'Vendido' || inv.estatus === 'Vendido bonificado' || inv.estatus === 'Con Arte';
          }
          return inv.estatus === estatusFiltro;
        });

      // Paginación
      const total = allResults.length;
      const totalPages = Math.ceil(total / limitNum);
      const paginatedResults = allResults.slice(skip, skip + limitNum);

      // Coordenadas solo si se solicitan explícitamente (evita respuestas de 1.5MB+)
      const allCoords = wantCoords
        ? allResults
            .filter((inv) => inv.latitud && inv.longitud)
            .map((inv) => ({
              id: inv.id,
              lat: inv.latitud as number,
              lng: inv.longitud as number,
              plaza: inv.plaza,
              estatus: inv.estatus,
            }))
        : [];

      return {
          items: paginatedResults,
          pagination: {
            page: pageNum,
            limit: limitNum,
            total,
            totalPages,
          },
          byPlaza: Object.entries(
            allResults.reduce((acc, inv) => {
              const plaza = inv.plaza || 'Sin plaza';
              if (!acc[plaza]) {
                acc[plaza] = { count: 0, lat: inv.latitud, lng: inv.longitud };
              }
              acc[plaza].count++;
              if (!acc[plaza].lat && inv.latitud) {
                acc[plaza].lat = inv.latitud;
                acc[plaza].lng = inv.longitud;
              }
              return acc;
            }, {} as Record<string, { count: number; lat: number | null; lng: number | null }>)
          ).map(([plaza, data]) => ({
            plaza,
            count: data.count,
            lat: data.lat,
            lng: data.lng,
          })).sort((a, b) => b.count - a.count),
          allCoords,
      };
      }, CACHE_TTL.SHORT); // 2 min cache for inventory detail

      res.json({ success: true, data });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Error al obtener inventario detallado';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Reporte "Pase a ventas": CSV con cada propuesta que cambio a "Pase a ventas",
  // con catorcena, semana ISO, fecha del pase, inversion y quien lo hizo.
  // Lee del historial (tipo='Propuesta', accion='Cambio de estado') — misma
  // fuente que el reporte que se generaba manualmente.
  async getPaseAVentasReport(req: AuthRequest, res: Response): Promise<void> {
    try {
      type Row = {
        fecha_hora: Date;
        propuesta_id: number;
        detalles: string | null;
        periodo_inicio: Date | null;
        periodo_fin: Date | null;
        nombre_campania: string | null;
        tipo_periodo: string | null;
        marca_nombre: string | null;
        asesor: string | null;
        razon_social: string | null;
        inversion: number | null;
        numero_catorcena: number | null;
      };

      const rows = await prisma.$queryRawUnsafe<Row[]>(`
        SELECT h.fecha_hora, h.ref_id AS propuesta_id, h.detalles,
               ct.fecha_inicio AS periodo_inicio, ct.fecha_fin AS periodo_fin,
               ct.nombre_campania, ct.tipo_periodo,
               s.marca_nombre, s.asesor, s.razon_social,
               p.inversion, cat.numero_catorcena
        FROM historial h
          INNER JOIN propuesta p ON p.id = h.ref_id
          LEFT JOIN cotizacion ct ON ct.id_propuesta = p.id
          LEFT JOIN solicitud s ON s.id = p.solicitud_id
          LEFT JOIN catorcenas cat ON ct.fecha_inicio >= cat.fecha_inicio AND ct.fecha_inicio <= cat.fecha_fin
        WHERE h.tipo = 'Propuesta' AND h.accion = 'Cambio de estado'
          AND h.detalles LIKE '%despues":"Pase a ventas"%'
        ORDER BY h.fecha_hora
      `);

      // Semana ISO 8601 (lunes inicio, semana 1 contiene el primer jueves)
      const isoWeek = (d: Date): number => {
        const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
        const day = date.getUTCDay() || 7;
        date.setUTCDate(date.getUTCDate() + 4 - day);
        const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
        return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
      };
      const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
      const fmtFecha = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : '');
      const csvCell = (v: unknown) => {
        const s = v === null || v === undefined ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };

      const header = ['catorcena', 'periodo_inicio', 'periodo_fin', 'fecha_pase', 'semana',
        'dia_semana', 'hora_pase', 'propuesta_id', 'campania', 'marca', 'cliente', 'asesor',
        'tipo_periodo', 'inversion', 'status_antes', 'quien_paso_a_ventas'];
      const lines: string[] = [header.join(',')];

      for (const r of rows) {
        let antes = '';
        let usuario = '';
        let esPaseReal = false;
        try {
          const det = JSON.parse(r.detalles || '{}');
          usuario = det.usuario || '';
          const cambios = Array.isArray(det.cambios) ? det.cambios : [];
          for (const cb of cambios) {
            if (cb.campo === 'Estado' && cb.despues === 'Pase a ventas' && cb.antes !== 'Pase a ventas') {
              antes = cb.antes || '';
              esPaseReal = true;
              break;
            }
          }
        } catch { /* detalle no parseable */ }
        if (!esPaseReal) continue; // descarta re-clicks Pase a ventas -> Pase a ventas

        const fh = new Date(r.fecha_hora);
        const hora = fh.toISOString().slice(11, 16);
        lines.push([
          r.numero_catorcena ?? '',
          fmtFecha(r.periodo_inicio),
          fmtFecha(r.periodo_fin),
          fmtFecha(r.fecha_hora),
          isoWeek(fh),
          DIAS[fh.getDay()],
          hora,
          r.propuesta_id,
          r.nombre_campania ?? '',
          r.marca_nombre ?? '',
          r.razon_social ?? '',
          r.asesor ?? '',
          r.tipo_periodo ?? '',
          r.inversion != null ? Number(r.inversion).toFixed(2) : '0.00',
          antes,
          usuario,
        ].map(csvCell).join(','));
      }

      const hoy = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="pase_a_ventas_${hoy}.csv"`);
      res.send('﻿' + lines.join('\n')); // BOM para que Excel respete acentos
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al generar reporte de pase a ventas';
      res.status(500).json({ success: false, error: message });
    }
  }
}

export const dashboardController = new DashboardController();
