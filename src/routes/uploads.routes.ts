import { Router, Request, Response } from 'express';
import multer from 'multer';
import { authMiddleware } from '../middleware/auth.middleware';
import { isSpacesConfigured, uploadBufferToSpaces } from '../config/spaces';

const router = Router();

// Sanitizar nombre de archivo (quitar caracteres especiales pero mantener legible)
const sanitizeFilename = (filename: string): string => {
  return filename
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
};

// Configurar multer en memoria para subir directo a Spaces.
const storageMemory = multer.memoryStorage();

// Filtro de tipos de archivo permitidos
const fileFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedTypes = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/pdf',
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'video/x-msvideo',
  ];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Tipo de archivo no permitido. Solo se permiten: JPG, PNG, GIF, WEBP, PDF, MP4, MOV, WEBM, AVI'));
  }
};

const uploadArte = multer({
  storage: storageMemory,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
  },
});

const uploadTestigo = multer({
  storage: storageMemory,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
  },
});

// Endpoint para subir archivo de arte
router.post('/arte', authMiddleware, uploadArte.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({
        success: false,
        error: 'No se recibio ningun archivo',
      });
      return;
    }

    if (!isSpacesConfigured()) {
      res.status(500).json({
        success: false,
        error: 'Spaces no esta configurado',
      });
      return;
    }

    if (!req.file.buffer) {
      res.status(400).json({
        success: false,
        error: 'Archivo invalido: no se recibio buffer para subir',
      });
      return;
    }

    const uploaded = await uploadBufferToSpaces(req.file.buffer, {
      folder: 'artes',
      originalName: sanitizeFilename(req.file.originalname),
      mimeType: req.file.mimetype,
    });

    res.json({
      success: true,
      data: {
        url: uploaded.url,
        filename: uploaded.key,
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

// Endpoint para subir archivo de testigo
router.post('/testigo', authMiddleware, uploadTestigo.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({
        success: false,
        error: 'No se recibio ningun archivo',
      });
      return;
    }

    if (!isSpacesConfigured()) {
      res.status(500).json({
        success: false,
        error: 'Spaces no esta configurado',
      });
      return;
    }

    if (!req.file.buffer) {
      res.status(400).json({
        success: false,
        error: 'Archivo invalido: no se recibio buffer para subir',
      });
      return;
    }

    const uploaded = await uploadBufferToSpaces(req.file.buffer, {
      folder: 'testigos',
      originalName: sanitizeFilename(req.file.originalname),
      mimeType: req.file.mimetype,
    });

    res.json({
      success: true,
      data: {
        url: uploaded.url,
        filename: uploaded.key,
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

