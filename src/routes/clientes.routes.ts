import { Router } from 'express';
import { clientesController } from '../controllers/clientes.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.use(authMiddleware);

router.get('/', clientesController.getAll.bind(clientesController));
router.get('/full', clientesController.getAllFull.bind(clientesController));
router.get('/stats', clientesController.getStats.bind(clientesController));
router.get('/filter-options', clientesController.getFilterOptions.bind(clientesController));
router.get('/sap', clientesController.getSAPClientes.bind(clientesController));
router.get('/cuics', clientesController.getAllCUICs.bind(clientesController));
router.post('/', clientesController.create.bind(clientesController));
router.get('/:id', clientesController.getById.bind(clientesController));
router.delete('/:id', clientesController.delete.bind(clientesController));

export default router;
