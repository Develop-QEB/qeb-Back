import { Router } from 'express';
import { notasController } from '../controllers/notas.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.use(authMiddleware);

// CRUD de notas personales
router.get('/', notasController.getAll.bind(notasController));
router.get('/:id', notasController.getById.bind(notasController));
router.post('/', notasController.create.bind(notasController));
router.patch('/:id', notasController.update.bind(notasController));
router.put('/:id', notasController.update.bind(notasController));
router.delete('/:id', notasController.delete.bind(notasController));

export default router;
