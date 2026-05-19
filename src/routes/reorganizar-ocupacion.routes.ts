import { Router } from 'express';
import { authMiddleware, roleMiddleware } from '../middleware/auth.middleware';
import {
  getCatorcenasDeCampana,
  getCircuitosPorCatorcena,
  compararCsv,
  aplicarReorganizacion,
} from '../controllers/reorganizar-ocupacion.controller';

const router = Router();

router.use(authMiddleware);
router.use(roleMiddleware('DEV'));

router.get('/campanas/:id/catorcenas', getCatorcenasDeCampana);
router.get('/campanas/:id/circuitos', getCircuitosPorCatorcena);
router.post('/comparar', compararCsv);
router.post('/aplicar', aplicarReorganizacion);

export default router;
