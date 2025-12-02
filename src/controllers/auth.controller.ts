import { Request, Response } from 'express';
import { validationResult } from 'express-validator';
import { authService } from '../services/auth.service';
import { AuthRequest } from '../types';

export class AuthController {
  async login(req: Request, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          error: 'Datos de entrada inválidos',
          details: errors.array(),
        });
        return;
      }

      const { email, password } = req.body;
      const result = await authService.login(email, password);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al iniciar sesión';
      res.status(401).json({
        success: false,
        error: message,
      });
    }
  }

  async refresh(req: Request, res: Response): Promise<void> {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        res.status(400).json({
          success: false,
          error: 'Refresh token requerido',
        });
        return;
      }

      const result = await authService.refreshToken(refreshToken);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al refrescar token';
      res.status(401).json({
        success: false,
        error: message,
      });
    }
  }

  async profile(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          error: 'No autenticado',
        });
        return;
      }

      const user = await authService.getProfile(req.user.userId);

      res.json({
        success: true,
        data: user,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener perfil';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async logout(_req: Request, res: Response): Promise<void> {
    res.json({
      success: true,
      message: 'Sesión cerrada correctamente',
    });
  }
}

export const authController = new AuthController();
