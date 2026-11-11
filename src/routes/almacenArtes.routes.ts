import { Router } from 'express';
import { almacenArtesController } from '../controllers/almacenArtes.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();
router.use(authMiddleware);

router.get('/', almacenArtesController.list.bind(almacenArtesController));
router.get('/:id/historial', almacenArtesController.historial.bind(almacenArtesController));
router.post('/:id/entrada-manual', almacenArtesController.entradaManual.bind(almacenArtesController));
router.post('/:id/salida-manual', almacenArtesController.salidaManual.bind(almacenArtesController));
router.post('/:id/alta-inicial', almacenArtesController.altaInicial.bind(almacenArtesController));

export default router;
