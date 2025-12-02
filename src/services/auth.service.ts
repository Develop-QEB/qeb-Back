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
    }>>`
      SELECT id, nombre, correo_electronico, user_password, user_role, area, puesto
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
    };
  }
}

export const authService = new AuthService();
