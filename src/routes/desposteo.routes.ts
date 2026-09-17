import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware';
import {
  solicitar,
  listar,
  detalle,
  historial,
  filtroAprobar,
  filtroRechazar,
  aprobar,
  rechazar,
  verificar,
} from '../controllers/desposteo.controller';

// Filtro Autorizacion "Quitar Posteo" — endpoints Fase 1.
const router = Router();
router.use(authMiddleware);

router.post('/solicitar', solicitar);
router.get('/', listar);
router.get('/verificar', verificar);
router.get('/historial', historial);
router.get('/:id', detalle);
router.post('/:id/filtro/aprobar', filtroAprobar);
router.post('/:id/filtro/rechazar', filtroRechazar);
router.post('/:id/aprobar', aprobar);
router.post('/:id/rechazar', rechazar);

export default router;
