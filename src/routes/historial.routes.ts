import { Router } from 'express';
import { historialController } from '../controllers/historial.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.use(authMiddleware);

router.get('/', historialController.getAll.bind(historialController));
router.get('/tipos', historialController.getTipos.bind(historialController));
router.get('/acciones', historialController.getAcciones.bind(historialController));
router.get('/usuarios', historialController.getUsuarios.bind(historialController));
router.post('/notas', historialController.addNota.bind(historialController));

// Tablero CRM "Actividad Comercial" (tab en Historial de Acciones).
router.get('/actividad-comercial', historialController.getActividadComercial.bind(historialController));
router.patch('/actividad-comercial/:id/estatus', historialController.moverActividadComercial.bind(historialController));

export default router;
