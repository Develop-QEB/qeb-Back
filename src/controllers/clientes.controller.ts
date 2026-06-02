import { Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';
import { emitToClientes, emitToDashboard, SOCKET_EVENTS } from '../config/socket';

const SAP_API_URL = process.env.SAP_API_URL || 'https://binding-convinced-ride-foto.trycloudflare.com';

// SAP endpoints por base de datos
const SAP_ENDPOINTS: Record<string, string> = {
  CIMU: '/cuic',
  TEST: '/cuic-test',
  TRADE: '/cuic-trade',
};

// Cache por base de datos SAP (15 minutes)
const sapCaches: Record<string, { data: unknown[]; timestamp: number }> = {};
let sapCache: { data: unknown[]; timestamp: number } | null = null; // legacy
const CACHE_DURATION = 15 * 60 * 1000; // 15 minutes

export class ClientesController {
  // Get paginated clients
  async getAll(req: AuthRequest, res: Response): Promise<void> {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const search = req.query.search as string;

      const where: Record<string, unknown> = {};

      if (search) {
        where.OR = [
          { T0_U_Cliente: { contains: search } },
          { T0_U_RazonSocial: { contains: search } },
          { T2_U_Marca: { contains: search } },
          { CUIC: !isNaN(parseInt(search)) ? parseInt(search) : undefined },
        ].filter(Boolean);
      }

      const [clientes, total] = await Promise.all([
        prisma.cliente.findMany({
          where,
          skip: (page - 1) * limit,
          take: limit,
          orderBy: { CUIC: 'desc' },
        }),
        prisma.cliente.count({ where }),
      ]);

      res.json({
        success: true,
        data: clientes,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener clientes';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Get ALL clients without pagination (for filtering/grouping)
  async getAllFull(req: AuthRequest, res: Response): Promise<void> {
    try {
      const search = req.query.search as string;

      const where: Record<string, unknown> = {};

      if (search) {
        where.OR = [
          { T0_U_Cliente: { contains: search } },
          { T0_U_RazonSocial: { contains: search } },
          { T2_U_Marca: { contains: search } },
          { CUIC: !isNaN(parseInt(search)) ? parseInt(search) : undefined },
        ].filter(Boolean);
      }

      const clientes = await prisma.cliente.findMany({
        where,
        orderBy: { CUIC: 'desc' },
      });

      res.json({
        success: true,
        data: clientes,
        total: clientes.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener clientes';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getStats(_req: AuthRequest, res: Response): Promise<void> {
    try {
      // Get more detailed stats for better KPIs
      const [total, agenciasData, marcasData, categoriasData] = await Promise.all([
        prisma.cliente.count(),
        prisma.cliente.groupBy({
          by: ['T0_U_Agencia'],
          _count: { T0_U_Agencia: true },
          where: {
            T0_U_Agencia: {
              not: null,
            }
          },
          orderBy: { _count: { T0_U_Agencia: 'desc' } },
        }),
        prisma.cliente.groupBy({
          by: ['T2_U_Marca'],
          _count: { T2_U_Marca: true },
          where: {
            T2_U_Marca: {
              not: null,
            }
          },
          orderBy: { _count: { T2_U_Marca: 'desc' } },
        }),
        prisma.cliente.groupBy({
          by: ['T2_U_Categoria'],
          _count: { T2_U_Categoria: true },
          where: {
            T2_U_Categoria: {
              not: null,
            }
          },
          orderBy: { _count: { T2_U_Categoria: 'desc' } },
        }),
      ]);

      // Filter out empty values for agencias
      const filteredAgencias = agenciasData.filter(a => {
        const nombre = (a.T0_U_Agencia || '').trim();
        return nombre && nombre !== '-';
      });

      // Filter out empty values for marcas
      const filteredMarcas = marcasData.filter(m => {
        const nombre = (m.T2_U_Marca || '').trim();
        return nombre && nombre !== '-';
      });

      // Filter out sin categoria variants
      const sinCategoriaVariants = ['sin categoria', 'sin categoría', 'sin categorìa', 'sincategoria', '-', ''];
      const filteredCategorias = categoriasData.filter(c => {
        const nombre = (c.T2_U_Categoria || '').toLowerCase().trim();
        return nombre && !sinCategoriaVariants.includes(nombre);
      });

      // Top 5 agencias for chart
      const topAgencias = filteredAgencias.slice(0, 5).map(a => ({
        nombre: a.T0_U_Agencia || '',
        cantidad: a._count.T0_U_Agencia,
      }));

      // Top 5 marcas for chart
      const topMarcas = filteredMarcas.slice(0, 5).map(m => ({
        nombre: m.T2_U_Marca || '',
        cantidad: m._count.T2_U_Marca,
      }));

      // Categorias for donut
      const categoriasDistribution = filteredCategorias
        .slice(0, 6)
        .map(c => ({
          nombre: c.T2_U_Categoria || '',
          cantidad: c._count.T2_U_Categoria,
        }));

      console.log('Stats debug:', {
        total,
        rawAgencias: agenciasData.length,
        rawMarcas: marcasData.length,
        rawCategorias: categoriasData.length,
        categoriasRaw: categoriasData.slice(0, 10).map(c => c.T2_U_Categoria),
        agenciasFiltered: filteredAgencias.length,
        marcasFiltered: filteredMarcas.length,
        categoriasFiltered: filteredCategorias.length,
      });

      res.json({
        success: true,
        data: {
          total,
          agencias: filteredAgencias.length,
          marcas: filteredMarcas.length,
          categorias: filteredCategorias.length,
          topAgencias,
          topMarcas,
          categoriaDistribution: categoriasDistribution,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener estadisticas';
      console.error('getStats error:', error);
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getFilterOptions(_req: AuthRequest, res: Response): Promise<void> {
    try {
      // Use groupBy instead of distinct to avoid orderBy conflicts
      const [agenciasRaw, marcasRaw, categoriasRaw] = await Promise.all([
        prisma.cliente.groupBy({
          by: ['T0_U_Agencia'],
          where: {
            T0_U_Agencia: { not: null },
          },
        }),
        prisma.cliente.groupBy({
          by: ['T2_U_Marca'],
          where: {
            T2_U_Marca: { not: null },
          },
        }),
        prisma.cliente.groupBy({
          by: ['T2_U_Categoria'],
          where: {
            T2_U_Categoria: { not: null },
          },
        }),
      ]);

      // Filter, clean, and sort values
      const cleanAgencias = agenciasRaw
        .map(a => a.T0_U_Agencia?.trim())
        .filter((v): v is string => !!v && v !== '-' && v !== '')
        .sort((a, b) => a.localeCompare(b));

      const cleanMarcas = marcasRaw
        .map(m => m.T2_U_Marca?.trim())
        .filter((v): v is string => !!v && v !== '-' && v !== '')
        .sort((a, b) => a.localeCompare(b));

      // Filter out "sin categoria" variants
      const sinCategoriaVariants = ['sin categoria', 'sin categoría', 'sin categorìa', 'sincategoria', '-', ''];
      const cleanCategorias = categoriasRaw
        .map(c => c.T2_U_Categoria?.trim())
        .filter((v): v is string => !!v && !sinCategoriaVariants.includes(v.toLowerCase()))
        .sort((a, b) => a.localeCompare(b));

      console.log('Filter options:', {
        agencias: cleanAgencias.length,
        marcas: cleanMarcas.length,
        categorias: cleanCategorias.length,
      });

      res.json({
        success: true,
        data: {
          agencias: cleanAgencias,
          marcas: cleanMarcas,
          categorias: cleanCategorias,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener opciones de filtro';
      console.error('getFilterOptions error:', error);
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getById(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const cliente = await prisma.cliente.findUnique({
        where: { id: parseInt(id) },
      });

      if (!cliente) {
        res.status(404).json({
          success: false,
          error: 'Cliente no encontrado',
        });
        return;
      }

      res.json({
        success: true,
        data: cliente,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener cliente';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getByCUIC(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { cuic } = req.params;

      const clientes = await prisma.cliente.findMany({
        where: { CUIC: parseInt(cuic) },
      });

      res.json({
        success: true,
        data: clientes,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener cliente';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  /**
   * Resuelve un `cliente.id` (PK local) a partir del CUIC + sap_database opcional.
   * El front muchas veces solo tiene el SAPCuicItem (CUIC), pero los endpoints de
   * solicitud/propuesta/campaña esperan `cliente.id` (PK), no CUIC (puede duplicarse).
   * Este endpoint hace el lookup local: prefiere match exacto por sap_database,
   * fallback al primer cliente con ese CUIC.
   */
  async resolveByCuic(req: AuthRequest, res: Response): Promise<void> {
    try {
      const cuicRaw = req.query.cuic as string;
      const sapDatabase = req.query.sap_database as string | undefined;
      const cuicNum = parseInt(cuicRaw);
      if (!cuicRaw || isNaN(cuicNum)) {
        res.status(400).json({ success: false, error: 'cuic requerido' });
        return;
      }
      let cliente = null;
      if (sapDatabase) {
        cliente = await prisma.cliente.findFirst({
          where: { CUIC: cuicNum, sap_database: sapDatabase, T0_U_RazonSocial: { not: null } },
          select: { id: true, CUIC: true, sap_database: true, T0_U_RazonSocial: true, T0_U_Cliente: true, card_code: true, salesperson_code: true },
        });
      }
      if (!cliente) {
        cliente = await prisma.cliente.findFirst({
          where: { CUIC: cuicNum, T0_U_RazonSocial: { not: null } },
          select: { id: true, CUIC: true, sap_database: true, T0_U_RazonSocial: true, T0_U_Cliente: true, card_code: true, salesperson_code: true },
        });
      }
      if (!cliente) {
        res.status(404).json({ success: false, error: `Ningún cliente local con CUIC=${cuicNum}` });
        return;
      }
      res.json({ success: true, data: cliente });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error resolviendo cliente por CUIC';
      res.status(500).json({ success: false, error: message });
    }
  }

  async getAllCUICs(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const cuics = await prisma.cliente.findMany({
        select: { CUIC: true },
        where: { CUIC: { not: null } },
        distinct: ['CUIC'],
      });

      res.json({
        success: true,
        data: cuics.map(c => c.CUIC),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener CUICs';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getSAPClientes(req: AuthRequest, res: Response): Promise<void> {
    try {
      let sapClientes: unknown[] = [];

      // Check cache first
      const now = Date.now();
      const useCache = sapCache && (now - sapCache.timestamp) < CACHE_DURATION;

      if (useCache) {
        sapClientes = sapCache!.data;
      } else {
        // Fetch from SAP API
        try {
          console.log('Fetching from SAP API:', `${SAP_API_URL}/cuic`);
          const response = await fetch(`${SAP_API_URL}/cuic`);

          if (response.ok) {
            const sapData = await response.json() as Record<string, unknown>;
            // OData format uses 'value', regular API might use 'data' or be an array
            if (Array.isArray(sapData)) {
              sapClientes = sapData;
            } else if (sapData.value && Array.isArray(sapData.value)) {
              sapClientes = sapData.value;
            } else if (sapData.data && Array.isArray(sapData.data)) {
              sapClientes = sapData.data;
            }
            console.log('SAP data received:', sapClientes.length, 'records');
            // Update cache
            sapCache = { data: sapClientes, timestamp: now };
          } else {
            console.log('SAP API error:', response.status);
            if (sapCache) {
              sapClientes = sapCache.data;
            }
          }
        } catch (err) {
          console.log('SAP fetch error:', err);
          if (sapCache) {
            sapClientes = sapCache.data;
          }
        }
      }

      // Get all CUICs from our database
      const dbCuics = await prisma.cliente.findMany({
        select: { CUIC: true },
        where: { CUIC: { not: null } },
        distinct: ['CUIC'],
      });

      const dbCuicSet = new Set(dbCuics.map(c => c.CUIC));

      // Filter out clients that already exist in our database
      // Sort by CUIC descending (highest CUIC first = newest)
      const filteredClientes = (sapClientes as Array<{ CUIC?: number | null }>)
        .filter((cliente) => cliente.CUIC != null && !dbCuicSet.has(cliente.CUIC))
        .sort((a, b) => (b.CUIC || 0) - (a.CUIC || 0));

      // Apply search filter if provided
      const search = req.query.search as string;
      let result = filteredClientes;

      if (search) {
        const searchLower = search.toLowerCase();
        result = filteredClientes.filter((c: Record<string, unknown>) =>
          (c.T0_U_Cliente as string)?.toLowerCase().includes(searchLower) ||
          (c.T0_U_RazonSocial as string)?.toLowerCase().includes(searchLower) ||
          (c.T2_U_Marca as string)?.toLowerCase().includes(searchLower) ||
          String(c.CUIC).includes(search)
        );
      }

      console.log('SAP response:', {
        resultCount: result.length,
        sapTotal: sapClientes.length,
        dbCuicsCount: dbCuics.length,
        cached: useCache,
      });

      res.json({
        success: true,
        data: result,
        total: result.length,
        cached: useCache,
        sapTotal: sapClientes.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener clientes de SAP';
      console.error('getSAPClientes error:', error);
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      const clienteData = req.body;

      // Check if CUIC already exists for this sap_database
      if (clienteData.CUIC) {
        const existing = await prisma.cliente.findFirst({
          where: { CUIC: clienteData.CUIC, sap_database: clienteData.sap_database || null },
        });

        if (existing) {
          res.status(400).json({
            success: false,
            error: `Ya existe un cliente con este CUIC en ${clienteData.sap_database || 'la base de datos'}`,
          });
          return;
        }
      }

      const cliente = await prisma.cliente.create({
        data: {
          CUIC: clienteData.CUIC,
          T0_U_IDAsesor: clienteData.T0_U_IDAsesor,
          T0_U_Asesor: clienteData.T0_U_Asesor,
          T0_U_IDAgencia: clienteData.T0_U_IDAgencia,
          T0_U_Agencia: clienteData.T0_U_Agencia,
          T0_U_Cliente: clienteData.T0_U_Cliente,
          T0_U_RazonSocial: clienteData.T0_U_RazonSocial,
          T0_U_IDACA: clienteData.T0_U_IDACA,
          T1_U_Cliente: clienteData.T1_U_Cliente,
          T1_U_IDACA: clienteData.T1_U_IDACA,
          T1_U_IDCM: clienteData.T1_U_IDCM,
          T1_U_IDMarca: clienteData.T1_U_IDMarca,
          T1_U_UnidadNegocio: clienteData.T1_U_UnidadNegocio,
          T1_U_ValidFrom: clienteData.T1_U_ValidFrom ? new Date(clienteData.T1_U_ValidFrom) : null,
          T1_U_ValidTo: clienteData.T1_U_ValidTo ? new Date(clienteData.T1_U_ValidTo) : null,
          T2_U_IDCategoria: clienteData.T2_U_IDCategoria,
          T2_U_Categoria: clienteData.T2_U_Categoria,
          T2_U_IDCM: clienteData.T2_U_IDCM,
          T2_U_IDProducto: clienteData.T2_U_IDProducto,
          T2_U_Marca: clienteData.T2_U_Marca,
          T2_U_Producto: clienteData.T2_U_Producto,
          T2_U_ValidFrom: clienteData.T2_U_ValidFrom ? new Date(clienteData.T2_U_ValidFrom) : null,
          T2_U_ValidTo: clienteData.T2_U_ValidTo ? new Date(clienteData.T2_U_ValidTo) : null,
          sap_database: clienteData.sap_database || null,
          card_code: clienteData.card_code || clienteData.ACA_U_SAPCode || null,
          salesperson_code: clienteData.salesperson_code || clienteData.ASESOR_U_SAPCode_Original || null,
        },
      });

      res.status(201).json({
        success: true,
        data: cliente,
        message: 'Cliente agregado exitosamente',
      });

      // Emitir evento WebSocket
      const userName = req.user?.nombre || 'Usuario';
      emitToClientes(SOCKET_EVENTS.CLIENTE_CREADO, {
        cliente,
        usuario: userName,
      });
      emitToDashboard(SOCKET_EVENTS.DASHBOARD_UPDATED, { tipo: 'cliente', accion: 'creado' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al crear cliente';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async delete(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const cliente = await prisma.cliente.findUnique({
        where: { id: parseInt(id) },
      });

      if (!cliente) {
        res.status(404).json({
          success: false,
          error: 'Cliente no encontrado',
        });
        return;
      }

      await prisma.cliente.delete({
        where: { id: parseInt(id) },
      });

      res.json({
        success: true,
        message: 'Cliente eliminado exitosamente',
      });

      // Emitir evento WebSocket
      const userName = req.user?.nombre || 'Usuario';
      emitToClientes(SOCKET_EVENTS.CLIENTE_ELIMINADO, {
        clienteId: parseInt(id),
        usuario: userName,
      });
      emitToDashboard(SOCKET_EVENTS.DASHBOARD_UPDATED, { tipo: 'cliente', accion: 'eliminado' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al eliminar cliente';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Get SAP clients by specific database (CIMU, TEST, TRADE)
  async getSAPClientesByDatabase(req: AuthRequest, res: Response): Promise<void> {
    try {
      const database = (req.params.database || 'CIMU').toUpperCase();
      if (!['CIMU', 'TEST', 'TRADE'].includes(database)) {
        res.status(400).json({ success: false, error: 'Database must be CIMU, TEST, or TRADE' });
        return;
      }

      let sapClientes: unknown[] = [];
      const now = Date.now();
      const cache = sapCaches[database];
      const useCache = cache && (now - cache.timestamp) < CACHE_DURATION;

      if (useCache) {
        console.log(`[SAP ${database}] Using cached data (${cache.data.length} items)`);
        sapClientes = cache.data;
      } else {
        try {
          const endpoint = SAP_ENDPOINTS[database];
          const fullUrl = `${SAP_API_URL}${endpoint}`;
          console.log(`[SAP ${database}] Fetching from: ${fullUrl}`);
          const response = await fetch(fullUrl);
          console.log(`[SAP ${database}] Response status: ${response.status}`);
          if (response.ok) {
            const sapData: any = await response.json();
            if (Array.isArray(sapData)) sapClientes = sapData;
            else if (sapData.value && Array.isArray(sapData.value)) sapClientes = sapData.value;
            else if (sapData.data && Array.isArray(sapData.data)) sapClientes = sapData.data;
            console.log(`[SAP ${database}] Got ${sapClientes.length} items from SAP`);
            sapCaches[database] = { data: sapClientes, timestamp: now };
          } else {
            console.error(`[SAP ${database}] Response not OK: ${response.status} ${response.statusText}`);
            if (cache) sapClientes = cache.data;
          }
        } catch (fetchError) {
          console.error(`[SAP ${database}] Fetch error:`, fetchError);
          if (cache) sapClientes = cache.data;
        }
      }

      // Filter out clients already in local DB for this specific database
      const dbCuics = await prisma.cliente.findMany({
        select: { CUIC: true },
        where: { CUIC: { not: null }, sap_database: database },
        distinct: ['CUIC'],
      });
      const dbCuicSet = new Set(dbCuics.map(c => c.CUIC));
      console.log(`[SAP ${database}] DB has ${dbCuicSet.size} CUICs for ${database}, SAP returned ${sapClientes.length} items`);

      const filteredClientes = (sapClientes as Array<Record<string, unknown>>)
        .filter(c => c.CUIC != null && !dbCuicSet.has(c.CUIC as number))
        .sort((a, b) => ((b.CUIC as number) || 0) - ((a.CUIC as number) || 0));

      // Apply search
      const search = req.query.search as string;
      let result = filteredClientes;
      if (search) {
        const searchLower = search.toLowerCase();
        result = filteredClientes.filter(c =>
          (c.T0_U_Cliente as string)?.toLowerCase().includes(searchLower) ||
          (c.T0_U_RazonSocial as string)?.toLowerCase().includes(searchLower) ||
          (c.T2_U_Marca as string)?.toLowerCase().includes(searchLower) ||
          String(c.CUIC).includes(search)
        );
      }

      res.json({
        success: true,
        data: result,
        total: result.length,
        cached: useCache,
        database,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener clientes de SAP';
      res.status(500).json({ success: false, error: message });
    }
  }

  // ===========================================================================
  // SYNC desde SAP — preview (compara) + apply (actualiza cliente + propaga a
  // solicitudes con ese cliente_id). Solo rol Administrador o DEV.
  // ===========================================================================
  async syncPreview(req: AuthRequest, res: Response): Promise<void> {
    try {
      // 1. Traer SAP de las DBs activas (CIMU + TRADE) con cache.
      const [sapCimu, sapTrade] = await Promise.all([
        fetchSapClientesPorDb('CIMU'),
        fetchSapClientesPorDb('TRADE'),
      ]);
      // Si una DB devuelve 0 rows, asumimos endpoint caído (sesión expirada,
      // 401, etc.) — NO marcamos sus clientes como huérfanos (sería falso
      // positivo). El front muestra warning en vez.
      const dbsNoDisponibles: string[] = [];
      if (sapCimu.length === 0) dbsNoDisponibles.push('CIMU');
      if (sapTrade.length === 0) dbsNoDisponibles.push('TRADE');
      const sapMap = new Map<string, Record<string, unknown>>();
      for (const row of sapCimu) {
        const r = row as Record<string, unknown>;
        const cuic = r.CUIC as number | undefined;
        if (cuic != null) sapMap.set(`CIMU|${cuic}`, r);
      }
      for (const row of sapTrade) {
        const r = row as Record<string, unknown>;
        const cuic = r.CUIC as number | undefined;
        if (cuic != null) sapMap.set(`TRADE|${cuic}`, r);
      }

      // 2. Traer todos los clientes QEB con CUIC + sap_database válidos.
      const qebClientes = await prisma.cliente.findMany({
        where: { CUIC: { not: null } },
      });

      // 3. Comparar.
      const diffs: SyncDiff[] = [];
      let huerfanos = 0;
      let noComparables = 0;
      let conCambios = 0;
      for (const qeb of qebClientes) {
        const db = (qeb.sap_database || '').toUpperCase();
        if (!db || (db !== 'CIMU' && db !== 'TRADE')) continue; // sin db conocido, no comparable
        // Si la DB SAP no respondió, no podemos saber si es huérfano.
        if (dbsNoDisponibles.includes(db)) {
          noComparables++;
          continue;
        }
        const sapRow = sapMap.get(`${db}|${qeb.CUIC}`);
        if (!sapRow) {
          huerfanos++;
          diffs.push({
            cliente_id: qeb.id,
            cuic: qeb.CUIC as number,
            sap_database: qeb.sap_database || '',
            razon_social_actual: qeb.T0_U_RazonSocial,
            es_huerfano: true,
            cambios: {},
          });
          continue;
        }
        const cambios = computeDiffCliente(qeb as unknown as Record<string, unknown>, sapRow as Record<string, unknown>);
        if (Object.keys(cambios).length > 0) {
          conCambios++;
          diffs.push({
            cliente_id: qeb.id,
            cuic: qeb.CUIC as number,
            sap_database: qeb.sap_database || '',
            razon_social_actual: qeb.T0_U_RazonSocial,
            es_huerfano: false,
            cambios,
          });
        }
      }

      res.json({
        success: true,
        summary: {
          total_qeb: qebClientes.length,
          con_cambios: conCambios,
          huerfanos,
          no_comparables: noComparables,
          dbs_no_disponibles: dbsNoDisponibles,
        },
        diffs,
      });
    } catch (error) {
      console.error('syncPreview error:', error);
      const message = error instanceof Error ? error.message : 'Error en sync preview';
      res.status(500).json({ success: false, error: message });
    }
  }

  async syncApply(req: AuthRequest, res: Response): Promise<void> {
    try {
      const clienteId = parseInt(req.params.id, 10);
      if (!clienteId) {
        res.status(400).json({ success: false, error: 'cliente_id inválido' });
        return;
      }

      const qeb = await prisma.cliente.findUnique({ where: { id: clienteId } });
      if (!qeb) {
        res.status(404).json({ success: false, error: 'Cliente no encontrado' });
        return;
      }
      const db = (qeb.sap_database || '').toUpperCase();
      if (qeb.CUIC == null || (db !== 'CIMU' && db !== 'TRADE')) {
        res.status(400).json({ success: false, error: 'Cliente sin CUIC o sap_database válido' });
        return;
      }

      const sapRows = await fetchSapClientesPorDb(db);
      const sapRow = sapRows.find(r => (r as { CUIC?: number }).CUIC === qeb.CUIC);
      if (!sapRow) {
        res.status(404).json({
          success: false,
          error: `Cliente CUIC ${qeb.CUIC} ya no existe en SAP ${db} (huérfano)`,
        });
        return;
      }

      const cambios = computeDiffCliente(qeb as unknown as Record<string, unknown>, sapRow as Record<string, unknown>);
      if (Object.keys(cambios).length === 0) {
        res.json({ success: true, cambios_aplicados: {}, solicitudes_afectadas: 0, mensaje: 'Sin cambios' });
        return;
      }

      // Aplicar al cliente
      const updateCliente: Record<string, unknown> = {};
      for (const [field, val] of Object.entries(cambios)) {
        updateCliente[field] = val.sap;
      }
      await prisma.cliente.update({ where: { id: clienteId }, data: updateCliente });

      // Propagar a solicitudes con ese cliente_id
      const updateSolicitud: Record<string, unknown> = {};
      for (const [field, val] of Object.entries(cambios)) {
        const solField = SOLICITUD_FIELD_MAP[field];
        if (solField) updateSolicitud[solField] = val.sap;
      }
      let solicitudesAfectadas = 0;
      if (Object.keys(updateSolicitud).length > 0) {
        const r = await prisma.solicitud.updateMany({
          where: { cliente_id: clienteId, deleted_at: null },
          data: updateSolicitud,
        });
        solicitudesAfectadas = r.count;
      }

      // Historial
      await prisma.historial.create({
        data: {
          tipo: 'cliente_sync_sap',
          ref_id: clienteId,
          accion: `Sincronizado desde SAP ${db}: ${Object.keys(cambios).length} campo(s)`,
          detalles: JSON.stringify({
            usuario: req.user?.nombre || 'desconocido',
            usuario_id: req.user?.userId,
            cuic: qeb.CUIC,
            sap_database: db,
            cambios,
            solicitudes_afectadas: solicitudesAfectadas,
          }),
        },
      });

      res.json({
        success: true,
        cambios_aplicados: cambios,
        solicitudes_afectadas: solicitudesAfectadas,
      });
    } catch (error) {
      console.error('syncApply error:', error);
      const message = error instanceof Error ? error.message : 'Error en sync apply';
      res.status(500).json({ success: false, error: message });
    }
  }
}

export const clientesController = new ClientesController();

// ===========================================================================
// Helpers de sync (privados, fuera de la clase para reutilización limpia)
// ===========================================================================

interface FieldDef { qeb: keyof import('@prisma/client').Prisma.clienteUncheckedUpdateInput; sap: string | string[]; tipo: 'string' | 'number' }
const SYNC_FIELDS: FieldDef[] = [
  { qeb: 'T0_U_IDAsesor', sap: 'T0_U_IDAsesor', tipo: 'number' },
  { qeb: 'T0_U_Asesor', sap: 'T0_U_Asesor', tipo: 'string' },
  { qeb: 'T0_U_IDAgencia', sap: 'T0_U_IDAgencia', tipo: 'number' },
  { qeb: 'T0_U_Agencia', sap: 'T0_U_Agencia', tipo: 'string' },
  { qeb: 'T0_U_Cliente', sap: 'T0_U_Cliente', tipo: 'string' },
  { qeb: 'T0_U_RazonSocial', sap: 'T0_U_RazonSocial', tipo: 'string' },
  { qeb: 'T0_U_IDACA', sap: 'T0_U_IDACA', tipo: 'number' },
  { qeb: 'T1_U_Cliente', sap: 'T1_U_Cliente', tipo: 'string' },
  { qeb: 'T1_U_IDACA', sap: 'T1_U_IDACA', tipo: 'number' },
  { qeb: 'T1_U_IDCM', sap: 'T1_U_IDCM', tipo: 'number' },
  { qeb: 'T1_U_IDMarca', sap: 'T1_U_IDMarca', tipo: 'number' },
  { qeb: 'T1_U_UnidadNegocio', sap: 'T1_U_UnidadNegocio', tipo: 'string' },
  { qeb: 'T2_U_IDCategoria', sap: 'T2_U_IDCategoria', tipo: 'number' },
  { qeb: 'T2_U_Categoria', sap: 'T2_U_Categoria', tipo: 'string' },
  { qeb: 'T2_U_IDCM', sap: 'T2_U_IDCM', tipo: 'number' },
  { qeb: 'T2_U_IDProducto', sap: 'T2_U_IDProducto', tipo: 'number' },
  { qeb: 'T2_U_Marca', sap: 'T2_U_Marca', tipo: 'string' },
  { qeb: 'T2_U_Producto', sap: 'T2_U_Producto', tipo: 'string' },
  { qeb: 'card_code', sap: 'ACA_U_SAPCode', tipo: 'string' },
  // CIMU sólo expone ASESOR_U_SAPCode; TRADE expone ambos (Original = real, sin map)
  { qeb: 'salesperson_code', sap: ['ASESOR_U_SAPCode_Original', 'ASESOR_U_SAPCode'], tipo: 'number' },
];

// Mapeo cliente.<campo> → solicitud.<campo> para propagar (β)
const SOLICITUD_FIELD_MAP: Record<string, string> = {
  T0_U_RazonSocial: 'razon_social',
  T0_U_Asesor: 'asesor',
  T0_U_Agencia: 'agencia',
  T1_U_UnidadNegocio: 'unidad_negocio',
  T1_U_IDMarca: 'marca_id',
  T2_U_Marca: 'marca_nombre',
  T2_U_IDCategoria: 'categoria_id',
  T2_U_Categoria: 'categoria_nombre',
  T2_U_IDProducto: 'producto_id',
  T2_U_Producto: 'producto_nombre',
  card_code: 'card_code',
  salesperson_code: 'salesperson_code',
};

interface SyncDiff {
  cliente_id: number;
  cuic: number;
  sap_database: string;
  razon_social_actual: string | null;
  es_huerfano: boolean;
  cambios: Record<string, { actual: unknown; sap: unknown }>;
}

// Compara una fila cliente QEB vs un row SAP. Devuelve { field: { actual, sap } }
// solo para los campos que difieren (normalizando null/empty/string<->number).
function computeDiffCliente(qeb: Record<string, unknown>, sap: Record<string, unknown>): Record<string, { actual: unknown; sap: unknown }> {
  const out: Record<string, { actual: unknown; sap: unknown }> = {};
  for (const { qeb: qebField, sap: sapField, tipo } of SYNC_FIELDS) {
    const a = normalize(qeb[qebField as string], tipo);
    const sapKeys = Array.isArray(sapField) ? sapField : [sapField];
    let b: unknown = null;
    for (const k of sapKeys) {
      const candidate = normalize(sap[k], tipo);
      if (candidate != null) { b = candidate; break; }
    }
    if (a !== b) {
      out[qebField as string] = { actual: qeb[qebField as string] ?? null, sap: b };
    }
  }
  return out;
}

function normalize(v: unknown, tipo: 'string' | 'number'): unknown {
  if (v == null || v === '') return null;
  if (tipo === 'number') {
    const n = Number(v);
    return isNaN(n) ? null : n;
  }
  return String(v).trim();
}

async function fetchSapClientesPorDb(database: string): Promise<unknown[]> {
  const cache = sapCaches[database];
  const now = Date.now();
  if (cache && now - cache.timestamp < CACHE_DURATION) return cache.data;
  const endpoint = SAP_ENDPOINTS[database];
  if (!endpoint) return [];
  try {
    const response = await fetch(`${SAP_API_URL}${endpoint}`);
    if (!response.ok) return cache?.data || [];
    const sapData: any = await response.json();
    let arr: unknown[] = [];
    if (Array.isArray(sapData)) arr = sapData;
    else if (sapData.value && Array.isArray(sapData.value)) arr = sapData.value;
    else if (sapData.data && Array.isArray(sapData.data)) arr = sapData.data;
    sapCaches[database] = { data: arr, timestamp: now };
    return arr;
  } catch {
    return cache?.data || [];
  }
}
