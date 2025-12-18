import { Router } from 'express';
import {
  getCorreos,
  getCorreoById,
  getCorreosStats,
  toggleLeido,
  createCorreo,
  sendAuthorizationPIN,
} from '../controllers/correos.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

// Aplicar middleware de autenticación a todas las rutas
router.use(authMiddleware);

// GET /api/correos - Obtener correos del usuario
router.get('/', getCorreos);

// GET /api/correos/stats - Obtener estadísticas
router.get('/stats', getCorreosStats);

// GET /api/correos/:id - Obtener correo por ID
router.get('/:id', getCorreoById);

// PUT /api/correos/:id/toggle-leido - Marcar como leído/no leído
router.put('/:id/toggle-leido', toggleLeido);

// POST /api/correos - Crear correo (uso interno)
router.post('/', createCorreo);

// POST /api/correos/send-pin - Enviar PIN de autorización
router.post('/send-pin', sendAuthorizationPIN);

export default router;
