import { Response } from 'express';
import { AuthRequest } from '../types';
import {
  getPreferenciasUsuario,
  setPreferencias,
  esCanalValido,
  esClaseValida,
  PreferenciaInput,
} from '../services/preferenciasNotif.service';
import {
  catalogoParaUsuario,
  CLASE_GLOBAL,
  CLAVE_MASTER,
} from '../constants/notificaciones';
import prisma from '../utils/prisma';

export class PreferenciasNotifController {
  /** GET /notificaciones/preferencias — preferencias del usuario actual + catálogo. */
  async getMine(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ success: false, error: 'No autorizado' });
        return;
      }
      const [preferencias, usuario] = await Promise.all([
        getPreferenciasUsuario(userId),
        prisma.usuario.findUnique({ where: { id: userId }, select: { user_role: true, puesto: true } }),
      ]);
      const catalogo = catalogoParaUsuario(usuario?.user_role, usuario?.puesto);
      res.json({
        success: true,
        data: { preferencias, catalogo },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener preferencias';
      res.status(500).json({ success: false, error: message });
    }
  }

  /** PUT /notificaciones/preferencias — guarda un lote de cambios. */
  async updateMine(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ success: false, error: 'No autorizado' });
        return;
      }

      const items = req.body?.items;
      if (!Array.isArray(items) || items.length === 0) {
        res.status(400).json({ success: false, error: 'Se requiere un arreglo "items"' });
        return;
      }

      const limpios: PreferenciaInput[] = [];
      for (const it of items) {
        const canal = String(it?.canal || '');
        const clase = String(it?.clase || '');
        const clave = String(it?.clave || '');
        const habilitado = it?.habilitado;

        if (!esCanalValido(canal) || !esClaseValida(clase) || !clave || typeof habilitado !== 'boolean') {
          res.status(400).json({
            success: false,
            error: `Item inválido: ${JSON.stringify(it)}`,
          });
          return;
        }
        // Coherencia del master: clase global solo admite la clave maestra.
        if (clase === CLASE_GLOBAL && clave !== CLAVE_MASTER) {
          res.status(400).json({ success: false, error: 'El master usa clave __all__' });
          return;
        }
        limpios.push({ canal, clase: clase as PreferenciaInput['clase'], clave, habilitado });
      }

      await setPreferencias(userId, limpios);
      const preferencias = await getPreferenciasUsuario(userId);
      res.json({ success: true, data: { preferencias } });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al guardar preferencias';
      res.status(500).json({ success: false, error: message });
    }
  }
}

export const preferenciasNotifController = new PreferenciasNotifController();
