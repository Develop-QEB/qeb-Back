import { Router } from 'express';
import { historialController } from '../controllers/historial.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.use(authMiddleware);

// Tablero CRM de Actividad Comercial (ANTES de '/' por claridad; no choca).
router.get('/actividad-comercial', historialController.getActividadComercial.bind(historialController));
router.patch('/actividad-comercial/:id/estatus', historialController.moverActividadComercial.bind(historialController));

router.get('/', historialController.getAll.bind(historialController));
// Listas de clasificacion (estaticas, no tocan la BD). Reemplazan a
// '/tipos' y '/acciones', que hacian un distinct sobre la tabla completa.
router.get('/etapas', historialController.getEtapas.bind(historialController));
router.get('/modulos', historialController.getModulos.bind(historialController));
router.get('/categorias', historialController.getCategorias.bind(historialController));
router.get('/usuarios', historialController.getUsuarios.bind(historialController));
router.post('/notas', historialController.addNota.bind(historialController));

export default router;
