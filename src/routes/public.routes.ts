import { Router } from 'express';
import { propuestasController } from '../controllers/propuestas.controller';
import { campanasController } from '../controllers/campanas.controller';

const router = Router();

// Public routes (no auth required)
router.get('/propuestas/:id', propuestasController.getPublicDetails.bind(propuestasController));
// KML publico para abrir lo seleccionado en Google Maps (?ids=1,2,3)
router.get('/propuestas/:id/kml', propuestasController.getPublicKML.bind(propuestasController));

// TEMPORAL: Limpiar artes de prueba (quitar después de desarrollo)
router.delete('/campanas/:id/limpiar-artes-prueba', campanasController.limpiarArtesPrueba.bind(campanasController));

export default router;
