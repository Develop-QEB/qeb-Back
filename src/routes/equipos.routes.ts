import { Router } from 'express';
import { equiposController } from '../controllers/equipos.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

// Todas las rutas requieren autenticación
router.use(authMiddleware);

// GET /api/equipos - Obtener todos los equipos (solo admin)
router.get('/', equiposController.getAll.bind(equiposController));

// POST /api/equipos - Crear nuevo equipo (solo admin)
router.post('/', equiposController.create.bind(equiposController));

// PUT /api/equipos/:id - Actualizar equipo (solo admin)
router.put('/:id', equiposController.update.bind(equiposController));

// DELETE /api/equipos/:id - Eliminar equipo (solo admin)
router.delete('/:id', equiposController.delete.bind(equiposController));

// GET /api/equipos/:id/available-users - Obtener usuarios disponibles para agregar (solo admin)
router.get('/:id/available-users', equiposController.getAvailableUsers.bind(equiposController));

// POST /api/equipos/:id/members - Agregar miembros al equipo (solo admin)
router.post('/:id/members', equiposController.addMembers.bind(equiposController));

// DELETE /api/equipos/:id/members - Remover miembros del equipo (solo admin)
router.delete('/:id/members', equiposController.removeMembers.bind(equiposController));

export default router;
