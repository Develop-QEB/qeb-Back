import { Router, Request, Response } from 'express';
import multer from 'multer';
import { authMiddleware } from '../middleware/auth.middleware';
import { isSpacesConfigured, uploadBufferToSpaces, getPublicBaseUrl } from '../config/spaces';

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

// Tama\u00f1o m\u00ednimo razonable para una imagen real (un placeholder de OneDrive
// "solo en l\u00ednea" o un archivo corrupto suele pesar < 1KB).
const MIN_IMAGE_BYTES = 1024;

/**
 * Valida que el buffer de una imagen sea realmente una imagen (firma/magic bytes)
 * y no un archivo vac\u00edo/corrupto (ej. placeholder de OneDrive Files On-Demand).
 * Devuelve un mensaje de error si es inv\u00e1lido, o null si est\u00e1 OK.
 * Solo aplica a mimetypes image/*; otros tipos pasan sin validar firma.
 */
const validateImageBuffer = (
  buffer: Buffer,
  mimetype: string,
  originalName: string,
): string | null => {
  if (!mimetype.startsWith('image/')) return null;

  if (buffer.length < MIN_IMAGE_BYTES) {
    return `El archivo "${originalName}" parece estar vac\u00edo o incompleto (${buffer.length} bytes). ` +
      `Si est\u00e1 en OneDrive, aseg\u00farate de que est\u00e9 descargado en tu equipo ` +
      `(clic derecho \u2192 "Conservar siempre en este dispositivo") o c\u00f3pialo a una carpeta local y vuelve a subirlo.`;
  }

  const b = buffer;
  const isJpeg = b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const isPng =
    b.length > 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a;
  const isGif =
    b.length > 4 &&
    b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38; // "GIF8"
  const isWebp =
    b.length > 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // "RIFF"
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50; // "WEBP"

  if (!isJpeg && !isPng && !isGif && !isWebp) {
    return `El archivo "${originalName}" no es una imagen v\u00e1lida (contenido corrupto o no es JPG/PNG/GIF/WEBP). ` +
      `Si proviene de OneDrive, desc\u00e1rgalo localmente antes de subirlo y vuelve a intentarlo.`;
  }

  return null;
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
    'text/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Tipo de archivo no permitido. Solo se permiten: JPG, PNG, GIF, WEBP, PDF, MP4, MOV, WEBM, AVI, CSV, XLS, XLSX, DOC, DOCX'));
  }
};

const uploadArte = multer({
  storage: storageMemory,
  fileFilter,
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB max
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
// Acepta ?campanaId=123 para organizar en subcarpetas: artes/campana-123/
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

    const arteValidationError = validateImageBuffer(
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname,
    );
    if (arteValidationError) {
      res.status(400).json({ success: false, error: arteValidationError });
      return;
    }

    // Organizar por tipo de contenido según mimetype
    const isPdf = req.file.mimetype === 'application/pdf';
    const isVideo = req.file.mimetype.startsWith('video/');
    const folder = isPdf ? 'documentos' : isVideo ? 'digitales' : 'artes';

    const uploaded = await uploadBufferToSpaces(req.file.buffer, {
      folder,
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

    const testigoValidationError = validateImageBuffer(
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname,
    );
    if (testigoValidationError) {
      res.status(400).json({ success: false, error: testigoValidationError });
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

// Endpoint genérico para subir archivos (solicitudes, tickets, perfil, etc.)
// El query param ?folder= define la carpeta destino en Spaces
router.post('/general', authMiddleware, uploadArte.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, error: 'No se recibio ningun archivo' });
      return;
    }

    if (!isSpacesConfigured()) {
      res.status(500).json({ success: false, error: 'Spaces no esta configurado' });
      return;
    }

    if (!req.file.buffer) {
      res.status(400).json({ success: false, error: 'Archivo invalido: no se recibio buffer' });
      return;
    }

    const generalValidationError = validateImageBuffer(
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname,
    );
    if (generalValidationError) {
      res.status(400).json({ success: false, error: generalValidationError });
      return;
    }

    const folder = (req.query.folder as string) || 'general';

    const uploaded = await uploadBufferToSpaces(req.file.buffer, {
      folder,
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
    console.error('Error al subir archivo general:', error);
    const message = error instanceof Error ? error.message : 'Error al subir archivo';
    res.status(500).json({ success: false, error: message });
  }
});

// Proxy de imágenes desde Spaces — bypass CORS para clientes que necesitan
// fetchear el binario de un arte (p.ej. para embeberlo en un Excel).
// Solo permite URLs del bucket público configurado.
router.get('/proxy-image', authMiddleware, async (req: Request, res: Response) => {
  try {
    const url = String(req.query.url || '');
    if (!url) {
      res.status(400).json({ success: false, error: 'Falta parametro url' });
      return;
    }
    // Validacion de origen. Aceptamos:
    //  1) Cualquier host de DigitalOcean Spaces (cubre la variante CDN
    //     `*.cdn.digitaloceanspaces.com` vs la directa, y buckets dev/prod).
    //     Antes solo se aceptaba startsWith(getPublicBaseUrl()) exacto, lo que
    //     rechazaba (400) las URLs con dominio CDN o de otro bucket y hacia que
    //     el Excel mostrara "Ver arte" en vez de la imagen.
    //  2) Fallback: que empiece con la base publica configurada (por si se usa
    //     un dominio propio / CDN custom via SPACES_PUBLIC_BASE_URL).
    const allowedBase = getPublicBaseUrl();
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch { host = ''; }
    const isDoSpaces = host.endsWith('.digitaloceanspaces.com');
    const matchesBase = !!allowedBase && url.startsWith(allowedBase);
    if (!isDoSpaces && !matchesBase) {
      res.status(400).json({ success: false, error: 'URL no permitida' });
      return;
    }
    const upstream = await fetch(url);
    if (!upstream.ok) {
      res.status(upstream.status).json({ success: false, error: `Upstream ${upstream.status}` });
      return;
    }
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', contentType);
    // NO cachear: con `public, max-age=300` un CDN/proxy compartido podía servir
    // la imagen de OTRO arte (respuestas cruzadas) → en el Excel del Versionario
    // salía la foto equivocada en la celda (mismo URL correcto, imagen de otra).
    // `no-store` fuerza que cada petición traiga la imagen real de su URL.
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (error) {
    console.error('Error proxy-image:', error);
    res.status(500).json({ success: false, error: 'Error al obtener imagen' });
  }
});

// Link preview: extrae Open Graph (og:image, og:title, og:description) y favicon
// de una URL externa para mostrar una vista previa en el front (artes
// pendientes/rechazo). Llamado desde el front porque hacerlo desde el navegador
// chocaria con CORS y, ademas, queremos timeout/limites controlados.
router.get('/link-preview', authMiddleware, async (req: Request, res: Response) => {
  try {
    const url = String(req.query.url || '').trim();
    if (!url) {
      res.status(400).json({ success: false, error: 'Falta parametro url' });
      return;
    }
    // Solo http/https para evitar SSRF a esquemas raros (file://, gopher://, etc.)
    let parsed: URL;
    try { parsed = new URL(url); } catch { res.status(400).json({ success: false, error: 'URL invalida' }); return; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      res.status(400).json({ success: false, error: 'Solo se permiten URLs http(s)' });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    let html = '';
    let contentType = '';
    try {
      const upstream = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; QEBLinkPreviewBot/1.0)',
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        },
        redirect: 'follow',
      });
      contentType = upstream.headers.get('content-type') || '';
      if (!upstream.ok) {
        res.json({ success: true, data: { url, title: null, description: null, image: null, contentType, status: upstream.status } });
        return;
      }
      // Si la URL es directamente una imagen, devolverla como image y listo
      if (contentType.startsWith('image/')) {
        res.json({ success: true, data: { url, title: null, description: null, image: url, contentType } });
        return;
      }
      // Limitar bytes leidos a ~300KB para no chupar paginas enormes
      const ab = await upstream.arrayBuffer();
      const buf = Buffer.from(ab).slice(0, 300 * 1024);
      html = buf.toString('utf-8');
    } finally {
      clearTimeout(timeout);
    }

    const meta = (prop: string) => {
      // Acepta name= o property= en cualquier orden y comillas simples/dobles
      const re = new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${prop}["'][^>]*>`, 'i');
      const tag = html.match(re)?.[0];
      if (!tag) return null;
      const c = tag.match(/content\s*=\s*["']([^"']+)["']/i);
      return c?.[1] || null;
    };
    const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || null;
    const ogImage = meta('og:image') || meta('twitter:image') || null;
    const ogTitle = meta('og:title') || titleTag;
    const ogDesc = meta('og:description') || meta('description') || null;

    // Resolver imagen relativa contra la URL origen
    let image = ogImage;
    if (image && !/^https?:\/\//i.test(image)) {
      try { image = new URL(image, parsed.href).href; } catch { /* ignore */ }
    }
    // Favicon fallback
    const favicon = `${parsed.protocol}//${parsed.host}/favicon.ico`;

    res.setHeader('Cache-Control', 'public, max-age=600');
    res.json({
      success: true,
      data: {
        url,
        title: ogTitle ? String(ogTitle).trim().slice(0, 250) : null,
        description: ogDesc ? String(ogDesc).trim().slice(0, 500) : null,
        image: image || null,
        favicon,
        host: parsed.host,
      },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Error al obtener preview';
    // Timeout u otros — devolver 200 con data vacia para que el front no rompa el render.
    res.json({ success: true, data: { url: String(req.query.url || ''), title: null, description: null, image: null, error: msg } });
  }
});

// Middleware para manejar errores de multer
router.use((err: Error, _req: Request, res: Response, next: Function) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({
        success: false,
        error: 'El archivo es demasiado grande. Maximo 20MB.',
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

