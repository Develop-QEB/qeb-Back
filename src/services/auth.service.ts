import jwt from 'jsonwebtoken';
import prisma from '../utils/prisma';
import { AuthResponse, JwtPayload, UserResponse } from '../types';

const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'default-refresh-secret';
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY = '7d';

export class AuthService {
  async login(email: string, password: string): Promise<AuthResponse> {
    // Verificar credenciales usando ENCRYPT() de MySQL
    const users = await prisma.$queryRaw<Array<{
      id: number;
      nombre: string;
      correo_electronico: string;
      user_password: string | null;
      user_role: string;
      area: string | null;
      puesto: string | null;
      foto_perfil: string | null;
    }>>`
      SELECT id, nombre, correo_electronico, user_password, user_role, area, puesto, foto_perfil
      FROM usuario
      WHERE correo_electronico = ${email}
        AND deleted_at IS NULL
        AND user_password = ENCRYPT(${password}, user_password)
    `;

    const user = users[0];

    if (!user) {
      throw new Error('Credenciales invalidas');
    }

    const payload: JwtPayload = {
      userId: user.id,
      email: user.correo_electronico,
      rol: user.user_role,
      nombre: user.nombre, // Add name to payload
    };

    const accessToken = jwt.sign(payload, JWT_SECRET, {
      expiresIn: ACCESS_TOKEN_EXPIRY,
    });

    const refreshToken = jwt.sign(payload, JWT_REFRESH_SECRET, {
      expiresIn: REFRESH_TOKEN_EXPIRY,
    });

    const userResponse: UserResponse = {
      id: user.id,
      nombre: user.nombre,
      email: user.correo_electronico,
      rol: user.user_role,
      area: user.area || '',
      puesto: user.puesto || '',
      foto_perfil: user.foto_perfil,
    };

    return {
      accessToken,
      refreshToken,
      user: userResponse,
    };
  }

  async refreshToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    try {
      const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET) as JwtPayload;

      const user = await prisma.usuario.findFirst({
        where: {
          id: decoded.userId,
          deleted_at: null
        },
      });

      if (!user) {
        throw new Error('Usuario no valido');
      }

      const payload: JwtPayload = {
        userId: user.id,
        email: user.correo_electronico,
        rol: user.user_role,
      };

      const newAccessToken = jwt.sign(payload, JWT_SECRET, {
        expiresIn: ACCESS_TOKEN_EXPIRY,
      });

      const newRefreshToken = jwt.sign(payload, JWT_REFRESH_SECRET, {
        expiresIn: REFRESH_TOKEN_EXPIRY,
      });

      return {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      };
    } catch {
      throw new Error('Refresh token invalido');
    }
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

    return {
      id: user.id,
      nombre: user.nombre,
      email: user.correo_electronico,
      rol: user.user_role,
      area: user.area,
      puesto: user.puesto,
      foto_perfil: user.foto_perfil,
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
    // Verificar contraseña actual usando ENCRYPT() de MySQL
    const users = await prisma.$queryRaw<Array<{ id: number }>>`
      SELECT id FROM usuario
      WHERE id = ${userId}
        AND deleted_at IS NULL
        AND user_password = ENCRYPT(${currentPassword}, user_password)
    `;

    if (users.length === 0) {
      throw new Error('Contraseña actual incorrecta');
    }

    // Actualizar con nueva contraseña usando ENCRYPT()
    await prisma.$executeRaw`
      UPDATE usuario
      SET user_password = ENCRYPT(${newPassword}, CONCAT('$6$', SUBSTRING(SHA2(UUID(), 256), 1, 16))),
          updated_at = NOW()
      WHERE id = ${userId}
    `;
  }
}

export const authService = new AuthService();
