import { Response } from 'express';
import { AuthRequest } from '../types';
import {
  crearPruebaColor,
  crearPruebaColorBatch,
  actualizarEstatusPruebaColor,
  listarPruebasColor,
  eliminarPruebaColor,
  puedeGestionarPruebaColor,
  puedeCrearPruebaColor,
  puedeRevisarPruebaColor,
  listarTareasAsociadas,
  resolverTareaAsociada,
  reenviarPruebaRechazada,
  reenviarPruebasBatch,
  esTipoPruebaValido,
  EstatusPruebaColor,
  TipoPrueba,
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
    // Jos 2026-10-12: solo analistas y administradores crean pruebas.
    if (!puedeCrearPruebaColor(rol)) {
      res.status(403).json({ success: false, error: 'Solo analistas y administradores pueden solicitar pruebas de color' });
      return;
    }

    const { propuesta_id, sc_id, archivo, archivo_data, enlace_externo, nombre_arte, notas, tipo } = req.body as {
      propuesta_id?: number | string;
      sc_id?: number | string;
      archivo?: string;
      archivo_data?: string | null;
      enlace_externo?: string | null;
      nombre_arte?: string | null;
      notas?: string | null;
      tipo?: string;
    };

    const propuestaId = Number(propuesta_id);
    const scId = Number(sc_id);
    if (!Number.isFinite(propuestaId) || propuestaId <= 0) { res.status(400).json({ success: false, error: 'propuesta_id requerido' }); return; }
    if (!Number.isFinite(scId) || scId <= 0) { res.status(400).json({ success: false, error: 'sc_id requerido' }); return; }
    // Jos 2026-10-12: al menos uno de archivo o enlace_externo requerido.
    const archivoLimpio = typeof archivo === 'string' ? archivo.trim() : '';
    const enlaceLimpio = typeof enlace_externo === 'string' ? enlace_externo.trim() : '';
    if (!archivoLimpio && !enlaceLimpio) {
      res.status(400).json({ success: false, error: 'Debes subir un archivo o pegar un link del arte' });
      return;
    }
    const nombreArteLimpio = typeof nombre_arte === 'string' ? nombre_arte.trim() : '';
    if (!nombreArteLimpio) { res.status(400).json({ success: false, error: 'nombre_arte requerido' }); return; }
    // Jos 2026-10-23: tipo opcional, default prueba_color. Whitelist estricta.
    const tipoFinal: TipoPrueba = tipo && esTipoPruebaValido(tipo) ? tipo : 'prueba_color';

    const prueba = await crearPruebaColor({
      propuestaId,
      scId,
      archivo: archivoLimpio,
      archivo_data: archivo_data || null,
      enlace_externo: enlaceLimpio || null,
      nombre_arte: nombreArteLimpio,
      notas: notas || null,
      tipo: tipoFinal,
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

// Jos 2026-11-24: crea N pruebas de un mismo "lote" (varios artes para
// uno o varios circuitos) en una sola operación. Genera UNA tarea de
// Revisión por cada circuito que agrupa todos los artes de ese circuito.
export async function crearBatch(req: AuthRequest, res: Response): Promise<void> {
  try {
    const rol = req.user?.rol;
    const userId = req.user?.userId;
    const userNombre = req.user?.nombre || 'Usuario';
    if (!userId) { res.status(401).json({ success: false, error: 'No autenticado' }); return; }
    if (!puedeCrearPruebaColor(rol)) {
      res.status(403).json({ success: false, error: 'Solo analistas y administradores pueden solicitar revisiones' });
      return;
    }

    const { propuesta_id, tipo, artes } = req.body as {
      propuesta_id?: number | string;
      tipo?: string;
      artes?: Array<{
        sc_id?: number | string;
        archivo?: string;
        archivo_data?: string | null;
        enlace_externo?: string | null;
        nombre_arte?: string | null;
        notas?: string | null;
      }>;
    };

    const propuestaId = Number(propuesta_id);
    if (!Number.isFinite(propuestaId) || propuestaId <= 0) { res.status(400).json({ success: false, error: 'propuesta_id requerido' }); return; }
    if (!Array.isArray(artes) || artes.length === 0) {
      res.status(400).json({ success: false, error: 'artes[] requerido con al menos 1 elemento' });
      return;
    }

    const tipoFinal: TipoPrueba = tipo && esTipoPruebaValido(tipo) ? tipo : 'prueba_color';
    const artesLimpios = artes.map((a, idx) => {
      const scId = Number(a.sc_id);
      if (!Number.isFinite(scId) || scId <= 0) throw new Error(`artes[${idx}].sc_id inválido`);
      const archivoLimpio = typeof a.archivo === 'string' ? a.archivo.trim() : '';
      const enlaceLimpio = typeof a.enlace_externo === 'string' ? a.enlace_externo.trim() : '';
      if (!archivoLimpio && !enlaceLimpio) throw new Error(`artes[${idx}] debe tener archivo o enlace`);
      const nombreLimpio = typeof a.nombre_arte === 'string' ? a.nombre_arte.trim() : '';
      if (!nombreLimpio) throw new Error(`artes[${idx}].nombre_arte requerido`);
      return {
        scId,
        archivo: archivoLimpio,
        archivo_data: a.archivo_data || null,
        enlace_externo: enlaceLimpio || null,
        nombre_arte: nombreLimpio,
        notas: a.notas || null,
      };
    });

    const data = await crearPruebaColorBatch({
      propuestaId,
      tipo: tipoFinal,
      createdBy: userId,
      createdByNombre: userNombre,
      artes: artesLimpios,
    });
    res.status(201).json({ success: true, data });
  } catch (error) {
    console.error('Error crear batch prueba color:', error);
    const message = error instanceof Error ? error.message : 'Error al crear batch';
    res.status(400).json({ success: false, error: message });
  }
}

export async function listar(req: AuthRequest, res: Response): Promise<void> {
  try {
    const propuestaId = req.query.propuesta_id ? Number(req.query.propuesta_id) : undefined;
    const campaniaId = req.query.campania_id ? Number(req.query.campania_id) : undefined;
    const scId = req.query.sc_id ? Number(req.query.sc_id) : undefined;
    const tipoRaw = typeof req.query.tipo === 'string' ? req.query.tipo : undefined;
    const tipo: TipoPrueba | undefined = tipoRaw && esTipoPruebaValido(tipoRaw) ? tipoRaw : undefined;
    if (!propuestaId && !campaniaId && !scId) {
      res.status(400).json({ success: false, error: 'Filtro requerido (propuesta_id, campania_id o sc_id)' });
      return;
    }
    const data = await listarPruebasColor({
      propuesta_id: propuestaId,
      campania_id: campaniaId,
      sc_id: scId,
      tipo,
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

// Lista las tareas asociadas a una prueba de color (revisión + seguimiento).
// Feedback Jos 2026-10-02: la ventana de prueba de color las muestra para
// que el analista no vaya al módulo de Tareas.
export async function listarTareas(req: AuthRequest, res: Response): Promise<void> {
  try {
    const pruebaId = Number(req.params.id);
    if (!Number.isFinite(pruebaId) || pruebaId <= 0) {
      res.status(400).json({ success: false, error: 'id invalido' });
      return;
    }
    const tareas = await listarTareasAsociadas(pruebaId);
    res.json({ success: true, data: tareas });
  } catch (error) {
    console.error('Error listar tareas prueba color:', error);
    const message = error instanceof Error ? error.message : 'Error al listar tareas';
    res.status(500).json({ success: false, error: message });
  }
}

// Resuelve una tarea asociada (aprobar / rechazar / finalizar) desde el
// modal de prueba de color. Reusa los endpoints internos de aprobar y
// finalizar pero validando que la tarea pertenezca a la prueba.
export async function resolverTarea(req: AuthRequest, res: Response): Promise<void> {
  try {
    const rol = req.user?.rol;
    const userId = req.user?.userId;
    const userNombre = req.user?.nombre || 'Usuario';
    if (!userId) { res.status(401).json({ success: false, error: 'No autenticado' }); return; }

    const pruebaId = Number(req.params.id);
    const tareaId = Number(req.params.tareaId);
    if (!Number.isFinite(pruebaId) || pruebaId <= 0) { res.status(400).json({ success: false, error: 'id invalido' }); return; }
    if (!Number.isFinite(tareaId) || tareaId <= 0) { res.status(400).json({ success: false, error: 'tareaId invalido' }); return; }

    const { accion, comentario, archivo_adjunto, enlace_adjunto, prueba_id_objetivo } = req.body as {
      accion?: string;
      comentario?: string;
      archivo_adjunto?: string | null;
      enlace_adjunto?: string | null;
      // Jos 2026-11-24: cuando la tarea agrupa N pruebas (batch), el revisor
      // resuelve una a la vez. Este campo indica cuál del array se está
      // resolviendo. Si la tarea es individual (contenido.pruebaColorId), se
      // ignora. Para masivo (aprobar/rechazar todos), el front hace N requests.
      prueba_id_objetivo?: number | string;
    };
    if (accion !== 'aprobar' && accion !== 'rechazar' && accion !== 'finalizar') {
      res.status(400).json({ success: false, error: "accion debe ser 'aprobar' | 'rechazar' | 'finalizar'" });
      return;
    }
    // Jos 2026-10-12: permisos separados por accion.
    // - aprobar / rechazar → area de Diseño
    // - finalizar (seguimiento) → analista / admin (quien la solicito)
    if ((accion === 'aprobar' || accion === 'rechazar') && !puedeRevisarPruebaColor(rol)) {
      res.status(403).json({ success: false, error: 'Solo el area de Diseño puede aprobar o rechazar' });
      return;
    }
    if (accion === 'finalizar' && !puedeCrearPruebaColor(rol)) {
      res.status(403).json({ success: false, error: 'Solo analistas y administradores pueden finalizar la tarea de seguimiento' });
      return;
    }
    // Jos 2026-10-12: motivo obligatorio al rechazar.
    if (accion === 'rechazar' && (!comentario || typeof comentario !== 'string' || !comentario.trim())) {
      res.status(400).json({ success: false, error: 'El motivo del rechazo es obligatorio' });
      return;
    }

    const pruebaObjetivoRaw = prueba_id_objetivo != null ? Number(prueba_id_objetivo) : NaN;
    const pruebaIdObjetivo = Number.isFinite(pruebaObjetivoRaw) && pruebaObjetivoRaw > 0 ? pruebaObjetivoRaw : undefined;

    const result = await resolverTareaAsociada({
      pruebaId,
      tareaId,
      accion,
      comentario: comentario || undefined,
      archivo_adjunto: archivo_adjunto || null,
      enlace_adjunto: enlace_adjunto || null,
      userId,
      userNombre,
      pruebaIdObjetivo,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Error resolver tarea prueba color:', error);
    const message = error instanceof Error ? error.message : 'Error al resolver tarea';
    res.status(400).json({ success: false, error: message });
  }
}

// Reenviar una prueba rechazada — edita en sitio sobre la misma prueba
// (archivo, nombre, notas), vuelve a revision_artes y crea nueva tarea
// para los reviewers. Jos 2026-10-12.
export async function reenviar(req: AuthRequest, res: Response): Promise<void> {
  try {
    const rol = req.user?.rol;
    const userId = req.user?.userId;
    const userNombre = req.user?.nombre || 'Usuario';
    if (!userId) { res.status(401).json({ success: false, error: 'No autenticado' }); return; }
    // Jos 2026-10-12: solo analistas/admins reenvian (el analista
    // que la solicito originalmente); diseñadores NO pueden editar
    // una tarea ya rechazada.
    if (!puedeCrearPruebaColor(rol)) {
      res.status(403).json({ success: false, error: 'Solo analistas y administradores pueden reenviar una prueba rechazada' });
      return;
    }

    const pruebaId = Number(req.params.id);
    if (!Number.isFinite(pruebaId) || pruebaId <= 0) {
      res.status(400).json({ success: false, error: 'id de prueba invalido' });
      return;
    }
    const { archivo, archivo_data, enlace_externo, nombre_arte, notas } = req.body as {
      archivo?: string;
      archivo_data?: string;
      enlace_externo?: string;
      nombre_arte?: string;
      notas?: string;
    };
    const archivoLimpio = typeof archivo === 'string' ? archivo.trim() : '';
    const enlaceLimpio = typeof enlace_externo === 'string' ? enlace_externo.trim() : '';
    if (!archivoLimpio && !enlaceLimpio) {
      res.status(400).json({ success: false, error: 'Debes subir un archivo o pegar un link del arte' });
      return;
    }

    const result = await reenviarPruebaRechazada({
      pruebaId,
      archivo: archivoLimpio,
      archivo_data: archivo_data || null,
      enlace_externo: enlaceLimpio || null,
      nombre_arte: nombre_arte != null ? String(nombre_arte).trim() : undefined,
      notas: notas != null ? String(notas) : undefined,
      userId,
      userNombre,
    });

    res.json({ success: true, data: result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Error al reenviar prueba';
    res.status(400).json({ success: false, error: message });
  }
}

// Jos 2026-11-27: reenvío en LOTE de N pruebas rechazadas del mismo batch.
// El back crea UNA sola tarea Revisión de artes agrupada para Diseño en
// vez de N tareas individuales.
export async function reenviarBatch(req: AuthRequest, res: Response): Promise<void> {
  try {
    const rol = req.user?.rol;
    const userId = req.user?.userId;
    const userNombre = req.user?.nombre || 'Usuario';
    if (!userId) { res.status(401).json({ success: false, error: 'No autenticado' }); return; }
    if (!puedeCrearPruebaColor(rol)) {
      res.status(403).json({ success: false, error: 'Solo analistas y administradores pueden reenviar pruebas' });
      return;
    }
    const { pruebas } = req.body as {
      pruebas?: Array<{
        pruebaId: number;
        archivo?: string;
        archivo_data?: string;
        enlace_externo?: string;
        nombre_arte?: string;
        notas?: string;
      }>;
    };
    if (!Array.isArray(pruebas) || pruebas.length === 0) {
      res.status(400).json({ success: false, error: 'Debes enviar al menos una prueba' });
      return;
    }
    const sanitizadas = pruebas.map(p => ({
      pruebaId: Number(p.pruebaId),
      archivo: typeof p.archivo === 'string' ? p.archivo.trim() : '',
      archivo_data: p.archivo_data || null,
      enlace_externo: typeof p.enlace_externo === 'string' ? p.enlace_externo.trim() : null,
      nombre_arte: p.nombre_arte != null ? String(p.nombre_arte).trim() : undefined,
      notas: p.notas != null ? String(p.notas) : undefined,
    }));
    const result = await reenviarPruebasBatch({ pruebas: sanitizadas, userId, userNombre });
    res.json({ success: true, data: result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Error al reenviar pruebas en lote';
    res.status(400).json({ success: false, error: message });
  }
}
