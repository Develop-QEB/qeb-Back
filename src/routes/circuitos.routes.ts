import { Router } from 'express';
import { circuitosController } from '../controllers/circuitos.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.use(authMiddleware);

router.get('/list', circuitosController.list.bind(circuitosController));
router.get('/detalle', circuitosController.detalle.bind(circuitosController));
router.post('/check-disponibilidad', circuitosController.checkDisponibilidad.bind(circuitosController));

export default router;
