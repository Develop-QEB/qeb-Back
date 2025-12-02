import { Router } from 'express';
import { body } from 'express-validator';
import { authController } from '../controllers/auth.controller';
import { authMiddleware } from '../middleware/auth.middleware';

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

router.post('/logout', authMiddleware, authController.logout.bind(authController));

export default router;
