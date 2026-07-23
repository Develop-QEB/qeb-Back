import { Router } from 'express';
import { notificacionesController } from '../controllers/notificaciones.controller';
import { preferenciasNotifController } from '../controllers/preferenciasNotif.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.use(authMiddleware);

// Preferencias de notificaciones del usuario actual (ANTES de rutas con :id)
router.get('/preferencias', preferenciasNotifController.getMine.bind(preferenciasNotifController));
router.put('/preferencias', preferenciasNotifController.updateMine.bind(preferenciasNotifController));

// Stats y operaciones globales
router.get('/stats', notificacionesController.getStats.bind(notificacionesController));
router.patch('/leer-todas', notificacionesController.marcarTodasLeidas.bind(notificacionesController));
router.patch('/bulk-estatus', notificacionesController.bulkUpdateEstatus.bind(notificacionesController));

// Depuración de tareas de autorización resueltas
router.post('/autorizacion/depurar', notificacionesController.depurarAutorizaciones.bind(notificacionesController));

// Actividad Comercial (tarea manual del asesor). ANTES de rutas con :id.
router.get('/actividad-comercial/campanas', notificacionesController.getCampanasParaActividad.bind(notificacionesController));
router.get('/actividad-comercial/propuestas', notificacionesController.getPropuestasParaActividad.bind(notificacionesController));
router.post('/actividad-comercial', notificacionesController.crearActividadComercial.bind(notificacionesController));

// Autorización (ANTES de rutas con :id para evitar conflictos)
router.get('/autorizacion/:idquote/resumen', notificacionesController.getResumenAutorizacion.bind(notificacionesController));
router.get('/autorizacion/:idquote/caras', notificacionesController.getCarasAutorizacion.bind(notificacionesController));
router.post('/autorizacion/:idquote/aprobar/:tipo', notificacionesController.aprobarAutorizacion.bind(notificacionesController));
router.post('/autorizacion/:idquote/rechazar', notificacionesController.rechazarAutorizacion.bind(notificacionesController));
router.get('/autorizacion/:idquote/historial', notificacionesController.getHistorialAutorizacion.bind(notificacionesController));

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
