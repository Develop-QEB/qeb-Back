import multer from 'multer';
import { Request } from 'express';

// Memory storage para subir directo a Spaces (ya no guardamos en disco)
const storageMemory = multer.memoryStorage();

// Filtro para solo aceptar imágenes
const imageFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Solo se permiten archivos de imagen (JPEG, PNG, GIF, WebP)'));
  }
};

// Filtro general para archivos (imágenes, PDFs, videos, Office, CSV)
const generalFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedTypes = [
    'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
    'application/pdf',
    'video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo',
    // Excel
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    // Word
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    // CSV / texto plano (algunos navegadores mandan text/plain para .csv)
    'text/csv',
    'text/plain',
    'application/vnd.ms-excel.sheet.macroEnabled.12',
    // Fallback genérico que algunos browsers usan para Office antes de 2007
    'application/octet-stream',
  ];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Tipo de archivo no permitido. Permitidos: JPG, PNG, GIF, WEBP, PDF, MP4, MOV, WEBM, AVI, XLS, XLSX, DOC, DOCX, CSV'));
  }
};

export const uploadProfilePhoto = multer({
  storage: storageMemory,
  fileFilter: imageFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB max
  },
});

export const uploadGeneral = multer({
  storage: storageMemory,
  fileFilter: generalFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max
  },
});
