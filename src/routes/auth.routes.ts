import { Router } from 'express';
import { body } from 'express-validator';
import { authController } from '../controllers/auth.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { uploadProfilePhoto } from '../middleware/upload.middleware';

const router = Router();

router.post(
  '/login',
  [
    body('email').isEmail().withMessage('Email inválido'),
    body('password').notEmpty().withMessage('Password requerido'),
  ],
  authController.login.bind(authController)
);

router.post('/refresh', authController.refresh.bind(authController));

router.get('/profile', authMiddleware, authController.profile.bind(authController));

router.patch('/profile', authMiddleware, authController.updateProfile.bind(authController));

router.post('/change-password', authMiddleware, authController.changePassword.bind(authController));

router.post(
  '/upload-photo',
  authMiddleware,
  uploadProfilePhoto.single('foto'),
  authController.uploadPhoto.bind(authController)
);

router.post('/logout', authMiddleware, authController.logout.bind(authController));

export default router;
