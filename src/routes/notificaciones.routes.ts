import { Router } from 'express';
import { notificacionesController } from '../controllers/notificaciones.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.use(authMiddleware);

// Stats y operaciones globales
router.get('/stats', notificacionesController.getStats.bind(notificacionesController));
router.patch('/leer-todas', notificacionesController.marcarTodasLeidas.bind(notificacionesController));

// Autorización (ANTES de rutas con :id para evitar conflictos)
router.get('/autorizacion/:idquote/resumen', notificacionesController.getResumenAutorizacion.bind(notificacionesController));
router.get('/autorizacion/:idquote/caras', notificacionesController.getCarasAutorizacion.bind(notificacionesController));
router.post('/autorizacion/:idquote/aprobar/:tipo', notificacionesController.aprobarAutorizacion.bind(notificacionesController));
router.post('/autorizacion/:idquote/rechazar', notificacionesController.rechazarAutorizacion.bind(notificacionesController));

// CRUD
router.get('/', notificacionesController.getAll.bind(notificacionesController));
router.post('/', notificacionesController.create.bind(notificacionesController));
router.get('/:id', notificacionesController.getById.bind(notificacionesController));
router.put('/:id', notificacionesController.update.bind(notificacionesController));
router.patch('/:id', notificacionesController.update.bind(notificacionesController));
router.delete('/:id', notificacionesController.delete.bind(notificacionesController));

// Acciones específicas
router.patch('/:id/leer', notificacionesController.marcarLeida.bind(notificacionesController));

// Comentarios
router.get('/:id/comentarios', notificacionesController.getComments.bind(notificacionesController));
router.post('/:id/comentarios', notificacionesController.addComment.bind(notificacionesController));

export default router;
