import { Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';

export class EquiposController {
  // Obtener todos los equipos con sus miembros
  async getAll(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (req.user?.rol !== 'Administrador') {
        res.status(403).json({
          success: false,
          error: 'No tienes permisos para acceder a esta sección',
        });
        return;
      }

      const equipos = await prisma.equipo.findMany({
        where: {
          deleted_at: null,
        },
        include: {
          miembros: {
            include: {
              usuario: {
                select: {
                  id: true,
                  nombre: true,
                  correo_electronico: true,
                  area: true,
                  puesto: true,
                  user_role: true,
                  foto_perfil: true,
                },
              },
            },
          },
        },
        orderBy: {
          nombre: 'asc',
        },
      });

      const formattedEquipos = equipos.map((e) => ({
        id: e.id,
        nombre: e.nombre,
        descripcion: e.descripcion,
        color: e.color,
        created_at: e.created_at,
        miembros: e.miembros.map((m) => ({
          id: m.usuario.id,
          nombre: m.usuario.nombre,
          email: m.usuario.correo_electronico,
          area: m.usuario.area,
          puesto: m.usuario.puesto,
          rol: m.usuario.user_role,
          foto_perfil: m.usuario.foto_perfil,
          rol_equipo: m.rol,
        })),
      }));

      res.json({
        success: true,
        data: formattedEquipos,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener equipos';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Crear un nuevo equipo
  async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (req.user?.rol !== 'Administrador') {
        res.status(403).json({
          success: false,
          error: 'No tienes permisos para realizar esta acción',
        });
        return;
      }

      const { nombre, descripcion, color } = req.body;

      if (!nombre) {
        res.status(400).json({
          success: false,
          error: 'El nombre del equipo es requerido',
        });
        return;
      }

      const equipo = await prisma.equipo.create({
        data: {
          nombre,
          descripcion: descripcion || null,
          color: color || '#8B5CF6',
          created_at: new Date(),
        },
      });

      res.status(201).json({
        success: true,
        data: {
          id: equipo.id,
          nombre: equipo.nombre,
          descripcion: equipo.descripcion,
          color: equipo.color,
          created_at: equipo.created_at,
          miembros: [],
        },
      });
    } catch (error) {
      console.error('Error creating equipo:', error);
      const message = error instanceof Error ? error.message : 'Error al crear equipo';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Actualizar un equipo
  async update(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (req.user?.rol !== 'Administrador') {
        res.status(403).json({
          success: false,
          error: 'No tienes permisos para realizar esta acción',
        });
        return;
      }

      const { id } = req.params;
      const { nombre, descripcion, color } = req.body;

      const equipo = await prisma.equipo.findFirst({
        where: {
          id: parseInt(id),
          deleted_at: null,
        },
      });

      if (!equipo) {
        res.status(404).json({
          success: false,
          error: 'Equipo no encontrado',
        });
        return;
      }

      const updated = await prisma.equipo.update({
        where: { id: parseInt(id) },
        data: {
          ...(nombre !== undefined && { nombre }),
          ...(descripcion !== undefined && { descripcion }),
          ...(color !== undefined && { color }),
          updated_at: new Date(),
        },
        include: {
          miembros: {
            include: {
              usuario: {
                select: {
                  id: true,
                  nombre: true,
                  correo_electronico: true,
                  area: true,
                  puesto: true,
                  user_role: true,
                  foto_perfil: true,
                },
              },
            },
          },
        },
      });

      res.json({
        success: true,
        data: {
          id: updated.id,
          nombre: updated.nombre,
          descripcion: updated.descripcion,
          color: updated.color,
          created_at: updated.created_at,
          miembros: updated.miembros.map((m) => ({
            id: m.usuario.id,
            nombre: m.usuario.nombre,
            email: m.usuario.correo_electronico,
            area: m.usuario.area,
            puesto: m.usuario.puesto,
            rol: m.usuario.user_role,
            foto_perfil: m.usuario.foto_perfil,
            rol_equipo: m.rol,
          })),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al actualizar equipo';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Eliminar un equipo (soft delete)
  async delete(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (req.user?.rol !== 'Administrador') {
        res.status(403).json({
          success: false,
          error: 'No tienes permisos para realizar esta acción',
        });
        return;
      }

      const { id } = req.params;

      const equipo = await prisma.equipo.findFirst({
        where: {
          id: parseInt(id),
          deleted_at: null,
        },
      });

      if (!equipo) {
        res.status(404).json({
          success: false,
          error: 'Equipo no encontrado',
        });
        return;
      }

      await prisma.equipo.update({
        where: { id: parseInt(id) },
        data: {
          deleted_at: new Date(),
        },
      });

      res.json({
        success: true,
        message: 'Equipo eliminado correctamente',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al eliminar equipo';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Agregar miembro(s) a un equipo
  async addMembers(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (req.user?.rol !== 'Administrador') {
        res.status(403).json({
          success: false,
          error: 'No tienes permisos para realizar esta acción',
        });
        return;
      }

      const { id } = req.params;
      const { usuario_ids, rol } = req.body;

      if (!usuario_ids || !Array.isArray(usuario_ids) || usuario_ids.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Debe proporcionar al menos un usuario',
        });
        return;
      }

      const equipo = await prisma.equipo.findFirst({
        where: {
          id: parseInt(id),
          deleted_at: null,
        },
      });

      if (!equipo) {
        res.status(404).json({
          success: false,
          error: 'Equipo no encontrado',
        });
        return;
      }

      // Crear relaciones para cada usuario
      const createdRelations = await Promise.all(
        usuario_ids.map(async (usuario_id: number) => {
          try {
            return await prisma.usuario_equipo.create({
              data: {
                usuario_id,
                equipo_id: parseInt(id),
                rol: rol || null,
                created_at: new Date(),
              },
            });
          } catch (error) {
            // Ignorar errores de duplicados
            return null;
          }
        })
      );

      const addedCount = createdRelations.filter((r) => r !== null).length;

      // Obtener el equipo actualizado con miembros
      const updated = await prisma.equipo.findUnique({
        where: { id: parseInt(id) },
        include: {
          miembros: {
            include: {
              usuario: {
                select: {
                  id: true,
                  nombre: true,
                  correo_electronico: true,
                  area: true,
                  puesto: true,
                  user_role: true,
                  foto_perfil: true,
                },
              },
            },
          },
        },
      });

      res.json({
        success: true,
        message: `${addedCount} miembro(s) agregado(s) al equipo`,
        data: {
          id: updated!.id,
          nombre: updated!.nombre,
          descripcion: updated!.descripcion,
          color: updated!.color,
          created_at: updated!.created_at,
          miembros: updated!.miembros.map((m) => ({
            id: m.usuario.id,
            nombre: m.usuario.nombre,
            email: m.usuario.correo_electronico,
            area: m.usuario.area,
            puesto: m.usuario.puesto,
            rol: m.usuario.user_role,
            foto_perfil: m.usuario.foto_perfil,
            rol_equipo: m.rol,
          })),
        },
      });
    } catch (error) {
      console.error('Error adding members:', error);
      const message = error instanceof Error ? error.message : 'Error al agregar miembros';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Remover miembro(s) de un equipo
  async removeMembers(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (req.user?.rol !== 'Administrador') {
        res.status(403).json({
          success: false,
          error: 'No tienes permisos para realizar esta acción',
        });
        return;
      }

      const { id } = req.params;
      const { usuario_ids } = req.body;

      if (!usuario_ids || !Array.isArray(usuario_ids) || usuario_ids.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Debe proporcionar al menos un usuario',
        });
        return;
      }

      await prisma.usuario_equipo.deleteMany({
        where: {
          equipo_id: parseInt(id),
          usuario_id: { in: usuario_ids },
        },
      });

      // Obtener el equipo actualizado con miembros
      const updated = await prisma.equipo.findUnique({
        where: { id: parseInt(id) },
        include: {
          miembros: {
            include: {
              usuario: {
                select: {
                  id: true,
                  nombre: true,
                  correo_electronico: true,
                  area: true,
                  puesto: true,
                  user_role: true,
                  foto_perfil: true,
                },
              },
            },
          },
        },
      });

      if (!updated) {
        res.status(404).json({
          success: false,
          error: 'Equipo no encontrado',
        });
        return;
      }

      res.json({
        success: true,
        message: `${usuario_ids.length} miembro(s) removido(s) del equipo`,
        data: {
          id: updated.id,
          nombre: updated.nombre,
          descripcion: updated.descripcion,
          color: updated.color,
          created_at: updated.created_at,
          miembros: updated.miembros.map((m) => ({
            id: m.usuario.id,
            nombre: m.usuario.nombre,
            email: m.usuario.correo_electronico,
            area: m.usuario.area,
            puesto: m.usuario.puesto,
            rol: m.usuario.user_role,
            foto_perfil: m.usuario.foto_perfil,
            rol_equipo: m.rol,
          })),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al remover miembros';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  // Obtener usuarios disponibles (que no están en un equipo específico)
  async getAvailableUsers(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (req.user?.rol !== 'Administrador') {
        res.status(403).json({
          success: false,
          error: 'No tienes permisos para acceder a esta sección',
        });
        return;
      }

      const { id } = req.params;

      // Obtener IDs de usuarios ya en el equipo
      const existingMembers = await prisma.usuario_equipo.findMany({
        where: {
          equipo_id: parseInt(id),
        },
        select: {
          usuario_id: true,
        },
      });

      const existingIds = existingMembers.map((m) => m.usuario_id);

      // Obtener usuarios que NO están en el equipo
      const usuarios = await prisma.usuario.findMany({
        where: {
          deleted_at: null,
          id: { notIn: existingIds.length > 0 ? existingIds : [-1] },
        },
        select: {
          id: true,
          nombre: true,
          correo_electronico: true,
          area: true,
          puesto: true,
          user_role: true,
          foto_perfil: true,
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
      }));

      res.json({
        success: true,
        data: formattedUsers,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener usuarios disponibles';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }
}

export const equiposController = new EquiposController();
