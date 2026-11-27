import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware';
import { crear, crearBatch, listar, actualizarEstatus, eliminar, listarTareas, resolverTarea, reenviar, reenviarBatch } from '../controllers/pruebasColor.controller';

const router = Router();
router.use(authMiddleware);

// Feedback 2026-08-15 (Gestor artes Propuestas - prueba de color).
router.get('/', listar);
router.post('/', crear);
// Jos 2026-11-24: creación de N pruebas (varios artes) en una sola tarea de
// Revisión. Antes el front hacía N POST individuales y Diseño veía N tareas
// sueltas; ahora todos los artes del mismo circuito van en UNA sola tarea
// con acciones individuales y masivas.
router.post('/batch', crearBatch);
router.patch('/:id/estatus', actualizarEstatus);
router.delete('/:id', eliminar);

// Tareas asociadas a una prueba — se consumen desde la ventana del modal.
// Feedback Jos 2026-10-02.
router.get('/:id/tareas', listarTareas);
router.patch('/:id/tareas/:tareaId', resolverTarea);

// Jos 2026-11-27: reenvío en LOTE — crea UNA sola tarea Revisión de artes
// con N artes corregidos (en vez de N tareas individuales).
// IMPORTANTE: debe ir ANTES de /:id/reenviar porque Express evalúa en orden
// y si no, 'batch' lo interpreta como el param :id.
router.post('/batch/reenviar', reenviarBatch);
// Jos 2026-10-12: reenviar una prueba rechazada (edita en sitio sin crear v2).
router.post('/:id/reenviar', reenviar);

export default router;
