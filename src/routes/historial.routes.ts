import { Router } from 'express';
import { historialController } from '../controllers/historial.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.use(authMiddleware);

// Tablero CRM de Actividad Comercial (ANTES de '/' por claridad; no choca).
router.get('/actividad-comercial', historialController.getActividadComercial.bind(historialController));
router.patch('/actividad-comercial/:id/estatus', historialController.moverActividadComercial.bind(historialController));

// Historial de una tarea especifica (bitacora de ediciones). Devuelve registros
// con tipo='Tarea' y ref_id=:id, ordenados por fecha descendente. Se usa en el
// drawer lateral de Notificaciones para mostrar quien edito que campo y cuando
// (feedback Jos 2026-11-06).
router.get('/tarea/:id', historialController.getHistorialTarea.bind(historialController));

router.get('/', historialController.getAll.bind(historialController));
router.get('/tipos', historialController.getTipos.bind(historialController));
router.get('/acciones', historialController.getAcciones.bind(historialController));
router.get('/usuarios', historialController.getUsuarios.bind(historialController));
router.post('/notas', historialController.addNota.bind(historialController));

export default router;
