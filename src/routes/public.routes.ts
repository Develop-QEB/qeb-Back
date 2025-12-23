import { Router } from 'express';
import { propuestasController } from '../controllers/propuestas.controller';

const router = Router();

// Public routes (no auth required)
router.get('/propuestas/:id', propuestasController.getPublicDetails.bind(propuestasController));

export default router;
