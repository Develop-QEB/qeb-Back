import { Router } from 'express';
import { usuariosController } from '../controllers/usuarios.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

// Todas las rutas requieren autenticación
router.use(authMiddleware);

// POST /api/usuarios - Crear nuevo usuario (solo admin)
router.post('/', usuariosController.create.bind(usuariosController));

// GET /api/usuarios - Obtener todos los usuarios (solo admin)
router.get('/', usuariosController.getAll.bind(usuariosController));

// PUT /api/usuarios/:id - Actualizar usuario (solo admin)
router.put('/:id', usuariosController.update.bind(usuariosController));

// DELETE /api/usuarios - Eliminar múltiples usuarios (solo admin)
router.delete('/', usuariosController.deleteMany.bind(usuariosController));

export default router;
