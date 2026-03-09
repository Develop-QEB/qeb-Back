import { Router } from 'express';
import { solicitudesController } from '../controllers/solicitudes.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { uploadGeneral } from '../middleware/upload.middleware';

const router = Router();

// Endpoint público - no requiere autenticación (solo cálculo, no modifica datos)
router.post('/evaluar-autorizacion', solicitudesController.evaluarAutorizacion.bind(solicitudesController));

router.use(authMiddleware);

router.get('/', solicitudesController.getAll.bind(solicitudesController));
router.get('/stats', solicitudesController.getStats.bind(solicitudesController));
router.get('/catorcenas', solicitudesController.getCatorcenas.bind(solicitudesController));
router.get('/export', solicitudesController.exportAll.bind(solicitudesController));
router.get('/users', solicitudesController.getUsers.bind(solicitudesController));
router.get('/inventario-filters', solicitudesController.getInventarioFilters.bind(solicitudesController));
router.get('/formatos-by-ciudades', solicitudesController.getFormatosByCiudades.bind(solicitudesController));
router.get('/inventario-options', solicitudesController.getInventarioOptions.bind(solicitudesController));
router.get('/next-id', solicitudesController.getNextId.bind(solicitudesController));
router.post('/', solicitudesController.create.bind(solicitudesController));
router.get('/:id', solicitudesController.getById.bind(solicitudesController));
router.put('/:id', solicitudesController.update.bind(solicitudesController));
router.patch('/:id/status', solicitudesController.updateStatus.bind(solicitudesController));
router.post('/:id/atender', solicitudesController.atender.bind(solicitudesController));
router.get('/:id/comments', solicitudesController.getComments.bind(solicitudesController));
router.post('/:id/comments', solicitudesController.addComment.bind(solicitudesController));
router.post('/:id/archivo', uploadGeneral.single('archivo'), solicitudesController.uploadArchivo.bind(solicitudesController));
router.delete('/:id', solicitudesController.delete.bind(solicitudesController));

export default router;
