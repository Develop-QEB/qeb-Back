import { Router } from 'express';
import { inventariosController } from '../controllers/inventarios.controller';
import { authMiddleware, roleMiddleware } from '../middleware/auth.middleware';

const router = Router();

// Endpoint temporal sin autenticación para arreglar reservas huérfanas (remover después)
router.post('/reservas/arreglar-huerfanas', inventariosController.arreglarReservasHuerfanas.bind(inventariosController));

router.use(authMiddleware);

router.get('/', inventariosController.getAll.bind(inventariosController));
router.get('/download/csv', inventariosController.downloadCSV.bind(inventariosController));
router.get('/map', inventariosController.getForMap.bind(inventariosController));
router.get('/disponibles', inventariosController.getDisponibles.bind(inventariosController));
router.get('/categorias-cliente', inventariosController.getCategoriasCliente.bind(inventariosController));
router.get('/stats', inventariosController.getStats.bind(inventariosController));
router.get('/tipos', inventariosController.getTipos.bind(inventariosController));
router.get('/plazas', inventariosController.getPlazas.bind(inventariosController));
router.get('/ctos', inventariosController.getCtos.bind(inventariosController));
router.get('/estatus', inventariosController.getEstatus.bind(inventariosController));
router.get('/estados', inventariosController.getEstados.bind(inventariosController));
router.get('/ciudades', inventariosController.getCiudadesByEstado.bind(inventariosController));
router.get('/formatos', inventariosController.getFormatosByCiudad.bind(inventariosController));
router.get('/nse', inventariosController.getNSE.bind(inventariosController));

// Espacios digitales
router.post('/espacios/poblar', inventariosController.poblarEspaciosInventario.bind(inventariosController));
router.get('/:id/espacios', inventariosController.getEspaciosDisponibles.bind(inventariosController));

// Auditoria de conflictos de ocupacion. Solo DEV: barre el inventario completo
// y es una herramienta de diagnostico, no de operacion diaria. El guard va aqui
// y no en un router.use para no afectar al resto de rutas de inventarios.
// Va antes de las rutas '/:id' y no colisiona con POST '/' ni POST '/bulk'.
router.post('/conflictos', roleMiddleware('DEV'), inventariosController.getConflictosOcupacion.bind(inventariosController));
// Limpieza de duplicados. Solo DEV y solo duplicados: los choques nunca se
// resuelven automaticamente (ver limpiarDuplicadosOcupacion).
router.post('/conflictos/limpiar-duplicados', roleMiddleware('DEV'), inventariosController.limpiarDuplicadosOcupacion.bind(inventariosController));

// CRUD
router.post('/bulk-check', inventariosController.bulkCheck.bind(inventariosController));
router.post('/check-codigos', inventariosController.checkCodigos.bind(inventariosController));
router.post('/bulk', inventariosController.bulkCreate.bind(inventariosController));
router.post('/', inventariosController.create.bind(inventariosController));
router.put('/:id', inventariosController.update.bind(inventariosController));
router.patch('/:id/toggle-block', inventariosController.toggleBlock.bind(inventariosController));

router.get('/:id/historial', inventariosController.getHistorial.bind(inventariosController));
router.get('/:id/acciones', inventariosController.getAcciones.bind(inventariosController));
router.get('/:id', inventariosController.getById.bind(inventariosController));

export default router;
