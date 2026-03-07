import { Request, Response } from 'express';
import { validationResult } from 'express-validator';
import { authService } from '../services/auth.service';
import { AuthRequest } from '../types';

export class AuthController {
  async register(req: Request, res: Response): Promise<void> {
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

      const { nombre, correo, password, area, puesto } = req.body;
      const result = await authService.register({ nombre, correo, password, area, puesto });

      res.status(201).json({
        success: true,
        data: result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al registrar usuario';
      res.status(400).json({
        success: false,
        error: message,
      });
    }
  }

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

  async refresh(_req: Request, res: Response): Promise<void> {
    // Refresh token deshabilitado - usar token de larga duración
    res.status(410).json({
      success: false,
      error: 'Refresh token deshabilitado. Por favor inicia sesión nuevamente.',
    });
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

  async updateProfile(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          error: 'No autenticado',
        });
        return;
      }

      const { nombre, area, puesto } = req.body;

      const user = await authService.updateProfile(req.user.userId, {
        nombre,
        area,
        puesto,
      });

      res.json({
        success: true,
        data: user,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al actualizar perfil';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }

  async changePassword(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          error: 'No autenticado',
        });
        return;
      }

      const { currentPassword, newPassword } = req.body;

      if (!currentPassword || !newPassword) {
        res.status(400).json({
          success: false,
          error: 'Se requiere contraseña actual y nueva',
        });
        return;
      }

      if (newPassword.length < 6) {
        res.status(400).json({
          success: false,
          error: 'La nueva contraseña debe tener al menos 6 caracteres',
        });
        return;
      }

      await authService.changePassword(req.user.userId, currentPassword, newPassword);

      res.json({
        success: true,
        message: 'Contraseña actualizada correctamente',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al cambiar contraseña';
      res.status(400).json({
        success: false,
        error: message,
      });
    }
  }

  async uploadPhoto(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          error: 'No autenticado',
        });
        return;
      }

      if (!req.file) {
        res.status(400).json({
          success: false,
          error: 'No se ha proporcionado ninguna imagen',
        });
        return;
      }

      // Generar la URL relativa para acceder a la imagen
      const fotoPath = `/uploads/profiles/${req.file.filename}`;

      const user = await authService.updateFotoPerfil(req.user.userId, fotoPath);

      res.json({
        success: true,
        data: user,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al subir la foto';
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }
}

export const authController = new AuthController();
