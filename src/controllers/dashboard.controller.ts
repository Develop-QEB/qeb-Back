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

// Parametros normalizados para getInventoryDetail. Se comparten entre la
// implementacion legacy y la SQL para poder correr ambas con el mismo input
// desde scripts/validate_inventory_detail_v2.ts.
export type InventoryDetailParams = {
  estados: string[];
  ciudades: string[];
  formatos: string[];
  nses: string[];
  tipos: string[];
  catorcena_id: string | undefined;
  fecha_inicio: string | undefined;
  fecha_fin: string | undefined;
  estatusFiltro: string | undefined;
  pageNum: number;
  limitNum: number;
  skip: number;
  wantCoords: boolean;
};

export type InventoryDetailItem = {
  id: number;
  codigo_unico: string | null;
  plaza: string | null;
  mueble: string | null;
  tipo_de_mueble: string | null;
  tradicional_digital: string | null;
  municipio: string | null;
  estado: string | null;
  latitud: number | null;
  longitud: number | null;
  estatus: string;
  cliente_nombre: string | null;
  cuic: number | null;
  marca: string | null;
  cliente: string | null;
  propuesta_id: number | null;
  nombre_campania: string | null;
  APS: number | null;
  campana_id: number | null;
};

export type InventoryDetailResult = {
  items: InventoryDetailItem[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
  byPlaza: Array<{ plaza: string; count: number; lat: number | null; lng: number | null }>;
  allCoords: Array<{ id: number; lat: number; lng: number; plaza: string | null; estatus: string }>;
};

function parseInventoryDetailParams(req: AuthRequest): InventoryDetailParams {
  const {
    catorcena_id,
    fecha_inicio,
    fecha_fin,
    estatus: estatusFiltro,
    page = '1',
    limit = '50',
    includeCoords,
  } = req.query;

  const pageNum = parseInt(page as string) || 1;
  const limitNum = parseInt(limit as string) || 50;

  return {
    estados: toMultiValue(req.query.estado),
    ciudades: toMultiValue(req.query.ciudad),
    formatos: toMultiValue(req.query.formato),
    nses: toMultiValue(req.query.nse),
    tipos: toMultiValue(req.query.tipo),
    catorcena_id: catorcena_id as string | undefined,
    fecha_inicio: fecha_inicio as string | undefined,
    fecha_fin: fecha_fin as string | undefined,
    estatusFiltro: estatusFiltro as string | undefined,
    pageNum,
    limitNum,
    skip: (pageNum - 1) * limitNum,
    wantCoords: includeCoords === 'true',
  };
}

// Resuelve el rango de fechas al fragmento SQL `AND rsv.calendario_id IN (...)`.
// Se comparte entre las dos implementaciones para garantizar que ambas ven el
// mismo universo de reservas. Preserva el detalle historico: reserva.calendario_id
// puede apuntar a filas de calendario O de catorcenas (los IDs viven en tablas
// distintas pero se juntan aca — es como lo hacia el codigo legacy).
async function resolveCalendarioClauseSql(params: InventoryDetailParams): Promise<string> {
  let fechaInicio: Date | null = null;
  let fechaFin: Date | null = null;

  if (params.catorcena_id) {
    const catorcena = await prisma.catorcenas.findUnique({
      where: { id: parseInt(params.catorcena_id) },
    });
    if (catorcena) {
      fechaInicio = catorcena.fecha_inicio;
      fechaFin = catorcena.fecha_fin;
    }
  } else if (params.fecha_inicio && params.fecha_fin) {
    fechaInicio = new Date(params.fecha_inicio);
    fechaFin = new Date(params.fecha_fin);
  }

  if (!fechaInicio || !fechaFin) return '';

  const [calendarios, catorcenasMatch] = await Promise.all([
    prisma.calendario.findMany({
      where: { deleted_at: null, fecha_inicio: { lte: fechaFin }, fecha_fin: { gte: fechaInicio } },
      select: { id: true },
    }),
    prisma.catorcenas.findMany({
      where: { fecha_inicio: { lte: fechaFin }, fecha_fin: { gte: fechaInicio } },
      select: { id: true },
    }),
  ]);
  const allIds = [...calendarios.map(c => c.id), ...catorcenasMatch.map(c => c.id)];
  if (allIds.length === 0) return '';
  return `AND rsv.calendario_id IN (${allIds.join(',')})`;
}

// Enriquece un lote de items con cliente/campana/marca via la cadena
// solicitudCaras -> cotizacion/propuesta -> campania/solicitud -> cliente.
// Se llama con SOLO los items de la pagina actual (50 tipicos) para que la
// cadena procese pocos IDs en vez de la tabla entera. Refleja exactamente la
// misma logica de resolucion del codigo legacy.
type EnrichmentSource = {
  top_solicitudCaras_id: number | null;
  top_cliente_id: number | null;
};
// Campos COMPARTIDOS por todas las reservas que apuntan al mismo solicitudCaras_id:
// vienen de la cadena propuesta→solicitud→cuic→cliente. Son atributos "de la
// solicitud", no de la reserva individual.
type SolicitudSharedInfo = {
  campana_id: number | null;
  propuesta_id: number | null;
  nombre_campania: string | null;
  cliente_nombre_fallback: string | null;
  cuic: number | null;
  marca: string | null;
  cliente: string | null;
};
type EnrichmentContext = {
  // Info compartida por solicitudCaras_id (marca, cuic, cliente, etc — mismos
  // para cualquier reserva que apunte a esa solicitud).
  solicitudInfoMap: Map<number, SolicitudSharedInfo>;
  // Nombre de cliente por reserva.cliente_id (via cliente.CUIC). Se usa como
  // fuente primaria de cliente_nombre; si el cliente_id no matchea, se
  // fallbackea al cliente_nombre_fallback de la solicitud.
  clienteNombreMap: Map<number, string>;
};
// Bug fix (validation ronda 2): antes esta funcion devolvia un solo Map keyed
// por solicitudCaras_id con APS y cliente_nombre metidos adentro. Eso pisaba
// datos cuando 2+ inventarios distintos tenian reservas apuntando al mismo
// solicitudCaras (caso comun — una campaña cubre varios inventarios). APS y
// cliente_nombre son por-RESERVA, no por-solicitud. Ahora la funcion devuelve
// las 2 fuentes crudas y la resolucion per-item la hace el caller.
async function buildEnrichmentContext(sources: EnrichmentSource[]): Promise<EnrichmentContext> {
  const clienteIdsForFallback = [...new Set(sources.map(s => s.top_cliente_id).filter((id): id is number => !!id && id > 0))];
  const clientesFallbackPromise = clienteIdsForFallback.length > 0
    ? prisma.cliente.findMany({
        where: { CUIC: { in: clienteIdsForFallback } },
        select: { CUIC: true, T0_U_Cliente: true, T0_U_RazonSocial: true },
      })
    : Promise.resolve([]);

  const solicitudCarasIds = [...new Set(sources.map(s => s.top_solicitudCaras_id).filter((id): id is number => !!id))];
  const solicitudCarasList = solicitudCarasIds.length > 0 ? await prisma.solicitudCaras.findMany({
    where: { id: { in: solicitudCarasIds } },
    select: { id: true, idquote: true },
  }) : [];
  const idquoteValues = solicitudCarasList
    .map(sc => parseInt(sc.idquote || ''))
    .filter(v => !isNaN(v));

  const [cotizaciones, propuestas] = await Promise.all([
    idquoteValues.length > 0 ? prisma.cotizacion.findMany({
      where: { id_propuesta: { in: idquoteValues } },
      select: { id: true, id_propuesta: true, nombre_campania: true },
    }) : [],
    idquoteValues.length > 0 ? prisma.propuesta.findMany({
      where: { id: { in: idquoteValues } },
      select: { id: true, solicitud_id: true },
    }) : [],
  ]);
  const cotizacionIds = cotizaciones.map(c => c.id);
  const solicitudIds = [...new Set(propuestas.map(p => p.solicitud_id))];

  const [campanas, solicitudes] = await Promise.all([
    cotizacionIds.length > 0 ? prisma.campania.findMany({
      where: { cotizacion_id: { in: cotizacionIds } },
      select: { id: true, cotizacion_id: true },
    }) : [],
    solicitudIds.length > 0 ? prisma.solicitud.findMany({
      where: { id: { in: solicitudIds } },
      select: { id: true, razon_social: true, cuic: true },
    }) : [],
  ]);

  const idquoteToCotizacion = new Map(cotizaciones.map(c => [c.id_propuesta, c.id]));
  const idquoteToNombreCampania = new Map(cotizaciones.map(c => [c.id_propuesta, c.nombre_campania || '']));
  const cotizacionToCampana = new Map(campanas.map(c => [c.cotizacion_id!, c]));

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
  const solicitudSideInfoMap = new Map(solicitudes.map(s => {
    const cuicNum = parseInt(s.cuic || '');
    const cuicInfo = !isNaN(cuicNum) ? cuicToInfo.get(cuicNum) || null : null;
    return [s.id, {
      cliente_nombre: cuicInfo?.nombre || s.razon_social || null,
      cuic: !isNaN(cuicNum) ? cuicNum : null,
      marca: cuicInfo?.marca || null,
      cliente: cuicInfo?.cliente || null,
    }];
  }));
  const propuestaToSolicitudInfo = new Map(propuestas.map(p => [p.id, solicitudSideInfoMap.get(p.solicitud_id) || null]));

  const solicitudInfoMap = new Map<number, SolicitudSharedInfo>(
    solicitudCarasList.map(sc => {
      const idquote = parseInt(sc.idquote || '');
      const cotizId = idquoteToCotizacion.get(idquote);
      const campana = cotizId !== undefined ? cotizacionToCampana.get(cotizId) : undefined;
      const solInfo = !isNaN(idquote) ? propuestaToSolicitudInfo.get(idquote) : null;
      const nombreCampania = !isNaN(idquote) ? idquoteToNombreCampania.get(idquote) || null : null;
      return [sc.id, {
        campana_id: campana?.id ?? null,
        propuesta_id: !isNaN(idquote) ? idquote : null,
        nombre_campania: nombreCampania,
        cliente_nombre_fallback: solInfo?.cliente_nombre || null,
        cuic: solInfo?.cuic || null,
        marca: solInfo?.marca || null,
        cliente: solInfo?.cliente || null,
      }];
    })
  );

  const clienteNombreMap = new Map<number, string>();
  const clientesFallback = await clientesFallbackPromise;
  for (const cl of clientesFallback) {
    if (cl.CUIC) clienteNombreMap.set(cl.CUIC, cl.T0_U_RazonSocial || cl.T0_U_Cliente || '');
  }

  return { solicitudInfoMap, clienteNombreMap };
}

// Traduce ?estatus=X al set de valores efectivos que deben matchear en la
// respuesta. Mismo mapeo que tiene el .filter() del codigo legacy — cambiarlo
// aca rompe el deep-diff.
function expandEstatusFilter(estatusFiltro: string | undefined): string[] | null {
  if (!estatusFiltro) return null;
  if (estatusFiltro === 'Reservado') return ['Reservado', 'Bonificado'];
  if (estatusFiltro === 'Vendido') return ['Vendido', 'Vendido bonificado', 'Con Arte'];
  return [estatusFiltro];
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

  // Widget: estado de POST a SAP de las campañas aprobadas (cached 10min).
  // Divide en "pendientes por postear" vs "posteadas", cada una con su conteo
  // y su monto ($). Definiciones (mismas que usa el resto del sistema):
  //   - Universo: campañas con status != 'inactiva' (las 'inactiva' son
  //     propuestas no aprobadas — no aplican a POST).
  //   - Posteada: posted_to_sap = 1 (marca la campaña entera). Una campaña con
  //     POST parcial (algunos posted_aps pero posted_to_sap=0) sigue contando
  //     como PENDIENTE porque aún tiene caras sin postear.
  //   - Monto: SUM(solicitudCaras.costo) de la propuesta ligada (misma fuente
  //     que la inversión del listado de campañas).
  // Respeta el filtro de periodo del dashboard (catorcena_id o fecha_inicio/
  // fecha_fin) por solape de fechas de la campaña. Los filtros de inventario
  // (estado/plaza/formato/nse/tipo) no aplican aquí — el POST es a nivel campaña.
  async getPosteoStats(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { catorcena_id, fecha_inicio, fecha_fin } = req.query;
      const cacheKey = `dashboard:posteo:${JSON.stringify({ catorcena_id, fecha_inicio, fecha_fin })}`;

      const data = await cache.getOrSet(cacheKey, async () => {
        // Resolver rango de fechas (igual que el resto de endpoints).
        let fi: Date | null = null;
        let ff: Date | null = null;
        if (catorcena_id) {
          const cat = await prisma.catorcenas.findUnique({ where: { id: parseInt(catorcena_id as string) } });
          if (cat) { fi = cat.fecha_inicio; ff = cat.fecha_fin; }
        } else if (fecha_inicio && fecha_fin) {
          fi = new Date(fecha_inicio as string);
          ff = new Date(fecha_fin as string);
        }

        // Solape de periodo: la campaña se toca con el rango si empieza antes de
        // que el rango termine y termina después de que el rango empiece.
        const periodoClause = fi && ff ? 'AND c.fecha_inicio <= ? AND c.fecha_fin >= ?' : '';
        const periodoParams = fi && ff ? [ff, fi] : [];

        type Row = { posted_to_sap: number | null; monto: number };
        const rows = await prisma.$queryRawUnsafe<Row[]>(
          `
          SELECT c.posted_to_sap AS posted_to_sap,
                 COALESCE(inv.monto, 0) AS monto
          FROM campania c
          INNER JOIN cotizacion cot ON cot.id = c.cotizacion_id
          LEFT JOIN (
            SELECT sc.idquote AS idquote, SUM(sc.costo) AS monto
            FROM solicitudCaras sc
            GROUP BY sc.idquote
          ) inv ON inv.idquote = CAST(cot.id_propuesta AS CHAR) COLLATE utf8mb4_unicode_ci
          WHERE c.status != 'inactiva'
            ${periodoClause}
          `,
          ...periodoParams,
        );

        let pendientesCount = 0, pendientesMonto = 0, posteadasCount = 0, posteadasMonto = 0;
        for (const r of rows) {
          const monto = Number(r.monto) || 0;
          if (r.posted_to_sap === 1) {
            posteadasCount++;
            posteadasMonto += monto;
          } else {
            pendientesCount++;
            pendientesMonto += monto;
          }
        }

        const round2 = (n: number) => Math.round(n * 100) / 100;
        return {
          pendientes: { count: pendientesCount, monto: round2(pendientesMonto) },
          posteadas: { count: posteadasCount, monto: round2(posteadasMonto) },
          total: {
            count: pendientesCount + posteadasCount,
            monto: round2(pendientesMonto + posteadasMonto),
          },
        };
      }, CACHE_TTL.DASHBOARD_STATS);

      res.json({ success: true, data });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Error al obtener estado de posteo';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Obtener inventario detallado con info de campañas/propuestas.
  // Wrapper HTTP: parsea params, cachea y delega en computeInventoryDetailSql.
  // La implementacion legacy se conserva en computeInventoryDetailLegacy para
  // que scripts/validate_inventory_detail_v2.ts pueda hacer deep-diff SQL vs JS.
  async getInventoryDetail(req: AuthRequest, res: Response): Promise<void> {
    try {
      const params = parseInventoryDetailParams(req);
      const cacheKey = CACHE_KEYS.INVENTORY_DETAIL(JSON.stringify(params));
      const data = await cache.getOrSet(
        cacheKey,
        () => this.computeInventoryDetailSql(params),
        CACHE_TTL.INVENTORY_DETAIL,
      );
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

  // Implementacion nueva: mueve el filtrado por estatus_efectivo y la
  // paginacion a MariaDB/MySQL (window function ROW_NUMBER), enriquece solo
  // los ~50 items de la pagina, y computa byPlaza/allCoords/total en Node
  // desde un scan lean (5 columnas) del set filtrado — para preservar la
  // logica de "primer lat/lng no cero por plaza" byte-a-byte con el legacy.
  async computeInventoryDetailSql(params: InventoryDetailParams): Promise<InventoryDetailResult> {
    const calendarioClause = await resolveCalendarioClauseSql(params);

    // Filtros de columna con placeholders parametrizados (no interpolamos strings de query).
    const colFilterParts: string[] = [];
    const colFilterVals: string[] = [];
    const addIn = (col: string, values: string[]) => {
      if (values.length === 0) return;
      const placeholders = values.map(() => '?').join(',');
      colFilterParts.push(values.length === 1 ? `${col} = ?` : `${col} IN (${placeholders})`);
      colFilterVals.push(...values);
    };
    addIn('i.estado', params.estados);
    addIn('i.plaza', params.ciudades);
    addIn('i.mueble', params.formatos);
    addIn('i.nivel_socioeconomico', params.nses);
    addIn('i.tradicional_digital', params.tipos);
    const columnFiltersClause = colFilterParts.length > 0 ? 'AND ' + colFilterParts.join(' AND ') : '';

    const estatusTargets = expandEstatusFilter(params.estatusFiltro);
    const estatusFilterClause = estatusTargets
      ? `AND t.estatus_efectivo IN (${estatusTargets.map(() => '?').join(',')})`
      : '';
    const estatusFilterVals = estatusTargets ?? [];

    // Subquery derivada compartida por items y scan. Calcula estatus_efectivo
    // y la reserva ganadora (top_*) via ROW_NUMBER partitioned by inventario_id.
    // Tie-break por rsv.id ASC para determinismo.
    const filteredSubquery = `
      SELECT
        i.id, i.codigo_unico, i.plaza, i.mueble, i.tipo_de_mueble,
        i.tradicional_digital, i.municipio, i.estado, i.latitud, i.longitud,
        CASE
          WHEN i.estatus = 'Bloqueado' THEN 'Bloqueado'
          WHEN r.top_estatus IS NULL   THEN 'Disponible'
          ELSE r.top_estatus
        END AS estatus_efectivo,
        r.top_solicitudCaras_id, r.top_cliente_id, r.top_APS
      FROM inventarios i
      LEFT JOIN (
        SELECT inventario_id, estatus AS top_estatus,
               cliente_id AS top_cliente_id, APS AS top_APS,
               solicitudCaras_id AS top_solicitudCaras_id
        FROM (
          SELECT ei.inventario_id, rsv.estatus,
                 rsv.cliente_id, rsv.APS, rsv.solicitudCaras_id,
                 ROW_NUMBER() OVER (
                   PARTITION BY ei.inventario_id
                   ORDER BY
                     CASE rsv.estatus
                       WHEN 'Vendido' THEN 5
                       WHEN 'Vendido bonificado' THEN 4
                       WHEN 'Con Arte' THEN 3
                       WHEN 'Reservado' THEN 2
                       WHEN 'Bloqueado' THEN 1
                       ELSE 0
                     END DESC,
                     rsv.id ASC
                 ) AS rn
          FROM reservas rsv
          INNER JOIN espacio_inventario ei ON ei.id = rsv.inventario_id
          WHERE rsv.deleted_at IS NULL
            -- Whitelist EXACTA de los 5 estatus mapeados en el CASE de prioridad.
            -- Reservas fuera de esta lista (ej. Bonificado a secas, o cualquier
            -- estatus futuro no clasificado) NO participan del ranking — igual
            -- que en el legacy, donde prioridad[X] || 0 daba 0 y el mayor-que
            -- estricto nunca las dejaba ganar, colapsando el efectivo a Disponible.
            AND rsv.estatus IN ('Vendido', 'Vendido bonificado', 'Con Arte', 'Reservado', 'Bloqueado')
            ${calendarioClause}
        ) ranked
        WHERE rn = 1
      ) r ON r.inventario_id = i.id
      WHERE 1=1
        ${columnFiltersClause}
    `;

    // Q_items: 50 filas con todos los campos de display + reserva ganadora
    const itemsSql = `
      SELECT * FROM (${filteredSubquery}) t
      WHERE 1=1 ${estatusFilterClause}
      ORDER BY t.id
      LIMIT ? OFFSET ?
    `;
    // Q_scan: id/plaza/lat/lng/estatus del set completo filtrado (5 cols)
    // Ordenado por id para reproducir la logica "primer lat/lng no cero" del legacy.
    const scanSql = `
      SELECT t.id, t.plaza, t.latitud, t.longitud, t.estatus_efectivo
      FROM (${filteredSubquery}) t
      WHERE 1=1 ${estatusFilterClause}
      ORDER BY t.id
    `;

    type ItemRow = {
      id: number;
      codigo_unico: string | null;
      plaza: string | null;
      mueble: string | null;
      tipo_de_mueble: string | null;
      tradicional_digital: string | null;
      municipio: string | null;
      estado: string | null;
      latitud: number | null;
      longitud: number | null;
      estatus_efectivo: string;
      top_solicitudCaras_id: number | null;
      top_cliente_id: number | null;
      top_APS: number | null;
    };
    type ScanRow = {
      id: number;
      plaza: string | null;
      latitud: number | null;
      longitud: number | null;
      estatus_efectivo: string;
    };

    const [itemRows, scanRows] = await Promise.all([
      prisma.$queryRawUnsafe<ItemRow[]>(
        itemsSql,
        ...colFilterVals,
        ...estatusFilterVals,
        params.limitNum,
        params.skip,
      ),
      prisma.$queryRawUnsafe<ScanRow[]>(
        scanSql,
        ...colFilterVals,
        ...estatusFilterVals,
      ),
    ]);

    // Enriquecimiento SOLO para los items paginados (~50). Aca esta la gran
    // reduccion de trabajo: la cadena solicitudCaras→...→cliente antes procesaba
    // TODAS las reservas del set filtrado; ahora procesa 50.
    const enrichmentSources: EnrichmentSource[] = itemRows.map(r => ({
      top_solicitudCaras_id: r.top_solicitudCaras_id,
      top_cliente_id: r.top_cliente_id,
    }));
    const { solicitudInfoMap, clienteNombreMap } = await buildEnrichmentContext(enrichmentSources);

    // Resolucion per-item: APS y cliente_nombre son atributos de la RESERVA
    // ganadora (vienen crudos en r.top_APS y r.top_cliente_id). El resto
    // (marca, cuic, cliente, propuesta_id, nombre_campania, campana_id) es
    // compartido por solicitudCaras_id y sale del solicitudInfoMap.
    const items: InventoryDetailItem[] = itemRows.map(r => {
      const solInfo = r.top_solicitudCaras_id != null ? solicitudInfoMap.get(r.top_solicitudCaras_id) : undefined;
      const clienteNombre = (r.top_cliente_id ? clienteNombreMap.get(r.top_cliente_id) || null : null) || solInfo?.cliente_nombre_fallback || null;
      return {
        id: r.id,
        codigo_unico: r.codigo_unico,
        plaza: r.plaza,
        mueble: r.mueble,
        tipo_de_mueble: r.tipo_de_mueble,
        tradicional_digital: r.tradicional_digital,
        municipio: r.municipio,
        estado: r.estado,
        latitud: r.latitud,
        longitud: r.longitud,
        estatus: r.estatus_efectivo,
        cliente_nombre: clienteNombre,
        cuic: solInfo?.cuic || null,
        marca: solInfo?.marca || null,
        cliente: solInfo?.cliente || null,
        propuesta_id: solInfo?.propuesta_id || null,
        nombre_campania: solInfo?.nombre_campania || null,
        APS: r.top_APS,
        campana_id: solInfo?.campana_id ?? null,
      };
    });

    // total, byPlaza y allCoords derivan del scan lean. La reduce replica el
    // comportamiento exacto del legacy (primer lat/lng NO cero por plaza).
    const total = scanRows.length;
    const totalPages = Math.ceil(total / params.limitNum);

    const byPlazaAcc = scanRows.reduce((acc, inv) => {
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
    }, {} as Record<string, { count: number; lat: number | null; lng: number | null }>);
    const byPlaza = Object.entries(byPlazaAcc)
      .map(([plaza, data]) => ({ plaza, count: data.count, lat: data.lat, lng: data.lng }))
      .sort((a, b) => b.count - a.count);

    const allCoords = params.wantCoords
      ? scanRows
          .filter(inv => inv.latitud && inv.longitud)
          .map(inv => ({
            id: inv.id,
            lat: inv.latitud as number,
            lng: inv.longitud as number,
            plaza: inv.plaza,
            estatus: inv.estatus_efectivo,
          }))
      : [];

    return {
      items,
      pagination: { page: params.pageNum, limit: params.limitNum, total, totalPages },
      byPlaza,
      allCoords,
    };
  }

  // Implementacion legacy: findMany completo de inventarios + priority en JS
  // + slice() en memoria. Se conserva SOLO para validacion side-by-side —
  // no la llama la ruta HTTP. Cuando el deep-diff pase en DEV y MySQL 8, se
  // borra en un commit de cleanup.
  async computeInventoryDetailLegacy(params: InventoryDetailParams): Promise<InventoryDetailResult> {
    const {
      estados, ciudades, formatos, nses, tipos,
      catorcena_id, fecha_inicio, fecha_fin,
      estatusFiltro, pageNum, limitNum, skip, wantCoords,
    } = params;

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

    const inventarios = await prisma.inventarios.findMany({
      where: inventarioWhere,
      select: {
        id: true, codigo_unico: true, plaza: true, mueble: true,
        tipo_de_mueble: true, tradicional_digital: true, municipio: true,
        estado: true, nivel_socioeconomico: true, latitud: true, longitud: true, estatus: true,
      },
    });
    const inventarioIds = inventarios.map(i => i.id);

    let fechaInicio: Date | null = null;
    let fechaFin: Date | null = null;
    if (catorcena_id) {
      const catorcena = await prisma.catorcenas.findUnique({ where: { id: parseInt(catorcena_id) } });
      if (catorcena) { fechaInicio = catorcena.fecha_inicio; fechaFin = catorcena.fecha_fin; }
    } else if (fecha_inicio && fecha_fin) {
      fechaInicio = new Date(fecha_inicio); fechaFin = new Date(fecha_fin);
    }

    let calendarioClause = '';
    if (fechaInicio && fechaFin) {
      const [calendarios, catorcenasMatch] = await Promise.all([
        prisma.calendario.findMany({
          where: { deleted_at: null, fecha_inicio: { lte: fechaFin }, fecha_fin: { gte: fechaInicio } },
          select: { id: true },
        }),
        prisma.catorcenas.findMany({
          where: { fecha_inicio: { lte: fechaFin }, fecha_fin: { gte: fechaInicio } },
          select: { id: true },
        }),
      ]);
      const allIds = [...calendarios.map(c => c.id), ...catorcenasMatch.map(c => c.id)];
      if (allIds.length > 0) calendarioClause = `AND rsv.calendario_id IN (${allIds.join(',')})`;
    }

    type ReservaRaw = { inventario_id: number; estatus: string; cliente_id: number; APS: number | null; solicitudCaras_id: number };
    const inventarioIdsSet = new Set(inventarioIds);
    // ORDER BY rsv.id ASC: hace determinista el tie-break del legacy. Sin esto,
    // MariaDB devuelve reservas en el orden que decida el planner (por join
    // order), y como el reduce usa mayor-que estricto, el "first-seen" depende
    // del orden de la DB. Con el ORDER BY, "first-seen por inventario" = reserva
    // con menor rsv.id — mismo criterio que ROW_NUMBER en computeInventoryDetailSql.
    const allReservas: ReservaRaw[] = await prisma.$queryRawUnsafe(`
      SELECT ei.inventario_id as inventario_id, rsv.estatus, rsv.cliente_id, rsv.APS, rsv.solicitudCaras_id
      FROM reservas rsv
      INNER JOIN espacio_inventario ei ON ei.id = rsv.inventario_id
      WHERE rsv.deleted_at IS NULL
      ${calendarioClause}
      ORDER BY rsv.id ASC
    `);
    const reservas = allReservas.filter(r => inventarioIdsSet.has(Number(r.inventario_id)));

    const solicitudCarasIds = [...new Set(reservas.map(r => r.solicitudCaras_id))];
    const clienteIdsForFallback = [...new Set(reservas.map(r => r.cliente_id).filter(id => id && id > 0))];
    const clientesFallbackPromise = clienteIdsForFallback.length > 0
      ? prisma.cliente.findMany({
          where: { CUIC: { in: clienteIdsForFallback } },
          select: { CUIC: true, T0_U_Cliente: true, T0_U_RazonSocial: true },
        })
      : Promise.resolve([]);

    const solicitudCarasList = solicitudCarasIds.length > 0 ? await prisma.solicitudCaras.findMany({
      where: { id: { in: solicitudCarasIds } },
      select: { id: true, idquote: true },
    }) : [];
    const idquoteValues = solicitudCarasList.map(sc => parseInt(sc.idquote || '')).filter(v => !isNaN(v));

    const [cotizaciones, propuestas] = await Promise.all([
      idquoteValues.length > 0 ? prisma.cotizacion.findMany({
        where: { id_propuesta: { in: idquoteValues } },
        select: { id: true, id_propuesta: true, nombre_campania: true },
      }) : [],
      idquoteValues.length > 0 ? prisma.propuesta.findMany({
        where: { id: { in: idquoteValues } },
        select: { id: true, solicitud_id: true },
      }) : [],
    ]);
    const cotizacionIds = cotizaciones.map(c => c.id);
    const solicitudIds = [...new Set(propuestas.map(p => p.solicitud_id))];

    const [campanas, solicitudes] = await Promise.all([
      cotizacionIds.length > 0 ? prisma.campania.findMany({
        where: { cotizacion_id: { in: cotizacionIds } },
        select: { id: true, cotizacion_id: true },
      }) : [],
      solicitudIds.length > 0 ? prisma.solicitud.findMany({
        where: { id: { in: solicitudIds } },
        select: { id: true, razon_social: true, cuic: true },
      }) : [],
    ]);

    const idquoteToCotizacion = new Map(cotizaciones.map(c => [c.id_propuesta, c.id]));
    const idquoteToNombreCampania = new Map(cotizaciones.map(c => [c.id_propuesta, c.nombre_campania || '']));
    const cotizacionToCampana = new Map(campanas.map(c => [c.cotizacion_id!, c]));

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
    const solicitudInfoMap = new Map(solicitudes.map(s => {
      const cuicNum = parseInt(s.cuic || '');
      const cuicInfo = !isNaN(cuicNum) ? cuicToInfo.get(cuicNum) || null : null;
      return [s.id, {
        cliente_nombre: cuicInfo?.nombre || s.razon_social || null,
        cuic: !isNaN(cuicNum) ? cuicNum : null,
        marca: cuicInfo?.marca || null,
        cliente: cuicInfo?.cliente || null,
      }] as [number, { cliente_nombre: string | null; cuic: number | null; marca: string | null; cliente: string | null }];
    }));
    const propuestaToSolicitudInfo = new Map(propuestas.map(p => [p.id, solicitudInfoMap.get(p.solicitud_id) || null]));

    const solicitudToCampana = new Map(
      solicitudCarasList.map(sc => {
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

    const clienteNombreMap = new Map<number, string>();
    const clientesFallback = await clientesFallbackPromise;
    for (const cl of clientesFallback) {
      if (cl.CUIC) clienteNombreMap.set(cl.CUIC, cl.T0_U_RazonSocial || cl.T0_U_Cliente || '');
    }

    const inventarioInfo: Record<number, {
      estatus: string; cliente_nombre: string | null; cuic: number | null;
      marca: string | null; cliente: string | null; propuesta_id: number | null;
      nombre_campania: string | null; APS: number | null; campana_id: number | null;
      solicitudCaras_id: number;
    }> = {};

    reservas.forEach(r => {
      const invId = Number(r.inventario_id);
      if (!invId) return;
      const current = inventarioInfo[invId];
      const prioridad: Record<string, number> = {
        'Vendido': 5, 'Vendido bonificado': 4, 'Con Arte': 3, 'Reservado': 2, 'Bloqueado': 1,
      };
      const currentPrioridad = current ? (prioridad[current.estatus] || 0) : 0;
      const newPrioridad = prioridad[r.estatus] || 0;
      if (newPrioridad > currentPrioridad) {
        const solInfo = solicitudToCampana.get(r.solicitudCaras_id);
        const clienteNombre = (r.cliente_id ? clienteNombreMap.get(r.cliente_id) || null : null) || solInfo?.cliente_nombre || null;
        inventarioInfo[invId] = {
          estatus: r.estatus, cliente_nombre: clienteNombre,
          cuic: solInfo?.cuic || null, marca: solInfo?.marca || null, cliente: solInfo?.cliente || null,
          propuesta_id: solInfo?.propuesta_id ?? null, nombre_campania: solInfo?.nombre_campania || null,
          APS: r.APS, campana_id: solInfo?.campana_id ?? null, solicitudCaras_id: r.solicitudCaras_id,
        };
      }
    });

    const allResults: InventoryDetailItem[] = inventarios.map(inv => {
      const info = inventarioInfo[inv.id];
      const estatusActual = inv.estatus === 'Bloqueado' ? 'Bloqueado' : info?.estatus || 'Disponible';
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
    }).filter(inv => {
      if (!estatusFiltro) return true;
      if (estatusFiltro === 'Reservado') {
        return inv.estatus === 'Reservado' || inv.estatus === 'Bonificado';
      } else if (estatusFiltro === 'Vendido') {
        return inv.estatus === 'Vendido' || inv.estatus === 'Vendido bonificado' || inv.estatus === 'Con Arte';
      }
      return inv.estatus === estatusFiltro;
    });

    const total = allResults.length;
    const totalPages = Math.ceil(total / limitNum);
    const paginatedResults = allResults.slice(skip, skip + limitNum);

    const allCoords = wantCoords
      ? allResults.filter(inv => inv.latitud && inv.longitud).map(inv => ({
          id: inv.id, lat: inv.latitud as number, lng: inv.longitud as number,
          plaza: inv.plaza, estatus: inv.estatus,
        }))
      : [];

    const byPlaza = Object.entries(allResults.reduce((acc, inv) => {
      const plaza = inv.plaza || 'Sin plaza';
      if (!acc[plaza]) acc[plaza] = { count: 0, lat: inv.latitud, lng: inv.longitud };
      acc[plaza].count++;
      if (!acc[plaza].lat && inv.latitud) { acc[plaza].lat = inv.latitud; acc[plaza].lng = inv.longitud; }
      return acc;
    }, {} as Record<string, { count: number; lat: number | null; lng: number | null }>))
      .map(([plaza, data]) => ({ plaza, count: data.count, lat: data.lat, lng: data.lng }))
      .sort((a, b) => b.count - a.count);

    return {
      items: paginatedResults,
      pagination: { page: pageNum, limit: limitNum, total, totalPages },
      byPlaza,
      allCoords,
    };
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
