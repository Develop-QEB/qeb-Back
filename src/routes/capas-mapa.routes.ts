import { Router } from 'express';
import { capasMapaController } from '../controllers/capas-mapa.controller';
import { authMiddleware } from '../middleware/auth.middleware';

// Capas de POI / poligonos KML por circuito (Buscador de Formatos -> Vista
// Compartir). La version publica (solo visible_cliente) viaja dentro de
// GET /public/propuestas/:id, no aqui.
const router = Router();

router.use(authMiddleware);

router.get('/propuesta/:id', capasMapaController.listarPorPropuesta.bind(capasMapaController));
router.post('/', capasMapaController.crear.bind(capasMapaController));
router.patch('/:capaId', capasMapaController.actualizar.bind(capasMapaController));
router.delete('/:capaId', capasMapaController.eliminar.bind(capasMapaController));

export default router;
