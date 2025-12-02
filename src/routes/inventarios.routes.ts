import { Router } from 'express';
import { inventariosController } from '../controllers/inventarios.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.use(authMiddleware);

router.get('/', inventariosController.getAll.bind(inventariosController));
router.get('/map', inventariosController.getForMap.bind(inventariosController));
router.get('/stats', inventariosController.getStats.bind(inventariosController));
router.get('/tipos', inventariosController.getTipos.bind(inventariosController));
router.get('/plazas', inventariosController.getPlazas.bind(inventariosController));
router.get('/estatus', inventariosController.getEstatus.bind(inventariosController));
router.get('/:id', inventariosController.getById.bind(inventariosController));

export default router;
