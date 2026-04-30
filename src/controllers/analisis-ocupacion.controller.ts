import { Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';

interface AnalisisBody {
  nombre?: string;
  inventarios?: unknown;
  catorcenas?: unknown;
  codigosNoEncontrados?: unknown;
}

const stringifyJson = (value: unknown): string => {
  try {
    return JSON.stringify(value ?? []);
  } catch {
    return '[]';
  }
};

const parseJson = <T,>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed as T;
  } catch {
    return fallback;
  }
};

const serialize = (row: {
  id: number;
  usuario_id: number;
  nombre: string;
  inventarios_data: string;
  catorcenas_data: string;
  codigos_no_encontrados: string | null;
  fecha_creacion: Date;
  fecha_actualizacion: Date | null;
}) => ({
  id: row.id,
  usuario_id: row.usuario_id,
  nombre: row.nombre,
  inventarios: parseJson<unknown[]>(row.inventarios_data, []),
  catorcenas: parseJson<unknown[]>(row.catorcenas_data, []),
  codigosNoEncontrados: parseJson<string[]>(row.codigos_no_encontrados, []),
  fecha_creacion: row.fecha_creacion,
  fecha_actualizacion: row.fecha_actualizacion,
});

export class AnalisisOcupacionController {
  async getAll(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        return;
      }

      const rows = await prisma.analisis_ocupacion.findMany({
        where: { usuario_id: userId },
        orderBy: [{ fecha_actualizacion: 'desc' }, { fecha_creacion: 'desc' }],
      });

      res.json({ success: true, data: rows.map(serialize) });
    } catch (error) {
      console.error('Error al obtener análisis:', error);
      res.status(500).json({ success: false, error: 'Error al obtener análisis' });
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

      // Cualquier usuario autenticado puede abrir un análisis (para compartir por enlace)
      const row = await prisma.analisis_ocupacion.findUnique({ where: { id } });
      if (!row) {
        res.status(404).json({ success: false, error: 'Análisis no encontrado' });
        return;
      }

      res.json({ success: true, data: { ...serialize(row), is_owner: row.usuario_id === userId } });
    } catch (error) {
      console.error('Error al obtener análisis:', error);
      res.status(500).json({ success: false, error: 'Error al obtener análisis' });
    }
  }

  async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        return;
      }

      const { nombre, inventarios, catorcenas, codigosNoEncontrados } = req.body as AnalisisBody;
      if (!nombre || typeof nombre !== 'string' || !nombre.trim()) {
        res.status(400).json({ success: false, error: 'El nombre es requerido' });
        return;
      }
      if (!Array.isArray(inventarios) || inventarios.length === 0) {
        res.status(400).json({ success: false, error: 'Debe incluir al menos un inventario' });
        return;
      }
      if (!Array.isArray(catorcenas) || catorcenas.length === 0) {
        res.status(400).json({ success: false, error: 'Debe incluir al menos una catorcena' });
        return;
      }

      const row = await prisma.analisis_ocupacion.create({
        data: {
          usuario_id: userId,
          nombre: nombre.trim(),
          inventarios_data: stringifyJson(inventarios),
          catorcenas_data: stringifyJson(catorcenas),
          codigos_no_encontrados: stringifyJson(Array.isArray(codigosNoEncontrados) ? codigosNoEncontrados : []),
          fecha_creacion: new Date(),
        },
      });

      res.status(201).json({ success: true, data: { ...serialize(row), is_owner: true } });
    } catch (error) {
      console.error('Error al crear análisis:', error);
      res.status(500).json({ success: false, error: 'Error al crear análisis' });
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

      const existente = await prisma.analisis_ocupacion.findFirst({
        where: { id, usuario_id: userId },
      });
      if (!existente) {
        res.status(404).json({ success: false, error: 'Análisis no encontrado' });
        return;
      }

      const { nombre, inventarios, catorcenas, codigosNoEncontrados } = req.body as AnalisisBody;

      const row = await prisma.analisis_ocupacion.update({
        where: { id },
        data: {
          nombre: typeof nombre === 'string' && nombre.trim() ? nombre.trim() : existente.nombre,
          inventarios_data: Array.isArray(inventarios) ? stringifyJson(inventarios) : existente.inventarios_data,
          catorcenas_data: Array.isArray(catorcenas) ? stringifyJson(catorcenas) : existente.catorcenas_data,
          codigos_no_encontrados: Array.isArray(codigosNoEncontrados)
            ? stringifyJson(codigosNoEncontrados)
            : existente.codigos_no_encontrados,
          fecha_actualizacion: new Date(),
        },
      });

      res.json({ success: true, data: { ...serialize(row), is_owner: true } });
    } catch (error) {
      console.error('Error al actualizar análisis:', error);
      res.status(500).json({ success: false, error: 'Error al actualizar análisis' });
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

      const existente = await prisma.analisis_ocupacion.findFirst({
        where: { id, usuario_id: userId },
      });
      if (!existente) {
        res.status(404).json({ success: false, error: 'Análisis no encontrado' });
        return;
      }

      await prisma.analisis_ocupacion.delete({ where: { id } });
      res.json({ success: true, message: 'Análisis eliminado correctamente' });
    } catch (error) {
      console.error('Error al eliminar análisis:', error);
      res.status(500).json({ success: false, error: 'Error al eliminar análisis' });
    }
  }
}

export const analisisOcupacionController = new AnalisisOcupacionController();
