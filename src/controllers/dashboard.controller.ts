import { Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';

export class DashboardController {
  // Obtener estadisticas del dashboard con filtros
  async getStats(req: AuthRequest, res: Response): Promise<void> {
    try {
      const {
        estado,
        ciudad,
        formato,
        nse,
        catorcena_id,
        fecha_inicio,
        fecha_fin,
      } = req.query;

      // Construir filtro base para inventarios
      const inventarioWhere: Record<string, unknown> = {};

      if (estado) {
        inventarioWhere.estado = estado as string;
      }

      if (ciudad) {
        inventarioWhere.plaza = ciudad as string;
      }

      if (formato) {
        inventarioWhere.tipo_de_mueble = formato as string;
      }

      if (nse) {
        inventarioWhere.nivel_socioeconomico = nse as string;
      }

      // Obtener todos los inventarios que cumplen los filtros
      const inventariosBase = await prisma.inventarios.findMany({
        where: inventarioWhere,
        select: {
          id: true,
          tipo_de_mueble: true,
          mueble: true,
          municipio: true,
          plaza: true,
          estado: true,
          nivel_socioeconomico: true,
          tradicional_digital: true,
        },
      });

      const inventarioIds = inventariosBase.map((i) => i.id);

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
        inventario_id: { in: inventarioIds },
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

      // Mapear estatus de reserva por inventario
      const inventarioEstatus: Record<number, string> = {};
      reservas.forEach((r) => {
        // Priorizar: Vendido > Reservado > Bloqueado
        const current = inventarioEstatus[r.inventario_id];
        if (r.estatus === 'Vendido') {
          inventarioEstatus[r.inventario_id] = 'Vendido';
        } else if (r.estatus === 'Reservado' && current !== 'Vendido') {
          inventarioEstatus[r.inventario_id] = 'Reservado';
        } else if (r.estatus === 'Bloqueado' && !current) {
          inventarioEstatus[r.inventario_id] = 'Bloqueado';
        }
      });

      // Calcular KPIs
      const total = inventariosBase.length;
      let disponibles = 0;
      let reservados = 0;
      let vendidos = 0;
      let bloqueados = 0;

      inventariosBase.forEach((inv) => {
        const estatus = inventarioEstatus[inv.id];
        if (estatus === 'Vendido') {
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
          const estatusInv = inventarioEstatus[inv.id] || 'Disponible';

          // Si hay filtro de estatus, solo contar ese
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

      // Calcular distribucion por tradicional_digital
      const calcularDistribucionTipo = (estatusFiltro?: string): Array<{ nombre: string; cantidad: number }> => {
        const conteo: Record<string, number> = {};

        inventariosBase.forEach((inv) => {
          const estatusInv = inventarioEstatus[inv.id] || 'Disponible';

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

      res.json({
        success: true,
        data: {
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
        },
      });
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
        estado,
        ciudad,
        formato,
        nse,
        catorcena_id,
        fecha_inicio,
        fecha_fin,
      } = req.query;

      // Construir filtro base para inventarios
      const inventarioWhere: Record<string, unknown> = {};

      if (estado) {
        inventarioWhere.estado = estado as string;
      }

      if (ciudad) {
        inventarioWhere.plaza = ciudad as string;
      }

      if (formato) {
        inventarioWhere.tipo_de_mueble = formato as string;
      }

      if (nse) {
        inventarioWhere.nivel_socioeconomico = nse as string;
      }

      const inventariosBase = await prisma.inventarios.findMany({
        where: inventarioWhere,
        select: {
          id: true,
          tipo_de_mueble: true,
          mueble: true,
          municipio: true,
          plaza: true,
          estado: true,
          nivel_socioeconomico: true,
          tradicional_digital: true,
        },
      });

      const inventarioIds = inventariosBase.map((i) => i.id);

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
        inventario_id: { in: inventarioIds },
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
      reservas.forEach((r) => {
        const current = inventarioEstatus[r.inventario_id];
        if (r.estatus === 'Vendido') {
          inventarioEstatus[r.inventario_id] = 'Vendido';
        } else if (r.estatus === 'Reservado' && current !== 'Vendido') {
          inventarioEstatus[r.inventario_id] = 'Reservado';
        } else if (r.estatus === 'Bloqueado' && !current) {
          inventarioEstatus[r.inventario_id] = 'Bloqueado';
        }
      });

      // Filtrar inventarios por estatus seleccionado
      const inventariosFiltrados = inventariosBase.filter((inv) => {
        const est = inventarioEstatus[inv.id] || 'Disponible';
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

      res.json({
        success: true,
        data: {
          total: inventariosFiltrados.length,
          estatus: estatus_filtro,
          graficas: {
            porMueble: calcularDistribucion('mueble'),
            porTipo: calcularDistribucion('tradicional_digital'),
            porMunicipio: calcularDistribucion('municipio'),
            porPlaza: calcularDistribucion('plaza'),
            porNSE: calcularDistribucion('nivel_socioeconomico'),
          },
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Error al obtener estadisticas';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Obtener opciones para los filtros
  async getFilterOptions(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const [estados, ciudades, formatos, nses, catorcenas] = await Promise.all([
        // Estados
        prisma.inventarios.findMany({
          select: { estado: true },
          distinct: ['estado'],
          where: { estado: { not: null } },
        }),
        // Ciudades/Plazas
        prisma.inventarios.findMany({
          select: { plaza: true },
          distinct: ['plaza'],
          where: { plaza: { not: null } },
        }),
        // Formatos (tipo de mueble)
        prisma.inventarios.findMany({
          select: { tipo_de_mueble: true },
          distinct: ['tipo_de_mueble'],
          where: { tipo_de_mueble: { not: null } },
        }),
        // Nivel Socioeconomico
        prisma.inventarios.findMany({
          select: { nivel_socioeconomico: true },
          distinct: ['nivel_socioeconomico'],
          where: { nivel_socioeconomico: { not: null } },
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

      res.json({
        success: true,
        data: {
          estados: estados.map((e) => e.estado).filter(Boolean).sort(),
          ciudades: ciudades.map((c) => c.plaza).filter(Boolean).sort(),
          formatos: formatos.map((f) => f.tipo_de_mueble).filter(Boolean).sort(),
          nses: nses.map((n) => n.nivel_socioeconomico).filter(Boolean).sort(),
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
        },
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

  // Widget: Actividad reciente
  async getRecentActivity(_req: AuthRequest, res: Response): Promise<void> {
    try {
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

      res.json({
        success: true,
        data: {
          solicitudes: ultimasSolicitudes,
          reservas: ultimasReservas,
          campanas: ultimasCampanas,
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Error al obtener actividad';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Widget: Proximas catorcenas
  async getUpcomingCatorcenas(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const hoy = new Date();
      const catorcenas = await prisma.catorcenas.findMany({
        where: {
          fecha_inicio: { gte: hoy },
        },
        orderBy: { fecha_inicio: 'asc' },
        take: 6,
      });

      res.json({
        success: true,
        data: catorcenas.map((c) => ({
          id: c.id,
          numero: c.numero_catorcena,
          ano: c.a_o,
          fecha_inicio: c.fecha_inicio,
          fecha_fin: c.fecha_fin,
        })),
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

  // Widget: Top clientes por reservas
  async getTopClientes(_req: AuthRequest, res: Response): Promise<void> {
    try {
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

      // Obtener nombres de clientes
      const clienteIds = topClientes.map((c) => c.cliente_id);
      const clientes = await prisma.cliente.findMany({
        where: { id: { in: clienteIds } },
        select: { id: true, T0_U_Cliente: true, T0_U_RazonSocial: true },
      });

      const clienteMap = new Map(clientes.map((c) => [c.id, c]));

      res.json({
        success: true,
        data: topClientes.map((tc) => {
          const cliente = clienteMap.get(tc.cliente_id);
          return {
            id: tc.cliente_id,
            nombre: cliente?.T0_U_Cliente || cliente?.T0_U_RazonSocial || 'Sin nombre',
            totalReservas: Number(tc.total),
          };
        }),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Error al obtener top clientes';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }
}

export const dashboardController = new DashboardController();
