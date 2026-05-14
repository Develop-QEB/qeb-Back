import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware';
import {
  getAuditSummary,
  getAuditDuplicados,
  getAuditHuerfanos,
  getAuditPorCatorcena,
  getAuditPorCliente,
  getAuditInvDuplicados,
  getAuditClienteDesalineado,
  getAuditStatusRaro,
  getAuditInvSucio,
  getAuditReservasSucias,
  getAuditCrossCamFisico,
  getAuditCodReutilizado,
  getAuditApsCompartido,
  getAuditZombies,
  getAuditEiDuplicado,
  getAuditMarcaClientesDup,
  getAuditPorVendedor,
} from '../controllers/audit-reservas.controller';

const router = Router();
router.use(authMiddleware);

router.get('/summary', getAuditSummary);
router.get('/duplicados', getAuditDuplicados);
router.get('/huerfanos', getAuditHuerfanos);
router.get('/por-catorcena', getAuditPorCatorcena);
router.get('/por-cliente', getAuditPorCliente);
router.get('/por-vendedor', getAuditPorVendedor);
router.get('/inv-duplicados', getAuditInvDuplicados);
router.get('/cliente-desalineado', getAuditClienteDesalineado);
router.get('/status-raro', getAuditStatusRaro);
router.get('/inv-sucio', getAuditInvSucio);
router.get('/reservas-sucias', getAuditReservasSucias);
router.get('/cross-cam-fisico', getAuditCrossCamFisico);
router.get('/cod-reutilizado', getAuditCodReutilizado);
router.get('/aps-compartido', getAuditApsCompartido);
router.get('/zombies', getAuditZombies);
router.get('/ei-duplicado', getAuditEiDuplicado);
router.get('/marca-clientes-dup', getAuditMarcaClientesDup);

export default router;
