import { Router, Request, Response } from 'express';
import { body } from 'express-validator';
import { authController } from '../controllers/auth.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { uploadProfilePhoto } from '../middleware/upload.middleware';
import {
  limiteLogin,
  limiteOlvidePassword,
  limiteResetPassword,
  limiteCambioPassword,
} from '../middleware/rateLimit.middleware';

const router = Router();

/**
 * Se eliminó POST /auth/register (nov-2026).
 *
 * Era alta de usuarios abierta a internet y, peor, el rol se tomaba del propio
 * formulario: `user_role = area === 'Desarrollo' ? 'DEV' : puesto`. Cualquiera
 * que alcanzara la API podía crearse una cuenta con rol DEV, que tiene
 * visibilidad total y acceso a /api/usuarios/:id/impersonate.
 *
 * El alta real vive en POST /api/usuarios, que exige sesión y rol
 * Administrador o DEV, y asigna el rol desde el catálogo, no desde el body.
 */

router.post(
  '/login',
  limiteLogin,
  [
    body('email').isEmail().withMessage('Email inválido'),
    body('password').notEmpty().withMessage('Password requerido'),
  ],
  authController.login.bind(authController)
);

router.post('/refresh', authController.refresh.bind(authController));

router.get('/profile', authMiddleware, authController.profile.bind(authController));

router.patch('/profile', authMiddleware, authController.updateProfile.bind(authController));

router.post(
  '/change-password',
  authMiddleware,
  limiteCambioPassword,
  authController.changePassword.bind(authController)
);

router.post(
  '/upload-photo',
  authMiddleware,
  uploadProfilePhoto.single('foto'),
  authController.uploadPhoto.bind(authController)
);

router.post('/mark-light-theme-notified', authMiddleware, authController.markLightThemeNotified.bind(authController));

router.get('/version', authMiddleware, authController.getLatestVersion.bind(authController));
router.post('/mark-version-notified', authMiddleware, authController.markVersionNotified.bind(authController));

router.post('/logout', authMiddleware, authController.logout.bind(authController));

router.post(
  '/forgot-password',
  limiteOlvidePassword,
  [body('correo').isEmail().withMessage('Email inválido')],
  (req: Request, res: Response) => authController.forgotPassword(req, res)
);

router.post(
  '/reset-password',
  limiteResetPassword,
  [
    body('correo').isEmail().withMessage('Email inválido'),
    body('codigo').isLength({ min: 6, max: 6 }).withMessage('Código inválido'),
    body('nuevaPassword')
      .isLength({ min: 8 })
      .withMessage('La contraseña debe tener al menos 8 caracteres'),
  ],
  (req: Request, res: Response) => authController.resetPassword(req, res)
);

export default router;
