import { Router } from 'express';
import { propuestasController } from '../controllers/propuestas.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.use(authMiddleware);

// GET routes - specific routes before generic /:id
router.get('/', propuestasController.getAll.bind(propuestasController));
router.get('/stats', propuestasController.getStats.bind(propuestasController));
router.get('/:id/full', propuestasController.getFullDetails.bind(propuestasController));
router.get('/:id/inventario', propuestasController.getInventarioReservado.bind(propuestasController));
router.get('/:id/comments', propuestasController.getComments.bind(propuestasController));
router.get('/:id/reservas-modal', propuestasController.getReservasForModal.bind(propuestasController));
router.get('/:id', propuestasController.getById.bind(propuestasController));

// POST routes
router.post('/:id/comments', propuestasController.addComment.bind(propuestasController));
router.post('/:id/approve', propuestasController.approve.bind(propuestasController));
router.post('/:id/reservas', propuestasController.createReservas.bind(propuestasController));
router.post('/:id/reservas/toggle', propuestasController.toggleReserva.bind(propuestasController));

// PATCH routes
router.patch('/:id/status', propuestasController.updateStatus.bind(propuestasController));
router.patch('/:id/asignados', propuestasController.updateAsignados.bind(propuestasController));

// DELETE routes
router.delete('/:id/reservas', propuestasController.deleteReservas.bind(propuestasController));

export default router;
