import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware';
import { crear, listar, actualizarEstatus, eliminar, listarTareas, resolverTarea } from '../controllers/pruebasColor.controller';

const router = Router();
router.use(authMiddleware);

// Feedback 2026-08-15 (Gestor artes Propuestas - prueba de color).
router.get('/', listar);
router.post('/', crear);
router.patch('/:id/estatus', actualizarEstatus);
router.delete('/:id', eliminar);

// Tareas asociadas a una prueba — se consumen desde la ventana del modal.
// Feedback Jos 2026-10-02.
router.get('/:id/tareas', listarTareas);
router.patch('/:id/tareas/:tareaId', resolverTarea);

export default router;
