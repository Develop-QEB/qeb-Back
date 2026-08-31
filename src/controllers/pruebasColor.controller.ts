import { Response } from 'express';
import { AuthRequest } from '../types';
import {
  crearPruebaColor,
  actualizarEstatusPruebaColor,
  listarPruebasColor,
  eliminarPruebaColor,
  puedeGestionarPruebaColor,
  EstatusPruebaColor,
} from '../services/pruebasColor.service';

// Endpoints del modulo Prueba de Color. Feedback 2026-08-15.
// Se acceden desde: propuestas (boton de accion), campañas (boton de accion)
// y gestion de artes en detalle de campaña. Todos usan el mismo modal.

export async function crear(req: AuthRequest, res: Response): Promise<void> {
  try {
    const rol = req.user?.rol;
    const userId = req.user?.userId;
    const userNombre = req.user?.nombre || 'Usuario';
    if (!userId) { res.status(401).json({ success: false, error: 'No autenticado' }); return; }
    if (!puedeGestionarPruebaColor(rol)) {
      res.status(403).json({ success: false, error: 'Rol no autorizado para solicitar pruebas de color' });
      return;
    }

    const { propuesta_id, sc_id, archivo, archivo_data, nombre_arte, notas } = req.body as {
      propuesta_id?: number | string;
      sc_id?: number | string;
      archivo?: string;
      archivo_data?: string | null;
      nombre_arte?: string | null;
      notas?: string | null;
    };

    const propuestaId = Number(propuesta_id);
    const scId = Number(sc_id);
    if (!Number.isFinite(propuestaId) || propuestaId <= 0) { res.status(400).json({ success: false, error: 'propuesta_id requerido' }); return; }
    if (!Number.isFinite(scId) || scId <= 0) { res.status(400).json({ success: false, error: 'sc_id requerido' }); return; }
    if (!archivo || typeof archivo !== 'string') { res.status(400).json({ success: false, error: 'archivo requerido' }); return; }

    const prueba = await crearPruebaColor({
      propuestaId,
      scId,
      archivo,
      archivo_data: archivo_data || null,
      nombre_arte: nombre_arte || null,
      notas: notas || null,
      createdBy: userId,
      createdByNombre: userNombre,
    });
    res.status(201).json({ success: true, data: prueba });
  } catch (error) {
    console.error('Error crear prueba color:', error);
    const message = error instanceof Error ? error.message : 'Error al crear prueba de color';
    res.status(500).json({ success: false, error: message });
  }
}

export async function listar(req: AuthRequest, res: Response): Promise<void> {
  try {
    const propuestaId = req.query.propuesta_id ? Number(req.query.propuesta_id) : undefined;
    const campaniaId = req.query.campania_id ? Number(req.query.campania_id) : undefined;
    const scId = req.query.sc_id ? Number(req.query.sc_id) : undefined;
    if (!propuestaId && !campaniaId && !scId) {
      res.status(400).json({ success: false, error: 'Filtro requerido (propuesta_id, campania_id o sc_id)' });
      return;
    }
    const data = await listarPruebasColor({
      propuesta_id: propuestaId,
      campania_id: campaniaId,
      sc_id: scId,
    });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error listar pruebas color:', error);
    const message = error instanceof Error ? error.message : 'Error al listar pruebas de color';
    res.status(500).json({ success: false, error: message });
  }
}

export async function actualizarEstatus(req: AuthRequest, res: Response): Promise<void> {
  try {
    const rol = req.user?.rol;
    const userId = req.user?.userId;
    const userNombre = req.user?.nombre || 'Usuario';
    if (!userId) { res.status(401).json({ success: false, error: 'No autenticado' }); return; }
    if (!puedeGestionarPruebaColor(rol)) {
      res.status(403).json({ success: false, error: 'Rol no autorizado' });
      return;
    }

    const pruebaId = Number(req.params.id);
    const { estatus } = req.body as { estatus?: string };
    if (!Number.isFinite(pruebaId) || pruebaId <= 0) { res.status(400).json({ success: false, error: 'id invalido' }); return; }
    if (!estatus) { res.status(400).json({ success: false, error: 'estatus requerido' }); return; }

    const upd = await actualizarEstatusPruebaColor({
      pruebaId,
      nuevoEstatus: estatus as EstatusPruebaColor,
      userId,
      userNombre,
    });
    res.json({ success: true, data: upd });
  } catch (error) {
    console.error('Error actualizar estatus prueba color:', error);
    const message = error instanceof Error ? error.message : 'Error al actualizar estatus';
    res.status(400).json({ success: false, error: message });
  }
}

export async function eliminar(req: AuthRequest, res: Response): Promise<void> {
  try {
    const rol = req.user?.rol;
    const userId = req.user?.userId;
    const userNombre = req.user?.nombre || 'Usuario';
    if (!userId) { res.status(401).json({ success: false, error: 'No autenticado' }); return; }
    if (!puedeGestionarPruebaColor(rol)) {
      res.status(403).json({ success: false, error: 'Rol no autorizado' });
      return;
    }

    const pruebaId = Number(req.params.id);
    if (!Number.isFinite(pruebaId) || pruebaId <= 0) { res.status(400).json({ success: false, error: 'id invalido' }); return; }

    await eliminarPruebaColor(pruebaId, userId, userNombre);
    res.json({ success: true });
  } catch (error) {
    console.error('Error eliminar prueba color:', error);
    const message = error instanceof Error ? error.message : 'Error al eliminar';
    res.status(500).json({ success: false, error: message });
  }
}
