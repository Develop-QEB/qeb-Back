import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { propuestasController } from '../controllers/propuestas.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

// Configurar multer para uploads de propuestas
const uploadsDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `propuesta_${req.params.id}_${Date.now()}`;
    cb(null, `${uniqueSuffix}_${file.originalname}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (_req, file, cb) => {
    const allowedTypes = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.png', '.jpg', '.jpeg'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de archivo no permitido'));
    }
  },
});

router.use(authMiddleware);

// GET routes - specific routes before generic /:id
router.get('/', propuestasController.getAll.bind(propuestasController));
router.get('/stats', propuestasController.getStats.bind(propuestasController));
router.get('/:id/full', propuestasController.getFullDetails.bind(propuestasController));
router.get('/:id/inventario', propuestasController.getInventarioReservado.bind(propuestasController));
router.get('/:id/comments', propuestasController.getComments.bind(propuestasController));
router.get('/:id/reservas-modal', propuestasController.getReservasForModal.bind(propuestasController));
router.get('/:id', propuestasController.getById.bind(propuestasController));

// POST routes
router.post('/:id/comments', propuestasController.addComment.bind(propuestasController));
router.post('/:id/approve', propuestasController.approve.bind(propuestasController));
router.post('/:id/reservas', propuestasController.createReservas.bind(propuestasController));
router.post('/:id/reservas/toggle', propuestasController.toggleReserva.bind(propuestasController));

// PATCH routes
router.patch('/:id/status', propuestasController.updateStatus.bind(propuestasController));
router.patch('/:id/asignados', propuestasController.updateAsignados.bind(propuestasController));
router.patch('/:id/caras/:caraId', (req, res, next) => {
  console.log('[DEBUG] PATCH /:id/caras/:caraId hit - params:', req.params);
  next();
}, propuestasController.updateCara.bind(propuestasController));
router.patch('/:id', propuestasController.updatePropuesta.bind(propuestasController));
router.post('/:id/archivo', upload.single('archivo'), propuestasController.uploadArchivo.bind(propuestasController));
router.post('/:id/caras', propuestasController.createCara.bind(propuestasController));

// DELETE routes
router.delete('/:id/caras/:caraId', propuestasController.deleteCara.bind(propuestasController));
router.delete('/:id/reservas', propuestasController.deleteReservas.bind(propuestasController));

export default router;
