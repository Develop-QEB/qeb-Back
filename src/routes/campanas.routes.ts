import { Router } from 'express';
import { campanasController } from '../controllers/campanas.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.use(authMiddleware);

router.get('/', campanasController.getAll.bind(campanasController));
router.get('/stats', campanasController.getStats.bind(campanasController));
router.get('/:id', campanasController.getById.bind(campanasController));
router.get('/:id/inventario', campanasController.getInventarioReservado.bind(campanasController));
router.get('/:id/inventario-aps', campanasController.getInventarioConAPS.bind(campanasController));
router.patch('/:id/status', campanasController.updateStatus.bind(campanasController));
router.post('/:id/comentarios', campanasController.addComment.bind(campanasController));
router.post('/:id/assign-aps', campanasController.assignAPS.bind(campanasController));
router.post('/:id/remove-aps', campanasController.removeAPS.bind(campanasController));

export default router;
