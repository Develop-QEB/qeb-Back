import { Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';

export class NotasController {
  // Obtener todas las notas del usuario actual
  async getAll(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;

      if (!userId) {
        res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        return;
      }

      const notas = await prisma.notas_personales.findMany({
        where: { usuario_id: userId },
        orderBy: { fecha_creacion: 'desc' },
      });

      res.json({
        success: true,
        data: notas,
      });
    } catch (error) {
      console.error('Error al obtener notas:', error);
      res.status(500).json({ success: false, error: 'Error al obtener notas' });
    }
  }

  // Obtener una nota por ID (solo si pertenece al usuario)
  async getById(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.user?.userId;

      if (!userId) {
        res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        return;
      }

      const nota = await prisma.notas_personales.findFirst({
        where: {
          id: parseInt(id),
          usuario_id: userId,
        },
      });

      if (!nota) {
        res.status(404).json({ success: false, error: 'Nota no encontrada' });
        return;
      }

      res.json({ success: true, data: nota });
    } catch (error) {
      console.error('Error al obtener nota:', error);
      res.status(500).json({ success: false, error: 'Error al obtener nota' });
    }
  }

  // Crear una nueva nota
  async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      const { titulo, contenido, color } = req.body;

      if (!userId) {
        res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        return;
      }

      if (!contenido || contenido.trim() === '') {
        res.status(400).json({ success: false, error: 'El contenido es requerido' });
        return;
      }

      const nota = await prisma.notas_personales.create({
        data: {
          usuario_id: userId,
          titulo: titulo || null,
          contenido: contenido.trim(),
          color: color || 'purple',
          fecha_creacion: new Date(),
        },
      });

      res.status(201).json({ success: true, data: nota });
    } catch (error) {
      console.error('Error al crear nota:', error);
      res.status(500).json({ success: false, error: 'Error al crear nota' });
    }
  }

  // Actualizar una nota existente
  async update(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.user?.userId;
      const { titulo, contenido, color } = req.body;

      if (!userId) {
        res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        return;
      }

      // Verificar que la nota pertenece al usuario
      const notaExistente = await prisma.notas_personales.findFirst({
        where: {
          id: parseInt(id),
          usuario_id: userId,
        },
      });

      if (!notaExistente) {
        res.status(404).json({ success: false, error: 'Nota no encontrada' });
        return;
      }

      const nota = await prisma.notas_personales.update({
        where: { id: parseInt(id) },
        data: {
          titulo: titulo !== undefined ? titulo : notaExistente.titulo,
          contenido: contenido !== undefined ? contenido.trim() : notaExistente.contenido,
          color: color !== undefined ? color : notaExistente.color,
          fecha_actualizacion: new Date(),
        },
      });

      res.json({ success: true, data: nota });
    } catch (error) {
      console.error('Error al actualizar nota:', error);
      res.status(500).json({ success: false, error: 'Error al actualizar nota' });
    }
  }

  // Eliminar una nota
  async delete(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.user?.userId;

      if (!userId) {
        res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        return;
      }

      // Verificar que la nota pertenece al usuario
      const notaExistente = await prisma.notas_personales.findFirst({
        where: {
          id: parseInt(id),
          usuario_id: userId,
        },
      });

      if (!notaExistente) {
        res.status(404).json({ success: false, error: 'Nota no encontrada' });
        return;
      }

      await prisma.notas_personales.delete({
        where: { id: parseInt(id) },
      });

      res.json({ success: true, message: 'Nota eliminada correctamente' });
    } catch (error) {
      console.error('Error al eliminar nota:', error);
      res.status(500).json({ success: false, error: 'Error al eliminar nota' });
    }
  }
}

export const notasController = new NotasController();
