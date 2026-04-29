import { Router } from 'express';
import { historialController } from '../controllers/historial.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.use(authMiddleware);

router.get('/', historialController.getAll.bind(historialController));
router.get('/tipos', historialController.getTipos.bind(historialController));
router.post('/notas', historialController.addNota.bind(historialController));

export default router;
