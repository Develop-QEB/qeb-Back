import { Router } from 'express';
import { solicitudesController } from '../controllers/solicitudes.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.use(authMiddleware);

router.get('/', solicitudesController.getAll.bind(solicitudesController));
router.get('/stats', solicitudesController.getStats.bind(solicitudesController));
router.get('/catorcenas', solicitudesController.getCatorcenas.bind(solicitudesController));
router.get('/export', solicitudesController.exportAll.bind(solicitudesController));
router.get('/:id', solicitudesController.getById.bind(solicitudesController));
router.patch('/:id/status', solicitudesController.updateStatus.bind(solicitudesController));
router.delete('/:id', solicitudesController.delete.bind(solicitudesController));

export default router;
