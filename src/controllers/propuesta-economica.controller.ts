import { Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';

// Propuesta económica: el documento completo (encabezado, tablas, observaciones)
// viaja como un objeto `data` y se guarda tal cual en JSON. El back no interpreta
// su contenido — los cálculos (descuento, inversión, IVA) son del front.

interface PropuestaBody {
  nombre?: string;
  data?: unknown;
}

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const parseData = (value: string | null | undefined): Record<string, unknown> => {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return esObjeto(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const serialize = (row: {
  id: number;
  usuario_id: number;
  nombre: string;
  data: string;
  fecha_creacion: Date;
  fecha_actualizacion: Date | null;
}) => ({
  id: row.id,
  usuario_id: row.usuario_id,
  nombre: row.nombre,
  data: parseData(row.data),
  fecha_creacion: row.fecha_creacion,
  fecha_actualizacion: row.fecha_actualizacion,
});

export class PropuestaEconomicaController {
  async getAll(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        return;
      }

      const rows = await prisma.propuesta_economica.findMany({
        where: { usuario_id: userId },
        orderBy: [{ fecha_actualizacion: 'desc' }, { fecha_creacion: 'desc' }],
      });

      res.json({ success: true, data: rows.map(serialize) });
    } catch (error) {
      console.error('Error al obtener propuestas económicas:', error);
      res.status(500).json({ success: false, error: 'Error al obtener propuestas económicas' });
    }
  }

  async getById(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        return;
      }

      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) {
        res.status(400).json({ success: false, error: 'ID inválido' });
        return;
      }

      // Cualquier usuario autenticado puede abrirla (para compartir por enlace)
      const row = await prisma.propuesta_economica.findUnique({ where: { id } });
      if (!row) {
        res.status(404).json({ success: false, error: 'Propuesta económica no encontrada' });
        return;
      }

      res.json({ success: true, data: { ...serialize(row), is_owner: row.usuario_id === userId } });
    } catch (error) {
      console.error('Error al obtener propuesta económica:', error);
      res.status(500).json({ success: false, error: 'Error al obtener propuesta económica' });
    }
  }

  async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        return;
      }

      const { nombre, data } = req.body as PropuestaBody;
      if (!nombre || typeof nombre !== 'string' || !nombre.trim()) {
        res.status(400).json({ success: false, error: 'El nombre es requerido' });
        return;
      }
      if (!esObjeto(data)) {
        res.status(400).json({ success: false, error: 'El contenido de la propuesta es requerido' });
        return;
      }

      const row = await prisma.propuesta_economica.create({
        data: {
          usuario_id: userId,
          nombre: nombre.trim().slice(0, 255),
          data: JSON.stringify(data),
          fecha_creacion: new Date(),
        },
      });

      res.status(201).json({ success: true, data: { ...serialize(row), is_owner: true } });
    } catch (error) {
      console.error('Error al crear propuesta económica:', error);
      res.status(500).json({ success: false, error: 'Error al crear propuesta económica' });
    }
  }

  async update(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        return;
      }

      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) {
        res.status(400).json({ success: false, error: 'ID inválido' });
        return;
      }

      const existente = await prisma.propuesta_economica.findFirst({
        where: { id, usuario_id: userId },
      });
      if (!existente) {
        res.status(404).json({ success: false, error: 'Propuesta económica no encontrada' });
        return;
      }

      const { nombre, data } = req.body as PropuestaBody;

      const row = await prisma.propuesta_economica.update({
        where: { id },
        data: {
          nombre: typeof nombre === 'string' && nombre.trim() ? nombre.trim().slice(0, 255) : existente.nombre,
          data: esObjeto(data) ? JSON.stringify(data) : existente.data,
          fecha_actualizacion: new Date(),
        },
      });

      res.json({ success: true, data: { ...serialize(row), is_owner: true } });
    } catch (error) {
      console.error('Error al actualizar propuesta económica:', error);
      res.status(500).json({ success: false, error: 'Error al actualizar propuesta económica' });
    }
  }

  async delete(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        return;
      }

      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) {
        res.status(400).json({ success: false, error: 'ID inválido' });
        return;
      }

      const existente = await prisma.propuesta_economica.findFirst({
        where: { id, usuario_id: userId },
      });
      if (!existente) {
        res.status(404).json({ success: false, error: 'Propuesta económica no encontrada' });
        return;
      }

      await prisma.propuesta_economica.delete({ where: { id } });
      res.json({ success: true, message: 'Propuesta económica eliminada correctamente' });
    } catch (error) {
      console.error('Error al eliminar propuesta económica:', error);
      res.status(500).json({ success: false, error: 'Error al eliminar propuesta económica' });
    }
  }
}

export const propuestaEconomicaController = new PropuestaEconomicaController();
