import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { solicitudesController } from '../controllers/solicitudes.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

// Configure multer for file uploads
const uploadsDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `solicitud_${req.params.id}_${Date.now()}`;
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

router.get('/', solicitudesController.getAll.bind(solicitudesController));
router.get('/stats', solicitudesController.getStats.bind(solicitudesController));
router.get('/catorcenas', solicitudesController.getCatorcenas.bind(solicitudesController));
router.get('/export', solicitudesController.exportAll.bind(solicitudesController));
router.get('/users', solicitudesController.getUsers.bind(solicitudesController));
router.get('/inventario-filters', solicitudesController.getInventarioFilters.bind(solicitudesController));
router.get('/formatos-by-ciudades', solicitudesController.getFormatosByCiudades.bind(solicitudesController));
router.get('/next-id', solicitudesController.getNextId.bind(solicitudesController));
router.post('/', solicitudesController.create.bind(solicitudesController));
router.get('/:id', solicitudesController.getById.bind(solicitudesController));
router.put('/:id', solicitudesController.update.bind(solicitudesController));
router.patch('/:id/status', solicitudesController.updateStatus.bind(solicitudesController));
router.post('/:id/atender', solicitudesController.atender.bind(solicitudesController));
router.get('/:id/comments', solicitudesController.getComments.bind(solicitudesController));
router.post('/:id/comments', solicitudesController.addComment.bind(solicitudesController));
router.post('/:id/archivo', upload.single('archivo'), solicitudesController.uploadArchivo.bind(solicitudesController));
router.delete('/:id', solicitudesController.delete.bind(solicitudesController));

export default router;
