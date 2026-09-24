import { Response } from 'express';
import { AuthRequest } from '../types';
import { logHistorial } from '../utils/historial';
import {
  listarCapasPropuesta, crearCapa, actualizarCapa, eliminarCapa,
  type ModoCapa, type OrigenCapa,
} from '../services/capas-mapa.service';

// Capas de POI / poligonos KML por circuito (ver capas-mapa.service.ts).
// El POST no cuelga de /propuestas/:id porque el modal de campaña no conoce
// la propuesta: manda solo solicitudCarasId y el servicio deriva idquote.
export class CapasMapaController {
  /** Vista Compartir interna: TODAS las capas vivas de la propuesta. */
  async listarPorPropuesta(req: AuthRequest, res: Response): Promise<void> {
    try {
      const propuestaId = parseInt(req.params.id, 10);
      if (!Number.isFinite(propuestaId)) {
        res.status(400).json({ success: false, error: 'Propuesta inválida' });
        return;
      }
      const capas = await listarCapasPropuesta(propuestaId);
      res.json({ success: true, data: capas });
    } catch (error) {
      console.error('Error en listarPorPropuesta capas-mapa:', error);
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Error al listar capas' });
    }
  }

  async crear(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { solicitudCarasId, nombre, modo, origen, geometria, visibleCliente, kmlTexto, kmlNombre } = req.body ?? {};
      const capa = await crearCapa({
        solicitudCarasId: Number(solicitudCarasId),
        nombre: String(nombre ?? ''),
        modo: modo as ModoCapa,
        origen: origen as OrigenCapa,
        geometria,
        visibleCliente: visibleCliente === undefined ? true : Boolean(visibleCliente),
        kmlTexto: typeof kmlTexto === 'string' ? kmlTexto : null,
        kmlNombre: typeof kmlNombre === 'string' ? kmlNombre : null,
        usuarioId: req.user?.userId,
        usuarioNombre: req.user?.nombre,
      });

      await logHistorial({
        tipo: 'capa_mapa',
        refId: capa.id,
        accion: `Guardó capa "${capa.nombre}" (${capa.modo}) en circuito ${capa.solicitud_caras_id}`,
        usuario: req.user?.nombre || 'Sistema',
        usuarioId: req.user?.userId,
        usuarioRol: req.user?.rol,
        origen: 'buscador_formatos',
        extras: {
          propuestaId: Number(capa.idquote),
          solicitudCarasId: capa.solicitud_caras_id,
          modo: capa.modo,
          origenCapa: capa.origen,
          pines: capa.total_pines,
          poligonos: capa.total_poligonos,
          archivoUrl: capa.archivo_url,
        },
      });

      res.status(201).json({ success: true, data: capa });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al guardar capa';
      // Errores de validacion (geometria vacia, circuito inexistente, tabla
      // faltante) son 400: no hay nada que reintentar del lado del server.
      const esValidacion = /inválid|necesita|no encontrado|no tiene|no disponibles/i.test(message);
      if (!esValidacion) console.error('Error en crear capa-mapa:', error);
      res.status(esValidacion ? 400 : 500).json({ success: false, error: message });
    }
  }

  async actualizar(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = parseInt(req.params.capaId, 10);
      const { nombre, visibleCliente } = req.body ?? {};
      const capa = await actualizarCapa(id, {
        nombre: nombre === undefined ? undefined : String(nombre),
        visibleCliente: visibleCliente === undefined ? undefined : Boolean(visibleCliente),
      });
      if (!capa) {
        res.status(404).json({ success: false, error: 'Capa no encontrada' });
        return;
      }
      res.json({ success: true, data: capa });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al actualizar capa';
      res.status(/necesita/i.test(message) ? 400 : 500).json({ success: false, error: message });
    }
  }

  async eliminar(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = parseInt(req.params.capaId, 10);
      const capa = await eliminarCapa(id);
      if (!capa) {
        res.status(404).json({ success: false, error: 'Capa no encontrada' });
        return;
      }
      await logHistorial({
        tipo: 'capa_mapa',
        refId: capa.id,
        accion: `Eliminó capa "${capa.nombre}" del circuito ${capa.solicitud_caras_id}`,
        usuario: req.user?.nombre || 'Sistema',
        usuarioId: req.user?.userId,
        usuarioRol: req.user?.rol,
        origen: 'vista_compartir',
        extras: { propuestaId: Number(capa.idquote), solicitudCarasId: capa.solicitud_caras_id },
      });
      res.json({ success: true, data: { id: capa.id } });
    } catch (error) {
      console.error('Error en eliminar capa-mapa:', error);
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Error al eliminar capa' });
    }
  }
}

export const capasMapaController = new CapasMapaController();
