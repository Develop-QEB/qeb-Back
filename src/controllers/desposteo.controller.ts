import { Response } from 'express';
import { AuthRequest } from '../types';
import {
  crearSolicitudDesposteo,
  aprobarFiltroGerente,
  rechazarFiltroGerente,
  aprobarFacturacion,
  rechazarFacturacion,
  verificarAutorizacionEjecucion,
  listarSolicitudes,
  getDetalle,
  getHistorialNotas,
  puedeSolicitarDesposteo,
  EstatusDesposteo,
} from '../services/desposteo.service';

// Roles habilitados para actuar en cada etapa. La resolucion fina de "es
// ESTE GC el del asesor" la hace el servicio en base a equipos; aca solo
// se filtra el rol para bloquear a cualquiera que ni siquiera es GC.
const GC_ROLES = new Set([
  'Gerente Comercial Vía Pública',
  'Gerente Comercial Via Publica',
  'Gerente Comercial Plazas',
  'Gerente Comercial (Plazas)',
  'Gerente Comercial',
  'Administrador',
  'DEV',
]);
const FACTURACION_ROLES = new Set([
  'Coordinador de Facturación y Cobranza',
  'Coordinador de Facturación',
  'Administrador',
  'DEV',
]);

function actorFromReq(req: AuthRequest): { id: number; nombre: string } | null {
  if (!req.user?.userId) return null;
  return { id: req.user.userId, nombre: req.user.nombre || req.user.email || 'Usuario' };
}

export async function solicitar(req: AuthRequest, res: Response): Promise<void> {
  try {
    const actor = actorFromReq(req);
    if (!actor) { res.status(401).json({ success: false, error: 'No autenticado' }); return; }
    if (!puedeSolicitarDesposteo(req.user?.rol)) {
      res.status(403).json({ success: false, error: 'Rol no autorizado para solicitar desposteo' });
      return;
    }
    const { campania_id, aps, nota } = req.body as { campania_id?: unknown; aps?: unknown; nota?: unknown };
    const campaniaId = Number(campania_id);
    const apsNum = Number(aps);
    const notaStr = typeof nota === 'string' ? nota : '';
    if (!Number.isFinite(campaniaId) || campaniaId <= 0) { res.status(400).json({ success: false, error: 'campania_id requerido' }); return; }
    if (!Number.isFinite(apsNum) || apsNum <= 0) { res.status(400).json({ success: false, error: 'aps requerido' }); return; }
    if (!notaStr.trim()) { res.status(400).json({ success: false, error: 'nota requerida' }); return; }

    const s = await crearSolicitudDesposteo({ campaniaId, aps: apsNum, nota: notaStr, asesor: actor });
    res.status(201).json({ success: true, data: s });
  } catch (error) {
    console.error('Error solicitar desposteo:', error);
    const message = error instanceof Error ? error.message : 'Error al crear solicitud';
    res.status(400).json({ success: false, error: message });
  }
}

export async function listar(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user?.userId) { res.status(401).json({ success: false, error: 'No autenticado' }); return; }
    const campaniaId = req.query.campania_id ? Number(req.query.campania_id) : undefined;
    const estatus = (req.query.estatus as EstatusDesposteo) || undefined;
    const incluirEjecutados = req.query.incluir_ejecutados === 'true' || req.query.incluir_ejecutados === '1';

    const data = await listarSolicitudes({ campaniaId, estatus, incluirEjecutados });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error listar desposteos:', error);
    const message = error instanceof Error ? error.message : 'Error al listar';
    res.status(500).json({ success: false, error: message });
  }
}

export async function detalle(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user?.userId) { res.status(401).json({ success: false, error: 'No autenticado' }); return; }
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ success: false, error: 'id invalido' }); return; }
    const d = await getDetalle(id);
    if (!d) { res.status(404).json({ success: false, error: 'Solicitud no encontrada' }); return; }
    res.json({ success: true, data: d });
  } catch (error) {
    console.error('Error detalle desposteo:', error);
    const message = error instanceof Error ? error.message : 'Error al obtener detalle';
    res.status(500).json({ success: false, error: message });
  }
}

export async function historial(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user?.userId) { res.status(401).json({ success: false, error: 'No autenticado' }); return; }
    const campaniaId = Number(req.query.campania_id);
    const apsNum = Number(req.query.aps);
    if (!Number.isFinite(campaniaId) || campaniaId <= 0) { res.status(400).json({ success: false, error: 'campania_id requerido' }); return; }
    if (!Number.isFinite(apsNum) || apsNum <= 0) { res.status(400).json({ success: false, error: 'aps requerido' }); return; }
    const notas = await getHistorialNotas(campaniaId, apsNum);
    res.json({ success: true, data: notas });
  } catch (error) {
    console.error('Error historial desposteo:', error);
    const message = error instanceof Error ? error.message : 'Error al obtener historial';
    res.status(500).json({ success: false, error: message });
  }
}

export async function filtroAprobar(req: AuthRequest, res: Response): Promise<void> {
  try {
    const actor = actorFromReq(req);
    if (!actor) { res.status(401).json({ success: false, error: 'No autenticado' }); return; }
    if (!GC_ROLES.has(req.user?.rol || '')) {
      res.status(403).json({ success: false, error: 'Solo el gerente comercial puede filtrar' });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ success: false, error: 'id invalido' }); return; }
    const { nota } = req.body as { nota?: string };
    const s = await aprobarFiltroGerente(id, actor, nota);
    res.json({ success: true, data: s });
  } catch (error) {
    console.error('Error aprobar filtro desposteo:', error);
    const message = error instanceof Error ? error.message : 'Error al aprobar filtro';
    res.status(400).json({ success: false, error: message });
  }
}

export async function filtroRechazar(req: AuthRequest, res: Response): Promise<void> {
  try {
    const actor = actorFromReq(req);
    if (!actor) { res.status(401).json({ success: false, error: 'No autenticado' }); return; }
    if (!GC_ROLES.has(req.user?.rol || '')) {
      res.status(403).json({ success: false, error: 'Solo el gerente comercial puede rechazar filtro' });
      return;
    }
    const id = Number(req.params.id);
    const { nota } = req.body as { nota?: string };
    if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ success: false, error: 'id invalido' }); return; }
    if (!nota || !nota.trim()) { res.status(400).json({ success: false, error: 'nota requerida' }); return; }
    const s = await rechazarFiltroGerente(id, actor, nota);
    res.json({ success: true, data: s });
  } catch (error) {
    console.error('Error rechazar filtro desposteo:', error);
    const message = error instanceof Error ? error.message : 'Error al rechazar filtro';
    res.status(400).json({ success: false, error: message });
  }
}

export async function aprobar(req: AuthRequest, res: Response): Promise<void> {
  try {
    const actor = actorFromReq(req);
    if (!actor) { res.status(401).json({ success: false, error: 'No autenticado' }); return; }
    if (!FACTURACION_ROLES.has(req.user?.rol || '')) {
      res.status(403).json({ success: false, error: 'Solo facturacion puede aprobar' });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ success: false, error: 'id invalido' }); return; }
    const { nota } = req.body as { nota?: string };
    const s = await aprobarFacturacion(id, actor, nota);
    res.json({ success: true, data: s });
  } catch (error) {
    console.error('Error aprobar desposteo:', error);
    const message = error instanceof Error ? error.message : 'Error al aprobar';
    res.status(400).json({ success: false, error: message });
  }
}

export async function rechazar(req: AuthRequest, res: Response): Promise<void> {
  try {
    const actor = actorFromReq(req);
    if (!actor) { res.status(401).json({ success: false, error: 'No autenticado' }); return; }
    if (!FACTURACION_ROLES.has(req.user?.rol || '')) {
      res.status(403).json({ success: false, error: 'Solo facturacion puede rechazar' });
      return;
    }
    const id = Number(req.params.id);
    const { nota } = req.body as { nota?: string };
    if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ success: false, error: 'id invalido' }); return; }
    if (!nota || !nota.trim()) { res.status(400).json({ success: false, error: 'nota requerida' }); return; }
    const s = await rechazarFacturacion(id, actor, nota);
    res.json({ success: true, data: s });
  } catch (error) {
    console.error('Error rechazar desposteo:', error);
    const message = error instanceof Error ? error.message : 'Error al rechazar';
    res.status(400).json({ success: false, error: message });
  }
}

// Endpoint utilitario para el front del TI: dice si un (campania,aps) tiene
// solicitud aprobada lista para ejecutar via unmarkPostedAPS.
export async function verificar(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user?.userId) { res.status(401).json({ success: false, error: 'No autenticado' }); return; }
    const campaniaId = Number(req.query.campania_id);
    const apsNum = Number(req.query.aps);
    if (!Number.isFinite(campaniaId) || campaniaId <= 0) { res.status(400).json({ success: false, error: 'campania_id requerido' }); return; }
    if (!Number.isFinite(apsNum) || apsNum <= 0) { res.status(400).json({ success: false, error: 'aps requerido' }); return; }
    const r = await verificarAutorizacionEjecucion(campaniaId, apsNum);
    res.json({ success: true, data: r });
  } catch (error) {
    console.error('Error verificar desposteo:', error);
    const message = error instanceof Error ? error.message : 'Error al verificar';
    res.status(500).json({ success: false, error: message });
  }
}
