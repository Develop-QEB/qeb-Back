import { Request, Response } from 'express';
import { validationResult } from 'express-validator';
import { authService } from '../services/auth.service';
import { AuthRequest } from '../types';
import { uploadBufferToSpaces } from '../config/spaces';
import prisma from '../utils/prisma';
import nodemailer from 'nodemailer';
import bcrypt from 'bcrypt';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_PORT === '465',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  tls: { rejectUnauthorized: false },
});

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

      const tokens = await authService.refreshToken(refreshToken);

      res.json({
        success: true,
        data: tokens,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Refresh token inválido';
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
      const isAdmin = req.user.rol === 'Administrador';

      const user = await authService.updateProfile(req.user.userId, {
        nombre,
        ...(isAdmin && { area, puesto }),
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

  async forgotPassword(req: Request, res: Response): Promise<void> {
  try {
    const { correo } = req.body;

    const usuario = await prisma.usuario.findFirst({
      where: { correo_electronico: correo, deleted_at: null },
    });

    if (!usuario) {
      res.json({ success: true });
      return;
    }

    const codigo = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 15 * 60 * 1000);

    await prisma.usuario.update({
      where: { id: usuario.id },
      data: { reset_token: codigo, reset_token_expiry: expiry },
    });

    const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
      <div style="text-align: center; background: #8b5cf6; padding: 25px; border-radius: 12px 12px 0 0;">
        <h1 style="color: #ffffff; margin: 0; font-size: 28px;">QEB</h1>
        <p style="color: rgba(255,255,255,0.9); margin: 5px 0 0 0; font-size: 12px;">OOH Management</p>
      </div>
      <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
        <h2 style="color: #1f2937; margin: 0 0 20px 0; font-size: 20px; text-align: center;">Restablecer contraseña</h2>
        <p style="color: #6b7280; font-size: 14px; text-align: center; margin: 0 0 25px 0;">
          Usa este código para restablecer tu contraseña. Expira en <strong>15 minutos</strong>.
        </p>
        <div style="background: #f3f4f6; border-radius: 8px; padding: 25px; text-align: center; margin-bottom: 25px;">
          <div style="font-size: 40px; font-weight: 700; color: #8b5cf6; letter-spacing: 10px; font-family: 'Courier New', monospace;">
            ${codigo}
          </div>
        </div>
        <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 12px 16px; border-radius: 0 8px 8px 0;">
          <p style="margin: 0; color: #92400e; font-size: 13px;">Si no solicitaste esto, ignora este correo.</p>
        </div>
      </div>
      <div style="background: #374151; padding: 15px; border-radius: 0 0 12px 12px; text-align: center;">
        <p style="color: #9ca3af; font-size: 11px; margin: 0;">Mensaje automático del sistema QEB.</p>
      </div>
    </div>`;

    await transporter.sendMail({
      from: process.env.SMTP_FROM || '"QEB Sistema" <no-reply@qeb.mx>',
      to: correo,
      subject: 'Código para restablecer tu contraseña - QEB',
      html: htmlBody,
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Error al procesar solicitud' });
  }
}

async resetPassword(req: Request, res: Response): Promise<void> {
  try {
    const { correo, codigo, nuevaPassword } = req.body;

    const usuario = await prisma.usuario.findFirst({
      where: { correo_electronico: correo, reset_token: codigo, deleted_at: null },
    });

    if (!usuario || !usuario.reset_token_expiry || usuario.reset_token_expiry < new Date()) {
      res.status(400).json({ success: false, error: 'Código inválido o expirado' });
      return;
    }

    const hash = await bcrypt.hash(nuevaPassword, 10);

    await prisma.usuario.update({
      where: { id: usuario.id },
      data: { user_password: hash, reset_token: null, reset_token_expiry: null },
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Error al restablecer contraseña' });
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

      // Subir a Spaces
      const uploaded = await uploadBufferToSpaces(req.file.buffer, {
        folder: 'perfiles',
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
      });

      const user = await authService.updateFotoPerfil(req.user.userId, uploaded.url);

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
