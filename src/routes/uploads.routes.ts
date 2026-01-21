import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

// Asegurar que existe la carpeta de uploads para artes
const uploadDir = path.join(__dirname, '../../uploads/artes');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Asegurar que existe la carpeta de uploads para testigos
const uploadDirTestigos = path.join(__dirname, '../../uploads/testigos');
if (!fs.existsSync(uploadDirTestigos)) {
  fs.mkdirSync(uploadDirTestigos, { recursive: true });
}

// Sanitizar nombre de archivo (quitar caracteres especiales pero mantener legible)
const sanitizeFilename = (filename: string): string => {
  // Reemplazar espacios con guiones bajos y quitar caracteres no permitidos
  return filename
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Quitar acentos
    .replace(/[^a-zA-Z0-9._-]/g, '_') // Solo alfanuméricos, puntos, guiones
    .replace(/_+/g, '_') // Evitar múltiples guiones bajos
    .replace(/^_|_$/g, ''); // Quitar guiones bajos al inicio/fin
};

// Configurar multer para guardar archivos con nombre original
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    // Usar el nombre original del archivo (sanitizado)
    const sanitizedName = sanitizeFilename(file.originalname);
    cb(null, sanitizedName);
  },
});

// Filtro de tipos de archivo permitidos
const fileFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Tipo de archivo no permitido. Solo se permiten: JPG, PNG, GIF, WEBP, PDF'));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
  },
});

// Endpoint para subir archivo de arte
router.post('/arte', authMiddleware, upload.single('file'), (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({
        success: false,
        error: 'No se recibio ningun archivo',
      });
      return;
    }

    // Construir la URL relativa del archivo (el frontend agregará el dominio correcto)
    const fileUrl = `/uploads/artes/${req.file.filename}`;

    console.log('Archivo subido:', req.file.filename, '-> Path:', fileUrl);

    res.json({
      success: true,
      data: {
        url: fileUrl,
        filename: req.file.filename,
        originalName: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
      },
    });
  } catch (error) {
    console.error('Error al subir archivo:', error);
    const message = error instanceof Error ? error.message : 'Error al subir archivo';
    res.status(500).json({
      success: false,
      error: message,
    });
  }
});

// Configurar multer para testigos
const storageTestigos = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDirTestigos);
  },
  filename: (_req, file, cb) => {
    // Agregar timestamp para evitar colisiones
    const timestamp = Date.now();
    const sanitizedName = sanitizeFilename(file.originalname);
    const ext = path.extname(sanitizedName);
    const name = path.basename(sanitizedName, ext);
    cb(null, `testigo-${timestamp}-${name}${ext}`);
  },
});

const uploadTestigo = multer({
  storage: storageTestigos,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
  },
});

// Endpoint para subir archivo de testigo
router.post('/testigo', authMiddleware, uploadTestigo.single('file'), (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({
        success: false,
        error: 'No se recibio ningun archivo',
      });
      return;
    }

    // Construir la URL relativa del archivo (el frontend agregará el dominio correcto)
    const fileUrl = `/uploads/testigos/${req.file.filename}`;

    console.log('Archivo testigo subido:', req.file.filename, '-> Path:', fileUrl);

    res.json({
      success: true,
      data: {
        url: fileUrl,
        filename: req.file.filename,
        originalName: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
      },
    });
  } catch (error) {
    console.error('Error al subir archivo testigo:', error);
    const message = error instanceof Error ? error.message : 'Error al subir archivo';
    res.status(500).json({
      success: false,
      error: message,
    });
  }
});

// Middleware para manejar errores de multer
router.use((err: Error, _req: Request, res: Response, next: Function) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({
        success: false,
        error: 'El archivo es demasiado grande. Maximo 10MB.',
      });
      return;
    }
    res.status(400).json({
      success: false,
      error: err.message,
    });
    return;
  }
  if (err) {
    res.status(400).json({
      success: false,
      error: err.message,
    });
    return;
  }
  next();
});

export default router;
