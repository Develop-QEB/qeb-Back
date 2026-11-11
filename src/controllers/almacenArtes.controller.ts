// Endpoints del modulo "Almacen Artes" — Fase 1 MVP (feedback Jos 2026-11-05).
//
//   GET  /almacen-artes                       listado con filtros + stock
//   GET  /almacen-artes/:id/historial         movimientos del arte
//   POST /almacen-artes/:id/entrada-manual    sumar al stock
//   POST /almacen-artes/:id/salida-manual     restar del stock
//   POST /almacen-artes/:id/alta-inicial      setear cantidad inicial
//
// :id = biblioteca_artes.id

import { Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';
import { hasFullVisibility, hasTeamVisibility, getTeamMemberIds, getVisibleCampanaIds } from '../utils/permissions';
import { registrarMovimiento } from '../services/almacenArtes.service';

// Roles que pueden gestionar manualmente el almacen (entradas/salidas).
// Los demas roles solo pueden ver el listado.
const ROLES_GESTION_ALMACEN = new Set([
  'Administrador',
  'DEV',
  'Coordinador de Trafico',
  'Especialista de trafico',
  'Auxiliar de trafico',
  'Director Comercial',
  'Director General',
]);

function puedeGestionarAlmacen(rol?: string | null): boolean {
  return !!rol && ROLES_GESTION_ALMACEN.has(rol);
}

export class AlmacenArtesController {
  // GET /almacen-artes?campania_id=&cliente_id=&asesor_id=&search=&estatus_operaciones=
  async list(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      const rol = req.user?.rol || '';
      if (!userId) { res.status(401).json({ success: false, error: 'No autenticado' }); return; }

      const search = (req.query.search as string || '').trim();
      const campaniaFilter = req.query.campania_id ? Number(req.query.campania_id) : null;
      const clienteFilter = req.query.cliente_id ? Number(req.query.cliente_id) : null;
      const estatusFilter = (req.query.estatus_operaciones as string || '').trim();
      const like = search ? `%${search}%` : null;

      // Visibilidad por campania: DEV/Admin/Gerente ven todo.
      let visibleClause = '';
      const visibleParams: unknown[] = [];
      if (!hasFullVisibility(rol)) {
        const teamIds = hasTeamVisibility(rol) ? await getTeamMemberIds(prisma, userId) : undefined;
        const visibleIds = await getVisibleCampanaIds(prisma, userId, teamIds);
        if (visibleIds.length === 0) { res.json({ success: true, data: [] }); return; }
        visibleClause = `AND b.campania_id IN (${visibleIds.map(() => '?').join(',')})`;
        visibleParams.push(...visibleIds);
      }

      const extraFilters: string[] = [];
      const extraParams: unknown[] = [];
      if (campaniaFilter) { extraFilters.push('b.campania_id = ?'); extraParams.push(campaniaFilter); }
      if (clienteFilter) { extraFilters.push('cm.cliente_id = ?'); extraParams.push(clienteFilter); }
      if (estatusFilter) { extraFilters.push('b.estatus_operaciones = ?'); extraParams.push(estatusFilter); }
      if (like) {
        extraFilters.push('(b.nombre_arte LIKE ? OR b.nombre_generico LIKE ? OR cl.T0_U_Cliente LIKE ? OR s.marca_nombre LIKE ? OR CAST(b.campania_id AS CHAR) LIKE ?)');
        extraParams.push(like, like, like, like, like);
      }
      const extraWhere = extraFilters.length ? `AND ${extraFilters.join(' AND ')}` : '';

      const rows = await prisma.$queryRawUnsafe<Array<{
        biblioteca_artes_id: number; campania_id: number;
        nombre_arte: string | null; nombre_generico: string | null;
        archivo: string; tipo: string; estatus_operaciones: string | null;
        campania_nombre: string | null; cliente: string | null; marca: string | null; asesor: string | null;
        cantidad_inicial: number; cantidad_recibida: number;
        cantidad_instalada: number; cantidad_salidas_manuales: number;
      }>>(`
        SELECT
          b.id AS biblioteca_artes_id, b.campania_id,
          b.nombre_arte, b.nombre_generico, b.archivo, b.tipo, b.estatus_operaciones,
          cm.nombre AS campania_nombre,
          COALESCE(NULLIF(cl.T0_U_Cliente, 'Cliente'), NULLIF(cl.T0_U_RazonSocial, ''), s.razon_social) AS cliente,
          s.marca_nombre AS marca,
          s.asesor AS asesor,
          COALESCE(st.cantidad_inicial, 0) AS cantidad_inicial,
          COALESCE(st.cantidad_recibida, 0) AS cantidad_recibida,
          COALESCE(st.cantidad_instalada, 0) AS cantidad_instalada,
          COALESCE(st.cantidad_salidas_manuales, 0) AS cantidad_salidas_manuales
        FROM biblioteca_artes b
        LEFT JOIN campania cm ON cm.id = b.campania_id
        LEFT JOIN cotizacion ct ON ct.id = cm.cotizacion_id
        LEFT JOIN propuesta p ON p.id = ct.id_propuesta
        LEFT JOIN solicitud s ON s.id = p.solicitud_id
        LEFT JOIN cliente cl ON cl.id = cm.cliente_id
        LEFT JOIN almacen_artes_stock st ON st.biblioteca_artes_id = b.id
        WHERE 1=1 ${visibleClause} ${extraWhere}
        ORDER BY b.campania_id DESC, b.id DESC
        LIMIT 500
      `, ...visibleParams, ...extraParams);

      const data = rows.map(r => {
        const inicial = Number(r.cantidad_inicial) || 0;
        const recibida = Number(r.cantidad_recibida) || 0;
        const instalada = Number(r.cantidad_instalada) || 0;
        const salidas = Number(r.cantidad_salidas_manuales) || 0;
        return {
          biblioteca_artes_id: r.biblioteca_artes_id,
          campania_id: r.campania_id,
          campania_nombre: r.campania_nombre,
          nombre_arte: r.nombre_arte || r.nombre_generico || r.archivo.split('/').pop() || `Arte #${r.biblioteca_artes_id}`,
          nombre_generico: r.nombre_generico,
          archivo: r.archivo,
          tipo: r.tipo,
          estatus_operaciones: r.estatus_operaciones,
          cliente: r.cliente,
          marca: r.marca,
          asesor: r.asesor,
          cantidad_inicial: inicial,
          cantidad_recibida: recibida,
          cantidad_instalada: instalada,
          cantidad_salidas_manuales: salidas,
          cantidad_disponible: Math.max(0, inicial + recibida - instalada - salidas),
        };
      });

      res.json({ success: true, data });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al listar almacen de artes';
      res.status(500).json({ success: false, error: message });
    }
  }

  // GET /almacen-artes/:id/historial
  async historial(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) { res.status(401).json({ success: false, error: 'No autenticado' }); return; }
      const bibId = Number(req.params.id);
      if (!Number.isFinite(bibId) || bibId <= 0) {
        res.status(400).json({ success: false, error: 'id invalido' });
        return;
      }
      const movs = await prisma.almacen_artes_movimientos.findMany({
        where: { biblioteca_artes_id: bibId },
        orderBy: { fecha_hora: 'desc' },
        take: 200,
      });
      res.json({ success: true, data: movs });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener historial';
      res.status(500).json({ success: false, error: message });
    }
  }

  // POST /almacen-artes/:id/entrada-manual  body: { cantidad, nota? }
  async entradaManual(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      const rol = req.user?.rol;
      const userName = req.user?.nombre || 'Usuario';
      if (!userId) { res.status(401).json({ success: false, error: 'No autenticado' }); return; }
      if (!puedeGestionarAlmacen(rol)) {
        res.status(403).json({ success: false, error: 'Rol no autorizado' });
        return;
      }
      const bibId = Number(req.params.id);
      const { cantidad, nota } = req.body as { cantidad?: number; nota?: string };
      const cant = Number(cantidad);
      if (!Number.isFinite(cant) || cant <= 0) {
        res.status(400).json({ success: false, error: 'cantidad debe ser > 0' });
        return;
      }
      const biblio = await prisma.biblioteca_artes.findUnique({ where: { id: bibId } });
      if (!biblio) { res.status(404).json({ success: false, error: 'Arte no encontrado' }); return; }

      await prisma.$transaction(async (tx) => {
        await registrarMovimiento(tx, {
          biblioteca_artes_id: bibId,
          campania_id: biblio.campania_id,
          tipo: 'entrada_manual',
          cantidad: cant,
          usuario_id: userId,
          usuario_nombre: userName,
          nota: nota?.trim() || 'Entrada manual al almacen',
        });
      });

      res.json({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al registrar entrada manual';
      res.status(500).json({ success: false, error: message });
    }
  }

  // POST /almacen-artes/:id/salida-manual  body: { cantidad, nota? }
  async salidaManual(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      const rol = req.user?.rol;
      const userName = req.user?.nombre || 'Usuario';
      if (!userId) { res.status(401).json({ success: false, error: 'No autenticado' }); return; }
      if (!puedeGestionarAlmacen(rol)) {
        res.status(403).json({ success: false, error: 'Rol no autorizado' });
        return;
      }
      const bibId = Number(req.params.id);
      const { cantidad, nota } = req.body as { cantidad?: number; nota?: string };
      const cant = Number(cantidad);
      if (!Number.isFinite(cant) || cant <= 0) {
        res.status(400).json({ success: false, error: 'cantidad debe ser > 0' });
        return;
      }
      if (!nota || !nota.trim()) {
        res.status(400).json({ success: false, error: 'Motivo de salida requerido' });
        return;
      }
      const biblio = await prisma.biblioteca_artes.findUnique({ where: { id: bibId } });
      if (!biblio) { res.status(404).json({ success: false, error: 'Arte no encontrado' }); return; }

      await prisma.$transaction(async (tx) => {
        await registrarMovimiento(tx, {
          biblioteca_artes_id: bibId,
          campania_id: biblio.campania_id,
          tipo: 'salida_manual',
          cantidad: cant,
          usuario_id: userId,
          usuario_nombre: userName,
          nota: nota.trim(),
        });
      });

      res.json({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al registrar salida manual';
      res.status(500).json({ success: false, error: message });
    }
  }

  // POST /almacen-artes/:id/alta-inicial  body: { cantidad }
  // Setea (o aumenta) la cantidad inicial de bodega de un arte existente.
  // Normalmente se setea al crear el arte, pero este endpoint permite
  // corregir si se olvido.
  async altaInicial(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      const rol = req.user?.rol;
      const userName = req.user?.nombre || 'Usuario';
      if (!userId) { res.status(401).json({ success: false, error: 'No autenticado' }); return; }
      if (!puedeGestionarAlmacen(rol)) {
        res.status(403).json({ success: false, error: 'Rol no autorizado' });
        return;
      }
      const bibId = Number(req.params.id);
      const { cantidad } = req.body as { cantidad?: number };
      const cant = Number(cantidad);
      if (!Number.isFinite(cant) || cant <= 0) {
        res.status(400).json({ success: false, error: 'cantidad debe ser > 0' });
        return;
      }
      const biblio = await prisma.biblioteca_artes.findUnique({ where: { id: bibId } });
      if (!biblio) { res.status(404).json({ success: false, error: 'Arte no encontrado' }); return; }

      await prisma.$transaction(async (tx) => {
        await registrarMovimiento(tx, {
          biblioteca_artes_id: bibId,
          campania_id: biblio.campania_id,
          tipo: 'alta_inicial',
          cantidad: cant,
          usuario_id: userId,
          usuario_nombre: userName,
          nota: 'Alta inicial de bodega',
        });
      });

      res.json({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al registrar alta inicial';
      res.status(500).json({ success: false, error: message });
    }
  }
}

export const almacenArtesController = new AlmacenArtesController();
