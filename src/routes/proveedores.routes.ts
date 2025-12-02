import { Router } from 'express';
import { body } from 'express-validator';
import { proveedoresController } from '../controllers/proveedores.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.use(authMiddleware);

const proveedorValidation = [
  body('nombre').notEmpty().withMessage('Nombre requerido'),
  body('email').optional().isEmail().withMessage('Email inválido'),
  body('rfc').optional().isLength({ min: 12, max: 13 }).withMessage('RFC inválido'),
];

router.get('/', proveedoresController.getAll.bind(proveedoresController));
router.get('/:id/history', proveedoresController.getHistory.bind(proveedoresController));
router.get('/:id', proveedoresController.getById.bind(proveedoresController));
router.post('/', proveedorValidation, proveedoresController.create.bind(proveedoresController));
router.put('/:id', proveedorValidation, proveedoresController.update.bind(proveedoresController));
router.delete('/:id', proveedoresController.delete.bind(proveedoresController));

export default router;
