import { Router } from 'express';
import { propuestaEconomicaController } from '../controllers/propuesta-economica.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.use(authMiddleware);

router.get('/', propuestaEconomicaController.getAll.bind(propuestaEconomicaController));
router.get('/:id', propuestaEconomicaController.getById.bind(propuestaEconomicaController));
router.post('/', propuestaEconomicaController.create.bind(propuestaEconomicaController));
router.put('/:id', propuestaEconomicaController.update.bind(propuestaEconomicaController));
router.delete('/:id', propuestaEconomicaController.delete.bind(propuestaEconomicaController));

export default router;
