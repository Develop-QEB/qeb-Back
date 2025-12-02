import { Router } from 'express';
import { propuestasController } from '../controllers/propuestas.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.use(authMiddleware);

router.get('/', propuestasController.getAll.bind(propuestasController));
router.get('/stats', propuestasController.getStats.bind(propuestasController));
router.get('/:id', propuestasController.getById.bind(propuestasController));
router.patch('/:id/status', propuestasController.updateStatus.bind(propuestasController));

export default router;
