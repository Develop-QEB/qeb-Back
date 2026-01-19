import { Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';
import bcrypt from 'bcryptjs';

export class UsuariosController {
  async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      // Verificar que el usuario sea Administrador
      if (req.user?.rol !== 'Administrador') {
        res.status(403).json({
          success: false,
          error: 'No tienes permisos para realizar esta acción',
        });
        return;
      }

      const { nombre, correo_electronico, password, area, puesto, rol, foto_perfil } = req.body;

      // Validar campos requeridos
      if (!nombre || !correo_electronico || !password || !area || !puesto) {
        res.status(400).json({
          success: false,
          error: 'Faltan campos requeridos',
        });
        return;
      }

      // Verificar si el correo ya existe
      const existingUser = await prisma.usuario.findFirst({
        where: {
          correo_electronico,
          deleted_at: null,
        },
      });

      if (existingUser) {
        res.status(400).json({
          success: false,
          error: 'Ya existe un usuario con ese correo electrónico',
        });
        return;
      }

      // Hash del password
      const hashedPassword = await bcrypt.hash(password, 10);

      const usuario = await prisma.usuario.create({
        data: {
          nombre,
          correo_electronico,
          user_password: hashedPassword,
          area,
          puesto,
          user_role: rol || 'Normal',
          foto_perfil: foto_perfil || null,
          created_at: new Date(),
        },
      });

      res.status(201).json({
        success: true,
        data: {
          id: usuario.id,
          nombre: usuario.nombre,
          email: usuario.correo_electronico,
          area: usuario.area,
          puesto: usuario.puesto,
          rol: usuario.user_role,
          foto_perfil: usuario.foto_perfil,
          created_at: usuario.created_at,
        },
      });
    } catch (error) {
      console.error('Error creating user:', error);
      const message = error instanceof Error ? error.message : 'Error al crear usuario';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getAll(req: AuthRequest, res: Response): Promise<void> {
    try {
      // Verificar que el usuario sea Administrador
      if (req.user?.rol !== 'Administrador') {
        res.status(403).json({
          success: false,
          error: 'No tienes permisos para acceder a esta sección',
        });
        return;
      }

      const usuarios = await prisma.usuario.findMany({
        where: {
          deleted_at: null,
        },
        select: {
          id: true,
          nombre: true,
          correo_electronico: true,
          area: true,
          puesto: true,
          user_role: true,
          foto_perfil: true,
          created_at: true,
        },
        orderBy: {
          nombre: 'asc',
        },
      });

      const formattedUsers = usuarios.map((u) => ({
        id: u.id,
        nombre: u.nombre,
        email: u.correo_electronico,
        area: u.area,
        puesto: u.puesto,
        rol: u.user_role,
        foto_perfil: u.foto_perfil,
        created_at: u.created_at,
      }));

      res.json({
        success: true,
        data: formattedUsers,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener usuarios';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async update(req: AuthRequest, res: Response): Promise<void> {
    try {
      // Verificar que el usuario sea Administrador
      if (req.user?.rol !== 'Administrador') {
        res.status(403).json({
          success: false,
          error: 'No tienes permisos para realizar esta acción',
        });
        return;
      }

      const { id } = req.params;
      const { nombre, area, puesto, rol } = req.body;

      const usuario = await prisma.usuario.findFirst({
        where: {
          id: parseInt(id),
          deleted_at: null,
        },
      });

      if (!usuario) {
        res.status(404).json({
          success: false,
          error: 'Usuario no encontrado',
        });
        return;
      }

      const updated = await prisma.usuario.update({
        where: { id: parseInt(id) },
        data: {
          ...(nombre !== undefined && { nombre }),
          ...(area !== undefined && { area }),
          ...(puesto !== undefined && { puesto }),
          ...(rol !== undefined && { user_role: rol }),
          updated_at: new Date(),
        },
      });

      res.json({
        success: true,
        data: {
          id: updated.id,
          nombre: updated.nombre,
          email: updated.correo_electronico,
          area: updated.area,
          puesto: updated.puesto,
          rol: updated.user_role,
          foto_perfil: updated.foto_perfil,
          created_at: updated.created_at,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al actualizar usuario';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async deleteMany(req: AuthRequest, res: Response): Promise<void> {
    try {
      // Verificar que el usuario sea Administrador
      if (req.user?.rol !== 'Administrador') {
        res.status(403).json({
          success: false,
          error: 'No tienes permisos para realizar esta acción',
        });
        return;
      }

      const { ids } = req.body;

      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Debe proporcionar una lista de IDs de usuarios',
        });
        return;
      }

      // No permitir que el admin se elimine a sí mismo
      if (ids.includes(req.user.userId)) {
        res.status(400).json({
          success: false,
          error: 'No puedes eliminarte a ti mismo',
        });
        return;
      }

      // Soft delete - marcar como eliminados
      await prisma.usuario.updateMany({
        where: {
          id: { in: ids },
          deleted_at: null,
        },
        data: {
          deleted_at: new Date(),
        },
      });

      res.json({
        success: true,
        message: `${ids.length} usuario(s) eliminado(s) correctamente`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al eliminar usuarios';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }
}

export const usuariosController = new UsuariosController();

