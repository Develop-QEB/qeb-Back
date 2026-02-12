import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { authMiddleware } from '../middleware/auth.middleware';
import { uploadToCloudinary, isCloudinaryConfigured } from '../config/cloudinary';

const router = Router();

// Asegurar que existe la carpeta de uploads para artes (fallback local)
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

// Configurar multer en memoria para arte (se sube a Cloudinary)
const storageArte = multer.memoryStorage();

// Configurar multer en disco como fallback local para arte
const storageDiskArte = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
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

// Usar memoryStorage si Cloudinary está configurado, diskStorage si no
const upload = multer({
  storage: isCloudinaryConfigured() ? storageArte : storageDiskArte,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
  },
});

// Endpoint para subir archivo de arte
router.post('/arte', authMiddleware, upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({
        success: false,
        error: 'No se recibio ningun archivo',
      });
      return;
    }

    // Si Cloudinary está configurado, subir ahí
    if (isCloudinaryConfigured() && req.file.buffer) {
      const base64Data = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
      const cloudResult = await uploadToCloudinary(base64Data, 'qeb/artes', 'image');

      if (cloudResult) {
        console.log('Archivo subido a Cloudinary:', req.file.originalname, '->', cloudResult.secure_url);
        res.json({
          success: true,
          data: {
            url: cloudResult.secure_url,
            filename: req.file.originalname,
            originalName: req.file.originalname,
            size: req.file.size,
            mimetype: req.file.mimetype,
          },
        });
        return;
      }
      // Si falla Cloudinary, continuar con fallback local
      console.warn('Cloudinary fallo, no hay fallback en memoria. Archivo no guardado.');
      res.status(500).json({
        success: false,
        error: 'Error al subir archivo a Cloudinary',
      });
      return;
    }

    // Fallback: archivo guardado en disco local
    const fileUrl = `/uploads/artes/${req.file.filename}`;
    console.log('Archivo subido localmente:', req.file.filename, '-> Path:', fileUrl);

    res.json({
      success: true,
      data: {
        url: fileUrl,
        filename: req.file.filename!,
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

// Configurar multer en disco como fallback local para testigos
const storageDiskTestigos = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDirTestigos);
  },
  filename: (_req, file, cb) => {
    const timestamp = Date.now();
    const sanitizedName = sanitizeFilename(file.originalname);
    const ext = path.extname(sanitizedName);
    const name = path.basename(sanitizedName, ext);
    cb(null, `testigo-${timestamp}-${name}${ext}`);
  },
});

const uploadTestigo = multer({
  storage: isCloudinaryConfigured() ? multer.memoryStorage() : storageDiskTestigos,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
  },
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

    // Si Cloudinary está configurado, subir ahí
    if (isCloudinaryConfigured() && req.file.buffer) {
      const base64Data = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
      const cloudResult = await uploadToCloudinary(base64Data, 'qeb/testigos', 'image');

      if (cloudResult) {
        console.log('Archivo testigo subido a Cloudinary:', req.file.originalname, '->', cloudResult.secure_url);
        res.json({
          success: true,
          data: {
            url: cloudResult.secure_url,
            filename: req.file.originalname,
            originalName: req.file.originalname,
            size: req.file.size,
            mimetype: req.file.mimetype,
          },
        });
        return;
      }
      console.warn('Cloudinary fallo para testigo. Archivo no guardado.');
      res.status(500).json({
        success: false,
        error: 'Error al subir archivo de testigo a Cloudinary',
      });
      return;
    }

    // Fallback: archivo guardado en disco local
    const fileUrl = `/uploads/testigos/${req.file.filename}`;
    console.log('Archivo testigo subido localmente:', req.file.filename, '-> Path:', fileUrl);

    res.json({
      success: true,
      data: {
        url: fileUrl,
        filename: req.file.filename!,
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
