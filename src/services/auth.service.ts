import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import prisma from '../utils/prisma';
import { AuthResponse, JwtPayload, UserResponse } from '../types';

const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';
const ACCESS_TOKEN_EXPIRY = '30d'; // Token de larga duración (30 días)

export interface RegisterData {
  nombre: string;
  correo: string;
  password: string;
  area: string;
  puesto: string;
}

export class AuthService {
  async register(data: RegisterData): Promise<{ message: string }> {
    // Verificar si el correo ya existe
    const existingUser = await prisma.usuario.findFirst({
      where: {
        correo_electronico: data.correo,
        deleted_at: null,
      },
    });

    if (existingUser) {
      throw new Error('El correo electrónico ya está registrado');
    }

    // El rol se asigna automáticamente basado en el puesto
    // (el puesto y el rol son iguales excepto para Administrador)
    const user_role = data.puesto;

    // Crear usuario con contraseña hasheada con bcrypt
    const hashedPassword = await bcrypt.hash(data.password, 10);

    await prisma.usuario.create({
      data: {
        nombre: data.nombre,
        correo_electronico: data.correo,
        user_password: hashedPassword,
        area: data.area,
        puesto: data.puesto,
        user_role: user_role,
        created_at: new Date(),
      },
    });

    return { message: 'Usuario registrado correctamente' };
  }

  async login(email: string, password: string): Promise<AuthResponse> {
    // Buscar usuario por email
    const user = await prisma.usuario.findFirst({
      where: {
        correo_electronico: email,
        deleted_at: null,
      },
    });

    if (!user || !user.user_password) {
      throw new Error('Credenciales invalidas');
    }

    // Verificar contraseña con bcrypt
    const isValid = await bcrypt.compare(password, user.user_password);

    if (!isValid) {
      throw new Error('Credenciales invalidas');
    }

    // Obtener los equipos del usuario
    const userTeams = await prisma.usuario_equipo.findMany({
      where: {
        usuario_id: user.id,
        equipo: {
          deleted_at: null,
        },
      },
      include: {
        equipo: {
          select: {
            id: true,
            nombre: true,
            color: true,
          },
        },
      },
    });

    const equipos = userTeams.map((t: { equipo: { id: number; nombre: string; color: string | null }; rol: string | null }) => ({
      id: t.equipo.id,
      nombre: t.equipo.nombre,
      color: t.equipo.color,
      rol_equipo: t.rol,
    }));

    const payload: JwtPayload = {
      userId: user.id,
      email: user.correo_electronico,
      rol: user.user_role,
      nombre: user.nombre, // Add name to payload
    };

    const accessToken = jwt.sign(payload, JWT_SECRET, {
      expiresIn: ACCESS_TOKEN_EXPIRY,
    });

    const userResponse: UserResponse = {
      id: user.id,
      nombre: user.nombre,
      email: user.correo_electronico,
      rol: user.user_role,
      area: user.area || '',
      puesto: user.puesto || '',
      foto_perfil: user.foto_perfil,
      equipos,
    };

    return {
      accessToken,
      user: userResponse,
    };
  }

  async getProfile(userId: number): Promise<UserResponse> {
    const user = await prisma.usuario.findFirst({
      where: {
        id: userId,
        deleted_at: null
      },
    });

    if (!user) {
      throw new Error('Usuario no encontrado');
    }

    // Obtener los equipos del usuario
    const userTeams = await prisma.usuario_equipo.findMany({
      where: {
        usuario_id: userId,
        equipo: {
          deleted_at: null,
        },
      },
      include: {
        equipo: {
          select: {
            id: true,
            nombre: true,
            color: true,
          },
        },
      },
    });

    const equipos = userTeams.map((t: { equipo: { id: number; nombre: string; color: string | null }; rol: string | null }) => ({
      id: t.equipo.id,
      nombre: t.equipo.nombre,
      color: t.equipo.color,
      rol_equipo: t.rol,
    }));

    return {
      id: user.id,
      nombre: user.nombre,
      email: user.correo_electronico,
      rol: user.user_role,
      area: user.area,
      puesto: user.puesto,
      foto_perfil: user.foto_perfil,
      equipos,
    };
  }

  async updateProfile(userId: number, data: { nombre?: string; area?: string; puesto?: string }): Promise<UserResponse> {
    const user = await prisma.usuario.findFirst({
      where: {
        id: userId,
        deleted_at: null
      },
    });

    if (!user) {
      throw new Error('Usuario no encontrado');
    }

    const updated = await prisma.usuario.update({
      where: { id: userId },
      data: {
        ...(data.nombre !== undefined && { nombre: data.nombre }),
        ...(data.area !== undefined && { area: data.area }),
        ...(data.puesto !== undefined && { puesto: data.puesto }),
        updated_at: new Date(),
      },
    });

    return {
      id: updated.id,
      nombre: updated.nombre,
      email: updated.correo_electronico,
      rol: updated.user_role,
      area: updated.area,
      puesto: updated.puesto,
      foto_perfil: updated.foto_perfil,
    };
  }

  async updateFotoPerfil(userId: number, fotoPath: string): Promise<UserResponse> {
    const user = await prisma.usuario.findFirst({
      where: {
        id: userId,
        deleted_at: null
      },
    });

    if (!user) {
      throw new Error('Usuario no encontrado');
    }

    const updated = await prisma.usuario.update({
      where: { id: userId },
      data: {
        foto_perfil: fotoPath,
        updated_at: new Date(),
      },
    });

    return {
      id: updated.id,
      nombre: updated.nombre,
      email: updated.correo_electronico,
      rol: updated.user_role,
      area: updated.area,
      puesto: updated.puesto,
      foto_perfil: updated.foto_perfil,
    };
  }

  async changePassword(userId: number, currentPassword: string, newPassword: string): Promise<void> {
    // Buscar usuario por ID
    const user = await prisma.usuario.findFirst({
      where: {
        id: userId,
        deleted_at: null,
      },
    });

    if (!user || !user.user_password) {
      throw new Error('Contraseña actual incorrecta');
    }

    // Verificar contraseña actual con bcrypt
    const isValid = await bcrypt.compare(currentPassword, user.user_password);

    if (!isValid) {
      throw new Error('Contraseña actual incorrecta');
    }

    // Actualizar con nueva contraseña hasheada con bcrypt
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await prisma.usuario.update({
      where: { id: userId },
      data: {
        user_password: hashedPassword,
        updated_at: new Date(),
      },
    });
  }
}

export const authService = new AuthService();
