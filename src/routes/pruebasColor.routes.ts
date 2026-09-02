import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware';
import { crear, listar, actualizarEstatus, eliminar } from '../controllers/pruebasColor.controller';

const router = Router();
router.use(authMiddleware);

// Feedback 2026-08-15 (Gestor artes Propuestas - prueba de color).
router.get('/', listar);
router.post('/', crear);
router.patch('/:id/estatus', actualizarEstatus);
router.delete('/:id', eliminar);

export default router;
