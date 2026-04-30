import { Router } from 'express';
import { analisisOcupacionController } from '../controllers/analisis-ocupacion.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.use(authMiddleware);

router.get('/', analisisOcupacionController.getAll.bind(analisisOcupacionController));
router.get('/:id', analisisOcupacionController.getById.bind(analisisOcupacionController));
router.post('/', analisisOcupacionController.create.bind(analisisOcupacionController));
router.put('/:id', analisisOcupacionController.update.bind(analisisOcupacionController));
router.patch('/:id', analisisOcupacionController.update.bind(analisisOcupacionController));
router.delete('/:id', analisisOcupacionController.delete.bind(analisisOcupacionController));

export default router;
