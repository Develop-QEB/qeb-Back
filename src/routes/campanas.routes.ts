import { Router } from 'express';
import { campanasController } from '../controllers/campanas.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.use(authMiddleware);

// Rutas estáticas (ANTES de /:id para que no las capture el parámetro dinámico)
router.get('/stats', campanasController.getStats.bind(campanasController));
router.get('/usuarios/lista', campanasController.getUsuarios.bind(campanasController));
router.get('/ordenes-montaje/cat', campanasController.getOrdenMontajeCAT.bind(campanasController));
router.get('/ordenes-montaje/invian', campanasController.getOrdenMontajeINVIAN.bind(campanasController));

// Rutas dinámicas con :id
router.get('/', campanasController.getAll.bind(campanasController));
router.get('/:id', campanasController.getById.bind(campanasController));
router.patch('/:id', campanasController.update.bind(campanasController));
router.patch('/:id/status', campanasController.updateStatus.bind(campanasController));

// Inventario
router.get('/:id/inventario', campanasController.getInventarioReservado.bind(campanasController));
router.get('/:id/inventario-aps', campanasController.getInventarioConAPS.bind(campanasController));
router.get('/:id/inventario-arte', campanasController.getInventarioConArte.bind(campanasController));
router.get('/:id/inventario-sin-arte', campanasController.getInventarioSinArte.bind(campanasController));
router.get('/:id/inventario-testigos', campanasController.getInventarioTestigos.bind(campanasController));

// Caras e historial
router.get('/:id/caras', campanasController.getCaras.bind(campanasController));
router.patch('/:id/caras/:caraId', campanasController.updateCara.bind(campanasController));
router.post('/:id/caras', campanasController.createCara.bind(campanasController));
router.delete('/:id/caras/:caraId', campanasController.deleteCara.bind(campanasController));
router.get('/:id/historial', campanasController.getHistorial.bind(campanasController));

// Reservas (para modal de asignación)
router.get('/:id/reservas-modal', campanasController.getReservasForModal.bind(campanasController));
router.post('/:id/reservas', campanasController.createReservas.bind(campanasController));
router.delete('/:id/reservas', campanasController.deleteReservas.bind(campanasController));

// Comentarios
router.post('/:id/comentarios', campanasController.addComment.bind(campanasController));

// APS
router.post('/:id/assign-aps', campanasController.assignAPS.bind(campanasController));
router.post('/:id/remove-aps', campanasController.removeAPS.bind(campanasController));

// Gestión de Artes
router.get('/:id/artes-existentes', campanasController.getArtesExistentes.bind(campanasController));
router.post('/:id/verificar-arte', campanasController.verificarArteExistente.bind(campanasController));
router.post('/:id/assign-arte', campanasController.assignArte.bind(campanasController));
router.post('/:id/assign-arte-digital', campanasController.assignArteDigital.bind(campanasController));
router.post('/:id/add-arte-digital', campanasController.addArteDigital.bind(campanasController));
router.get('/:id/imagenes-digitales/:reservaId', campanasController.getImagenesDigitales.bind(campanasController));
router.get('/:id/digital-file-summaries', campanasController.getDigitalFileSummaries.bind(campanasController));
router.delete('/:id/imagenes-digitales', campanasController.deleteImagenesDigitales.bind(campanasController));
router.post('/:id/arte-status', campanasController.updateArteStatus.bind(campanasController));
router.post('/:id/instalado', campanasController.updateInstalado.bind(campanasController));
router.post('/:id/check-reservas-tareas', campanasController.checkReservasTareas.bind(campanasController));
router.delete('/:id/limpiar-artes-prueba', campanasController.limpiarArtesPrueba.bind(campanasController));

// Comentarios de Revisión de Artes (por tarea)
router.get('/:id/tareas/:tareaId/comentarios-arte', campanasController.getComentariosRevisionArte.bind(campanasController));
router.post('/:id/tareas/:tareaId/comentarios-arte', campanasController.addComentarioRevisionArte.bind(campanasController));
router.delete('/:id/comentarios-arte/:comentarioId', campanasController.deleteComentarioRevisionArte.bind(campanasController));

// Tareas
router.get('/:id/tareas', campanasController.getTareas.bind(campanasController));
router.post('/:id/tareas', campanasController.createTarea.bind(campanasController));
router.patch('/:id/tareas/:tareaId', campanasController.updateTarea.bind(campanasController));
router.post('/:id/tareas/:tareaId/enviar-orden-programacion', campanasController.enviarOrdenProgramacion.bind(campanasController));
router.delete('/:id/tareas/:tareaId', campanasController.deleteTarea.bind(campanasController));

export default router;
