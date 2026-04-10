import { Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';
import bcrypt from 'bcryptjs';
import { authService } from '../services/auth.service';

export class UsuariosController {
  async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      // Verificar que el usuario sea Administrador
      if (!['Administrador', 'DEV'].includes(req.user?.rol || '')) {
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
      if (!['Administrador', 'DEV'].includes(req.user?.rol || '')) {
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
          equipos: {
            include: {
              equipo: {
                select: {
                  id: true,
                  nombre: true,
                  color: true,
                  deleted_at: true,
                },
              },
            },
          },
        },
        orderBy: {
          nombre: 'asc',
        },
      });

      const formattedUsers = usuarios.map((u) => {
        const equiposActivos = u.equipos.filter((e) => e.equipo.deleted_at === null);
        const equiposAdmin = equiposActivos.filter((e) => e.rol === 'Administrador');

        return {
          id: u.id,
          nombre: u.nombre,
          email: u.correo_electronico,
          area: u.area,
          puesto: u.puesto,
          rol: u.user_role,
          foto_perfil: u.foto_perfil,
          created_at: u.created_at,
          total_equipos: equiposActivos.length,
          equipos_admin: equiposAdmin.map((e) => ({
            id: e.equipo.id,
            nombre: e.equipo.nombre,
            color: e.equipo.color,
          })),
          equipos: equiposActivos.map((e) => ({
            id: e.equipo.id,
            nombre: e.equipo.nombre,
            color: e.equipo.color,
            rol_equipo: e.rol,
          })),
        };
      });

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
      if (!['Administrador', 'DEV'].includes(req.user?.rol || '')) {
        res.status(403).json({
          success: false,
          error: 'No tienes permisos para realizar esta acción',
        });
        return;
      }

      const { id } = req.params;
      const { nombre, correo_electronico, area, puesto, rol } = req.body;

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

      // Solo un DEV puede asignar o quitar el rol DEV
      if (rol !== undefined) {
        const isSettingDev = rol === 'DEV';
        const isRemovingDev = usuario.user_role === 'DEV' && rol !== 'DEV';
        if ((isSettingDev || isRemovingDev) && req.user?.rol !== 'DEV') {
          res.status(403).json({
            success: false,
            error: 'Solo un usuario DEV puede asignar o quitar el rol DEV',
          });
          return;
        }
      }

      const updated = await prisma.usuario.update({
        where: { id: parseInt(id) },
        data: {
          ...(nombre !== undefined && { nombre }),
          ...(correo_electronico !== undefined && { correo_electronico }),
          ...(area !== undefined && { area }),
          ...(puesto !== undefined && { puesto }),
          ...(rol !== undefined && { user_role: rol }),
          updated_at: new Date(),
        },
      });

      const responseData: any = {
        id: updated.id,
        nombre: updated.nombre,
        email: updated.correo_electronico,
        area: updated.area,
        puesto: updated.puesto,
        rol: updated.user_role,
        foto_perfil: updated.foto_perfil,
        created_at: updated.created_at,
      };

      // Si el usuario editado es el que está logueado, generar nuevos tokens
      if (req.user?.userId === updated.id) {
        const newAuth = await authService.impersonate(updated.id);
        responseData.newTokens = {
          accessToken: newAuth.accessToken,
          refreshToken: newAuth.refreshToken,
          user: newAuth.user,
        };
      }

      res.json({
        success: true,
        data: responseData,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al actualizar usuario';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async adminResetPassword(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!['Administrador', 'DEV'].includes(req.user?.rol || '')) {
        res.status(403).json({ success: false, error: 'No tienes permisos para realizar esta acción' });
        return;
      }

      const { id } = req.params;
      const { nuevaPassword } = req.body;

      if (!nuevaPassword || nuevaPassword.length < 6) {
        res.status(400).json({ success: false, error: 'La contraseña debe tener al menos 6 caracteres' });
        return;
      }

      const usuario = await prisma.usuario.findFirst({ where: { id: parseInt(id), deleted_at: null } });
      if (!usuario) {
        res.status(404).json({ success: false, error: 'Usuario no encontrado' });
        return;
      }

      const hash = await bcrypt.hash(nuevaPassword, 10);
      await prisma.usuario.update({
        where: { id: parseInt(id) },
        data: { user_password: hash, updated_at: new Date() },
      });

      res.json({ success: true, message: 'Contraseña restablecida correctamente' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al restablecer contraseña';
      res.status(500).json({ success: false, error: message });
    }
  }

  async deleteMany(req: AuthRequest, res: Response): Promise<void> {
    try {
      // Verificar que el usuario sea Administrador
      if (!['Administrador', 'DEV'].includes(req.user?.rol || '')) {
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
      if (ids.includes(req.user!.userId)) {
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
  async impersonate(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (req.user?.rol !== 'DEV') {
        res.status(403).json({
          success: false,
          error: 'Solo el rol DEV puede realizar esta acción',
        });
        return;
      }

      const targetId = parseInt(req.params.id);
      const result = await authService.impersonate(targetId);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al impersonar usuario';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async getAssignments(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!['Administrador', 'DEV'].includes(req.user?.rol || '')) {
        res.status(403).json({ success: false, error: 'No tienes permisos' });
        return;
      }

      const userId = parseInt(req.params.id);
      const userIdStr = String(userId);

      const solicitudes = await prisma.$queryRawUnsafe<any[]>(
        `SELECT id, razon_social, marca_nombre, status
         FROM solicitud
         WHERE deleted_at IS NULL
         AND FIND_IN_SET(?, REPLACE(IFNULL(id_asignado, ''), ' ', '')) > 0`,
        userIdStr
      );

      const propuestas = await prisma.$queryRawUnsafe<any[]>(
        `SELECT id, solicitud_id, status, articulo
         FROM propuesta
         WHERE deleted_at IS NULL
         AND FIND_IN_SET(?, REPLACE(IFNULL(id_asignado, ''), ' ', '')) > 0`,
        userIdStr
      );

      const tareas = await prisma.$queryRawUnsafe<any[]>(
        `SELECT id, titulo, estatus, campania_id
         FROM tareas
         WHERE (estatus IS NULL OR estatus NOT IN ('completada', 'Completada', 'resuelta', 'Resuelta'))
         AND (id_responsable = ? OR FIND_IN_SET(?, REPLACE(IFNULL(id_asignado, ''), ' ', '')) > 0)`,
        userId, userIdStr
      );

      const serialize = (arr: any[]) => JSON.parse(JSON.stringify(arr, (_, v) => typeof v === 'bigint' ? Number(v) : v));

      res.json({
        success: true,
        data: {
          solicitudes: serialize(solicitudes),
          propuestas: serialize(propuestas),
          tareas: serialize(tareas),
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener asignaciones';
      res.status(500).json({ success: false, error: message });
    }
  }

  async reassign(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!['Administrador', 'DEV'].includes(req.user?.rol || '')) {
        res.status(403).json({ success: false, error: 'No tienes permisos' });
        return;
      }

      const userId = parseInt(req.params.id);
      const { reassignments } = req.body;

      const oldUser = await prisma.usuario.findFirst({ where: { id: userId } });
      if (!oldUser) {
        res.status(404).json({ success: false, error: 'Usuario no encontrado' });
        return;
      }

      // Cargar todos los newUser de una sola vez en vez de 1 query por reasignación
      const newUserIds: number[] = [...new Set(reassignments.map((r: any) => r.newUserId))] as number[];
      const newUsers = await prisma.usuario.findMany({
        where: { id: { in: newUserIds }, deleted_at: null },
        select: { id: true, nombre: true },
      });
      const newUserCache = new Map(newUsers.map(u => [u.id, u]));

      // Cargar todos los registros a reasignar de una sola vez
      const solIds = reassignments.filter((r: any) => r.type === 'solicitud').map((r: any) => r.id);
      const propIds = reassignments.filter((r: any) => r.type === 'propuesta').map((r: any) => r.id);
      const tareaIds = reassignments.filter((r: any) => r.type === 'tarea').map((r: any) => r.id);

      const [solicitudes, propuestas, tareas] = await Promise.all([
        solIds.length > 0 ? prisma.solicitud.findMany({ where: { id: { in: solIds } } }) : Promise.resolve([]),
        propIds.length > 0 ? prisma.propuesta.findMany({ where: { id: { in: propIds } } }) : Promise.resolve([]),
        tareaIds.length > 0 ? prisma.tareas.findMany({ where: { id: { in: tareaIds } } }) : Promise.resolve([]),
      ]);

      const solMap = new Map(solicitudes.map(s => [s.id, s]));
      const propMap = new Map(propuestas.map(p => [p.id, p]));
      const tareaMap = new Map(tareas.map(t => [t.id, t]));

      // Preparar todas las operaciones de update
      const ops: any[] = [];

      for (const r of reassignments) {
        const newUser = newUserCache.get(r.newUserId);
        if (!newUser) continue;

        const replaceId = (str: string | null) => {
          if (!str) return String(newUser.id);
          const parts = str.split(',').map(s => s.trim()).filter(Boolean);
          const idx = parts.indexOf(String(userId));
          if (idx !== -1) parts[idx] = String(newUser.id);
          return parts.join(', ');
        };

        const replaceName = (str: string | null) => {
          if (!str) return newUser.nombre;
          const parts = str.split(',').map(s => s.trim()).filter(Boolean);
          const idx = parts.indexOf(oldUser.nombre);
          if (idx !== -1) parts[idx] = newUser.nombre;
          return parts.join(', ');
        };

        if (r.type === 'solicitud') {
          const sol = solMap.get(r.id);
          if (!sol) continue;
          ops.push(prisma.solicitud.update({
            where: { id: r.id },
            data: { id_asignado: replaceId(sol.id_asignado), asignado: replaceName(sol.asignado) },
          }));
        } else if (r.type === 'propuesta') {
          const prop = propMap.get(r.id);
          if (!prop) continue;
          ops.push(prisma.propuesta.update({
            where: { id: r.id },
            data: { id_asignado: replaceId(prop.id_asignado), asignado: replaceName(prop.asignado) },
          }));
        } else if (r.type === 'tarea') {
          const tarea = tareaMap.get(r.id);
          if (!tarea) continue;
          const updateData: Record<string, unknown> = {};
          if (tarea.id_responsable === userId) {
            updateData.id_responsable = newUser.id;
            updateData.responsable = newUser.nombre;
          }
          if (tarea.id_asignado && tarea.id_asignado.split(',').map(s => s.trim()).includes(String(userId))) {
            updateData.id_asignado = replaceId(tarea.id_asignado);
            updateData.asignado = replaceName(tarea.asignado);
          }
          if (Object.keys(updateData).length > 0) {
            ops.push(prisma.tareas.update({ where: { id: r.id }, data: updateData }));
          }
        }
      }

      // Ejecutar todos los updates en una sola transacción
      if (ops.length > 0) {
        await prisma.$transaction(ops);
      }

      res.json({ success: true, message: 'Reasignaciones completadas' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al reasignar';
      res.status(500).json({ success: false, error: message });
    }
  }
}

export const usuariosController = new UsuariosController();

