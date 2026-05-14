import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware';
import {
  getAuditSummary,
  getAuditDuplicados,
  getAuditHuerfanos,
  getAuditPorCatorcena,
  getAuditPorCliente,
} from '../controllers/audit-reservas.controller';

const router = Router();

// Todas las rutas requieren auth + rol DEV (validado dentro del controller).
router.use(authMiddleware);

router.get('/summary', getAuditSummary);
router.get('/duplicados', getAuditDuplicados);
router.get('/huerfanos', getAuditHuerfanos);
router.get('/por-catorcena', getAuditPorCatorcena);
router.get('/por-cliente', getAuditPorCliente);

export default router;
