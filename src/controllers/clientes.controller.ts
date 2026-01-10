import { Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';

const SAP_API_URL = process.env.SAP_API_URL || 'https://binding-convinced-ride-foto.trycloudflare.com';

// Cache for SAP data (15 minutes)
let sapCache: { data: unknown[]; timestamp: number } | null = null;
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

      // Check if CUIC already exists
      if (clienteData.CUIC) {
        const existing = await prisma.cliente.findFirst({
          where: { CUIC: clienteData.CUIC },
        });

        if (existing) {
          res.status(400).json({
            success: false,
            error: 'Ya existe un cliente con este CUIC',
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
        },
      });

      res.status(201).json({
        success: true,
        data: cliente,
        message: 'Cliente agregado exitosamente',
      });
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
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al eliminar cliente';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }
}

export const clientesController = new ClientesController();
