import { Router } from 'express';
import { inventariosController } from '../controllers/inventarios.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

// Endpoint temporal sin autenticación para arreglar reservas huérfanas (remover después)
router.post('/reservas/arreglar-huerfanas', inventariosController.arreglarReservasHuerfanas.bind(inventariosController));

router.use(authMiddleware);

router.get('/', inventariosController.getAll.bind(inventariosController));
router.get('/map', inventariosController.getForMap.bind(inventariosController));
router.get('/disponibles', inventariosController.getDisponibles.bind(inventariosController));
router.get('/stats', inventariosController.getStats.bind(inventariosController));
router.get('/tipos', inventariosController.getTipos.bind(inventariosController));
router.get('/plazas', inventariosController.getPlazas.bind(inventariosController));
router.get('/estatus', inventariosController.getEstatus.bind(inventariosController));
router.get('/estados', inventariosController.getEstados.bind(inventariosController));
router.get('/ciudades', inventariosController.getCiudadesByEstado.bind(inventariosController));
router.get('/formatos', inventariosController.getFormatosByCiudad.bind(inventariosController));
router.get('/nse', inventariosController.getNSE.bind(inventariosController));

// Espacios digitales
router.post('/espacios/poblar', inventariosController.poblarEspaciosInventario.bind(inventariosController));
router.get('/:id/espacios', inventariosController.getEspaciosDisponibles.bind(inventariosController));

router.get('/:id/historial', inventariosController.getHistorial.bind(inventariosController));
router.get('/:id', inventariosController.getById.bind(inventariosController));

export default router;
