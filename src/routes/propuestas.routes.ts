import { Router } from 'express';
import { propuestasController } from '../controllers/propuestas.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.use(authMiddleware);

router.get('/', propuestasController.getAll.bind(propuestasController));
router.get('/stats', propuestasController.getStats.bind(propuestasController));
router.get('/:id', propuestasController.getById.bind(propuestasController));
router.get('/:id/comments', propuestasController.getComments.bind(propuestasController));
router.post('/:id/comments', propuestasController.addComment.bind(propuestasController));
router.patch('/:id/status', propuestasController.updateStatus.bind(propuestasController));
router.post('/:id/approve', propuestasController.approve.bind(propuestasController));

export default router;
